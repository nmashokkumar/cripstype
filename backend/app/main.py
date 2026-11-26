"""
CrispType Production Open-Source Backend (FastAPI + Silero VAD + Parakeet / Whisper ASR + Llama 3.2)

Endpoints:
- GET  /health                       -> Reports live ASR, Silero VAD, and Layer 2 LLM status
- WS   /api/v1/meetings/transcribe   -> Streams 16 kHz Int16 PCM packets (1,024 bytes / 32 ms),
                                        runs Silero VAD -> ASR -> App-aware Layer 2 LLM
- POST /transcribe                   -> Multipart audio batch transcription & re-transcription
- POST /v1/audio/transcriptions      -> OpenAI-compatible batch transcription
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import threading
import time
from collections import defaultdict, deque
from typing import Any, Deque, Dict, List, Optional

import numpy as np
from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Request,
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
    level=os.getenv("CRISPTYPE_LOG_LEVEL") or os.getenv("FLOW_LOG_LEVEL") or "INFO",
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("crisptype.server")

MAX_UPLOAD_BYTES = 25 * 1024 * 1024  # 25 MB
MAX_WS_PCM_BYTES = 16000 * 2 * 310  # ~5 min 10s of 16 kHz Int16 mono PCM
MAX_WS_FRAME_BYTES = 256 * 1024  # 256 KB per WS frame
RATE_LIMIT_RPM = max(
    10,
    int(os.getenv("CRISPTYPE_RATE_LIMIT_RPM") or os.getenv("FLOW_RATE_LIMIT_RPM") or "60"),
)
MAX_CONCURRENT_WS_PER_IP = max(
    1,
    int(os.getenv("CRISPTYPE_MAX_WS_PER_IP") or "8"),
)

DEFAULT_SAFE_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "tauri://localhost",
    "https://tauri.localhost",
    "capacitor://localhost",
]


class SlidingWindowRateLimiter:
    """Thread-safe, memory-bounded sliding-window rate limiter."""

    def __init__(self, max_requests: int, window_sec: float = 60.0) -> None:
        self.max_requests = max(1, max_requests)
        self.window_sec = max(1.0, window_sec)
        self._lock = threading.Lock()
        self._buckets: Dict[str, Deque[float]] = defaultdict(deque)

    def check(self, key: str) -> bool:
        now = time.monotonic()
        cutoff = now - self.window_sec
        with self._lock:
            q = self._buckets[key]
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= self.max_requests:
                return False
            q.append(now)
            if len(self._buckets) > 2000:
                stale = [k for k, dq in self._buckets.items() if not dq or dq[-1] <= cutoff]
                for k in stale:
                    del self._buckets[k]
            return True


_http_rate_limiter = SlidingWindowRateLimiter(max_requests=RATE_LIMIT_RPM, window_sec=60.0)
_ws_ip_lock = threading.Lock()
_active_ws_by_ip: Dict[str, int] = defaultdict(int)


def _client_ip(request_or_ws: Request | WebSocket) -> str:
    forwarded = request_or_ws.headers.get("x-forwarded-for", "").strip()
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request_or_ws.client and request_or_ws.client.host:
        return request_or_ws.client.host
    return "unknown"


def _expected_api_key() -> str:
    return (os.getenv("CRISPTYPE_API_KEY") or os.getenv("FLOW_API_KEY") or "").strip()


def _verify_api_key_token(candidate: Optional[str]) -> bool:
    expected = _expected_api_key()
    if not expected:
        return True
    if not candidate:
        return False
    return hmac.compare_digest(candidate.strip().encode("utf-8"), expected.encode("utf-8"))


def _resolve_cors_origins() -> List[str]:
    raw = (
        os.getenv("CRISPTYPE_CORS_ORIGINS")
        or os.getenv("FLOW_CORS_ORIGINS")
        or ""
    ).strip()
    if not raw:
        return list(DEFAULT_SAFE_CORS_ORIGINS)
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    # Never allow wildcard "*" when API key authentication is enabled
    if "*" in origins and _expected_api_key():
        logger.warning(
            "Wildcard CORS '*' is disabled while API key auth is active; using explicit desktop/local origins."
        )
        explicit = [o for o in origins if o != "*"]
        return explicit or list(DEFAULT_SAFE_CORS_ORIGINS)
    return origins or list(DEFAULT_SAFE_CORS_ORIGINS)


def require_rate_limit(request: Request) -> None:
    if not _http_rate_limiter.check(_client_ip(request)):
        raise HTTPException(
            status_code=429,
            detail="Too many requests. Please slow down and try again shortly.",
        )


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
    title="CrispType Dictation Server",
    version="1.0.0",
    description=(
        "Privacy-first, zero-retention voice dictation backend with Silero VAD, "
        "NVIDIA Parakeet / Faster-Whisper ASR, and app-aware Llama 3.2 Layer 2 polishing."
    ),
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_resolve_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "X-API-Key", "Content-Type", "Accept"],
)


@app.get("/", dependencies=[Depends(require_rate_limit), Depends(require_http_auth)])
@app.get("/health", dependencies=[Depends(require_rate_limit), Depends(require_http_auth)])
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
    ip = _client_ip(websocket)
    with _ws_ip_lock:
        if _active_ws_by_ip[ip] >= MAX_CONCURRENT_WS_PER_IP:
            await websocket.close(code=4429, reason="Too many concurrent connections")
            return
        _active_ws_by_ip[ip] += 1

    # Support auth via headers/query at upgrade OR via JSON `start.api_key` frame
    # so browser WebSocket clients never expose API keys in URL query logs.
    expected_key = _expected_api_key()
    auth_header = websocket.headers.get("authorization", "")
    header_token = (
        websocket.headers.get("x-api-key")
        or (auth_header[7:].strip() if auth_header.lower().startswith("bearer ") else auth_header)
        or websocket.query_params.get("api_key")
    )
    if expected_key and header_token and not _verify_api_key_token(header_token):
        with _ws_ip_lock:
            _active_ws_by_ip[ip] = max(0, _active_ws_by_ip[ip] - 1)
        await websocket.close(code=4401, reason="Unauthorized API key")
        return

    is_authenticated = (not expected_key) or bool(header_token and _verify_api_key_token(header_token))

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
                if not is_authenticated:
                    await websocket.close(code=4401, reason="Unauthorized")
                    break
                chunk: bytes = message["bytes"]
                if len(chunk) > MAX_WS_FRAME_BYTES:
                    await websocket.send_json({"status": "error", "error": "Audio frame too large."})
                    await websocket.close(code=1009, reason="Frame too large")
                    break
                packets_received += 1
                if buffered_bytes + len(chunk) <= MAX_WS_PCM_BYTES:
                    pcm_chunks.append(chunk)
                    buffered_bytes += len(chunk)
                continue

            text_frame = message.get("text")
            if not text_frame:
                continue
            if len(text_frame.encode("utf-8")) > MAX_WS_FRAME_BYTES:
                await websocket.send_json({"status": "error", "error": "Control frame too large."})
                await websocket.close(code=1009, reason="Frame too large")
                break

            try:
                payload = json.loads(text_frame)
            except json.JSONDecodeError:
                continue

            msg_type = payload.get("type")
            if msg_type == "start":
                if not is_authenticated:
                    frame_key = payload.get("api_key") if isinstance(payload.get("api_key"), str) else None
                    if not _verify_api_key_token(frame_key):
                        await websocket.send_json({"status": "error", "error": "Unauthorized API key."})
                        await websocket.close(code=4401, reason="Unauthorized API key")
                        break
                    is_authenticated = True

                if isinstance(payload.get("model"), str) and payload["model"].strip():
                    selected_model = payload["model"].strip()
                app_context = str(payload.get("app_context") or "Desktop").strip()[:120]
                app_category = payload.get("app_category")
                explicit_preset = payload.get("preset")
                if isinstance(payload.get("style_map"), dict):
                    style_map = payload["style_map"]
                if isinstance(payload.get("cleanup"), dict):
                    cleanup_cfg = payload["cleanup"]
                if isinstance(payload.get("dictionary"), list):
                    dictionary = payload["dictionary"][:500]
                if isinstance(payload.get("language"), str) and payload["language"].strip():
                    language = payload["language"].strip()[:16]
                await websocket.send_json({"status": "ready"})
                continue

            if msg_type == "stop":
                if not is_authenticated:
                    await websocket.close(code=4401, reason="Unauthorized")
                    break

                started = time.perf_counter()
                raw_pcm_bytes = b"".join(pcm_chunks)
                pcm_chunks.clear()
                if len(raw_pcm_bytes) % 2 == 1:
                    raw_pcm_bytes = raw_pcm_bytes[:-1]

                pcm16 = np.frombuffer(raw_pcm_bytes, dtype=np.int16).copy()
                del raw_pcm_bytes

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
                pcm16.fill(0)

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
        logger.debug("WebSocket client disconnected.")
    except Exception as exc:
        # Log exception class only — never leak transcripts or internal traces to clients
        logger.error("WebSocket dictation error (%s)", type(exc).__name__)
        try:
            await websocket.send_json(
                {"status": "error", "error": "Transcription failed on the server."}
            )
        except Exception:
            pass
    finally:
        pcm_chunks.clear()
        with _ws_ip_lock:
            _active_ws_by_ip[ip] = max(0, _active_ws_by_ip[ip] - 1)
            if _active_ws_by_ip[ip] == 0:
                del _active_ws_by_ip[ip]
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
    audio_bytes = await upload.read(MAX_UPLOAD_BYTES + 1)
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="Uploaded audio file is empty.")
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio file exceeds 25 MB limit.")

    dict_items = _parse_json_field(dictionary, [])
    if not isinstance(dict_items, list):
        dict_items = []
    dict_items = dict_items[:500]

    cleanup_cfg = _parse_json_field(cleanup, {})
    if not isinstance(cleanup_cfg, dict):
        cleanup_cfg = {}

    decision = classify_app_and_style(
        app_context=(app_context or "")[:120],
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
        logger.warning("Batch audio decode failed (%s)", type(exc).__name__)
        raise HTTPException(
            status_code=400, detail="Could not decode uploaded audio file."
        ) from exc
    finally:
        del audio_bytes

    try:
        raw_text, detected_lang, audio_ms = await asyncio.to_thread(
            asr_engine.transcribe_pcm16,
            pcm16,
            language[:16],
            dict_items,
            model,
        )
    finally:
        pcm16.fill(0)

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


@app.post("/transcribe", dependencies=[Depends(require_rate_limit), Depends(require_http_auth)])
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


@app.post(
    "/v1/audio/transcriptions",
    dependencies=[Depends(require_rate_limit), Depends(require_http_auth)],
)
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
