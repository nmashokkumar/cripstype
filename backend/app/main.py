"""
Flow Production Open-Source Backend (FastAPI + Native C++17 Silero VAD + ASR + Layer 2 LLM)

Endpoints:
- GET  /health                       -> Reports live ASR, C++ VAD, and Layer 2 LLM status
- WS   /api/v1/meetings/transcribe   -> Streams 16 kHz Int16 PCM packets (1,024 bytes / 32 ms),
                                        runs C++ Silero VAD -> ASR -> App-aware Layer 2 LLM
- POST /transcribe                   -> Multipart audio batch transcription & re-transcription
- POST /v1/audio/transcriptions      -> OpenAI / OpenWhispr compatible batch transcription
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import time
from typing import Any, Dict, List, Optional

import numpy as np
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse

from .app_classifier import classify_app_and_style
from .asr_engine import AVAILABLE_MODEL_PRESETS, AsrEngine, decode_audio_bytes_to_pcm16
from .llm_refiner import Layer2Refiner
from .vad_bridge import VadPipeline

logging.basicConfig(
    level=os.getenv("FLOW_LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("flow.server")

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB
MAX_WS_PCM_BYTES = 16000 * 2 * 310  # ~5 min 10s of 16 kHz Int16 mono PCM


def _expected_api_key() -> str:
    return os.getenv("FLOW_API_KEY", "").strip()


def _verify_api_key_token(candidate: Optional[str]) -> bool:
    expected = _expected_api_key()
    if not expected:
        return True
    if not candidate:
        return False
    return hmac.compare_digest(candidate.strip().encode("utf-8"), expected.encode("utf-8"))


def require_http_auth(
    x_api_key: Optional[str] = Header(default=None),
    authorization: Optional[str] = Header(default=None),
) -> None:
    if not _expected_api_key():
        return
    token = x_api_key
    if not token and authorization:
        token = authorization[7:].strip() if authorization.lower().startswith("bearer ") else authorization
    if not _verify_api_key_token(token):
        raise HTTPException(
            status_code=401,
            detail="Unauthorized: provide a valid X-API-Key or Authorization: Bearer token.",
        )


def _parse_json_field(raw: Optional[str], fallback: Any) -> Any:
    if not raw or not raw.strip():
        return fallback
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return fallback


def _word_count(text: str) -> int:
    return len([w for w in text.strip().split() if w])


vad_pipeline = VadPipeline()
asr_engine = AsrEngine(vad=vad_pipeline)
llm_refiner = Layer2Refiner()

app = FastAPI(
    title="Flow Dictation Server",
    version="1.0.0",
    description="Open-source cross-device voice dictation backend with native C++ Silero VAD, SeamlessM4T v2 / Faster-Whisper ASR, and app-aware Layer 2 LLM polishing.",
)

cors_origins_env = os.getenv("FLOW_CORS_ORIGINS", "*").strip()
allowed_origins = ["*"] if cors_origins_env == "*" else [o.strip() for o in cors_origins_env.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "X-API-Key", "Content-Type", "Accept"],
)


@app.get("/", dependencies=[Depends(require_http_auth)])
@app.get("/health", dependencies=[Depends(require_http_auth)])
async def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "status": "ok",
        "asr_engine": asr_engine.label,
        "available_models": AVAILABLE_MODEL_PRESETS,
        "vad_engine": vad_pipeline.engine_name,
        "llm_provider": llm_refiner.provider_label,
        "auth_required": bool(_expected_api_key()),
    }


@app.websocket("/api/v1/meetings/transcribe")
async def ws_stream_transcribe(websocket: WebSocket) -> None:
    if _expected_api_key():
        token = (
            websocket.query_params.get("api_key")
            or websocket.headers.get("x-api-key")
            or (
                websocket.headers.get("authorization", "")[7:].strip()
                if websocket.headers.get("authorization", "").lower().startswith("bearer ")
                else websocket.headers.get("authorization")
            )
        )
        if not _verify_api_key_token(token):
            await websocket.close(code=4401, reason="Unauthorized API key")
            return

    await websocket.accept()

    pcm_chunks: List[bytes] = []
    packets_received = 0
    buffered_bytes = 0
    selected_model: Optional[str] = None
    app_context = "Desktop"
    app_category: Optional[str] = None
    explicit_preset: Optional[str] = None
    style_map: Dict[str, str] = {}
    cleanup_cfg: Dict[str, Any] = {}
    dictionary: List[Dict[str, Any]] = []
    language = "en"

    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break

            if message.get("bytes"):
                chunk: bytes = message["bytes"]
                packets_received += 1
                if buffered_bytes + len(chunk) <= MAX_WS_PCM_BYTES:
                    pcm_chunks.append(chunk)
                    buffered_bytes += len(chunk)
                continue

            text_frame = message.get("text")
            if not text_frame:
                continue

            try:
                payload = json.loads(text_frame)
            except json.JSONDecodeError:
                continue

            msg_type = payload.get("type")
            if msg_type == "start":
                if isinstance(payload.get("model"), str) and payload["model"].strip():
                    selected_model = payload["model"].strip()
                app_context = str(payload.get("app_context") or "Desktop").strip()
                app_category = payload.get("app_category")
                explicit_preset = payload.get("preset")
                if isinstance(payload.get("style_map"), dict):
                    style_map = payload["style_map"]
                if isinstance(payload.get("cleanup"), dict):
                    cleanup_cfg = payload["cleanup"]
                if isinstance(payload.get("dictionary"), list):
                    dictionary = payload["dictionary"]
                if isinstance(payload.get("language"), str) and payload["language"].strip():
                    language = payload["language"].strip()
                await websocket.send_json({"status": "ready"})
                continue

            if msg_type == "stop":
                started = time.perf_counter()
                raw_pcm_bytes = b"".join(pcm_chunks)
                # Ensure even byte count for Int16 PCM
                if len(raw_pcm_bytes) % 2 == 1:
                    raw_pcm_bytes = raw_pcm_bytes[:-1]

                pcm16 = np.frombuffer(raw_pcm_bytes, dtype=np.int16).copy()
                decision = classify_app_and_style(
                    app_context=app_context,
                    explicit_category=app_category,
                    explicit_style=explicit_preset,
                    style_map=style_map,
                )

                raw_text, detected_lang, audio_ms = await asyncio.to_thread(
                    asr_engine.transcribe_pcm16,
                    pcm16,
                    language,
                    dictionary,
                    selected_model,
                )

                if raw_text:
                    formatted_text = await llm_refiner.refine(
                        raw_text=raw_text,
                        decision=decision,
                        cleanup=cleanup_cfg,
                        dictionary=dictionary,
                        language=detected_lang,
                    )
                else:
                    formatted_text = ""

                elapsed_ms = max(audio_ms, int(round((time.perf_counter() - started) * 1000.0)))
                await websocket.send_json(
                    {
                        "status": "completed",
                        "is_final": True,
                        "text": formatted_text,
                        "formatted_text": formatted_text,
                        "raw_text": raw_text,
                        "num_words": _word_count(formatted_text),
                        "language": detected_lang,
                        "duration_ms": elapsed_ms,
                        "app_context": decision.app_name,
                        "category": decision.category,
                        "style_applied": decision.style,
                        "packets_received": packets_received,
                        "pcm_bytes_received": buffered_bytes,
                    }
                )
                break
    except WebSocketDisconnect:
        logger.debug("WebSocket client disconnected cleanly.")
    except Exception as exc:
        logger.exception("WebSocket dictation error: %s", exc)
        try:
            await websocket.send_json({"status": "error", "error": str(exc)})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


async def _run_batch_transcription(
    upload: UploadFile,
    model: Optional[str],
    style: Optional[str],
    context: Optional[str],
    app_context: Optional[str],
    cleanup: Optional[str],
    dictionary: Optional[str],
    language: str,
) -> Dict[str, Any]:
    started = time.perf_counter()
    audio_bytes = await upload.read()
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio file exceeds 25 MB limit.")

    dict_items = _parse_json_field(dictionary, [])
    if not isinstance(dict_items, list):
        dict_items = []
    cleanup_cfg = _parse_json_field(cleanup, {})
    if not isinstance(cleanup_cfg, dict):
        cleanup_cfg = {}

    decision = classify_app_and_style(
        app_context=app_context,
        explicit_category=context,
        explicit_style=style,
    )

    try:
        pcm16 = await asyncio.to_thread(
            decode_audio_bytes_to_pcm16,
            audio_bytes,
            upload.filename or "dictation.webm",
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    raw_text, detected_lang, audio_ms = await asyncio.to_thread(
        asr_engine.transcribe_pcm16,
        pcm16,
        language,
        dict_items,
        model,
    )

    formatted_text = (
        await llm_refiner.refine(
            raw_text=raw_text,
            decision=decision,
            cleanup=cleanup_cfg,
            dictionary=dict_items,
            language=detected_lang,
        )
        if raw_text
        else ""
    )

    elapsed_ms = max(audio_ms, int(round((time.perf_counter() - started) * 1000.0)))
    return {
        "status": "completed",
        "text": formatted_text,
        "formatted_text": formatted_text,
        "raw_text": raw_text,
        "num_words": _word_count(formatted_text),
        "language": detected_lang,
        "duration_ms": elapsed_ms,
        "app_context": decision.app_name,
        "category": decision.category,
        "style_applied": decision.style,
    }


@app.post("/transcribe", dependencies=[Depends(require_http_auth)])
async def transcribe_endpoint(
    audio: Optional[UploadFile] = File(default=None),
    file: Optional[UploadFile] = File(default=None),
    model: Optional[str] = Form(default=None),
    style: Optional[str] = Form(default=None),
    context: Optional[str] = Form(default=None),
    app_context: Optional[str] = Form(default=None),
    cleanup: Optional[str] = Form(default=None),
    dictionary: Optional[str] = Form(default=None),
    language: str = Form(default="en"),
) -> Dict[str, Any]:
    upload = audio or file
    if upload is None:
        raise HTTPException(status_code=400, detail="Missing 'audio' (or 'file') multipart upload.")
    return await _run_batch_transcription(
        upload=upload,
        model=model,
        style=style,
        context=context,
        app_context=app_context,
        cleanup=cleanup,
        dictionary=dictionary,
        language=language,
    )


@app.post("/v1/audio/transcriptions", dependencies=[Depends(require_http_auth)])
async def openai_compatible_transcribe(
    file: UploadFile = File(...),
    model: Optional[str] = Form(default=None),
    language: str = Form(default="en"),
    response_format: str = Form(default="json"),
    style: Optional[str] = Form(default=None),
    context: Optional[str] = Form(default=None),
    app_context: Optional[str] = Form(default=None),
    cleanup: Optional[str] = Form(default=None),
    dictionary: Optional[str] = Form(default=None),
) -> Any:
    result = await _run_batch_transcription(
        upload=file,
        model=model,
        style=style,
        context=context,
        app_context=app_context,
        cleanup=cleanup,
        dictionary=dictionary,
        language=language,
    )
    if response_format == "text":
        return PlainTextResponse(result["text"])
    return result
