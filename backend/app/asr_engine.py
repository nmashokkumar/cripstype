"""
Audio Decoding & ASR Inference Engine.

Supports:
- `faster_whisper` (default — fast, low VRAM/CPU via CTranslate2 int8/float16)
- `seamless_m4t_v2` (Meta `facebook/seamless-m4t-v2-large` via Hugging Face Transformers)

Handles both raw 16 kHz Int16 PCM streams (WebSocket) and arbitrary container
uploads (`webm`, `wav`, `ogg`, `mp3`, `m4a`) decoded cleanly via `ffmpeg` or `soundfile`.
"""

from __future__ import annotations

import io
import logging
import os
import subprocess
import tempfile
import threading
from typing import Any, Dict, List, Mapping, Optional, Tuple

import numpy as np

from .vad_bridge import SAMPLE_RATE, VadPipeline

logger = logging.getLogger("flow.asr")

AVAILABLE_MODEL_PRESETS: List[str] = [
    "seamless-m4t-v2",
    "faster-whisper-distil-large-v3",
    "faster-whisper-large-v3-turbo",
]


def decode_audio_bytes_to_pcm16(audio_bytes: bytes, filename: str = "audio.webm") -> np.ndarray:
    """Decodes webm/wav/ogg/mp3/m4a bytes into mono 16 kHz Int16 PCM numpy array."""
    if not audio_bytes:
        return np.empty(0, dtype=np.int16)

    # Fast path for standard WAV via soundfile
    if filename.lower().endswith(".wav") or audio_bytes[:4] == b"RIFF":
        try:
            import soundfile as sf  # type: ignore

            data, sr = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)
            if data.ndim > 1:
                data = np.mean(data, axis=1)
            if sr != SAMPLE_RATE and data.size > 0:
                ratio = SAMPLE_RATE / float(sr)
                target_len = max(1, int(round(data.size * ratio)))
                x_old = np.linspace(0.0, 1.0, num=data.size, endpoint=False)
                x_new = np.linspace(0.0, 1.0, num=target_len, endpoint=False)
                data = np.interp(x_new, x_old, data).astype(np.float32)
            clipped = np.clip(data, -1.0, 1.0)
            return (clipped * 32767.0).astype(np.int16)
        except Exception:
            pass

    # Universal container decode via ffmpeg -> 16 kHz mono s16le PCM
    suffix = os.path.splitext(filename)[1] or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        proc = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                tmp.name,
                "-ac",
                "1",
                "-ar",
                str(SAMPLE_RATE),
                "-f",
                "s16le",
                "pipe:1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if proc.returncode != 0:
            err_msg = proc.stderr.decode("utf-8", errors="ignore").strip()
            raise RuntimeError(f"ffmpeg failed to decode audio ({suffix}): {err_msg or 'unknown error'}")
        return np.frombuffer(proc.stdout, dtype=np.int16).copy()


def _build_initial_prompt(dictionary: Optional[List[Mapping[str, Any]]]) -> str:
    if not dictionary:
        return ""
    terms: List[str] = []
    seen = set()
    for item in dictionary[:60]:
        for key in ("replacement", "trigger"):
            val = str(item.get(key, "")).strip()
            if val and val.lower() not in seen:
                seen.add(val.lower())
                terms.append(val)
    return ", ".join(terms)[:850]


class AsrEngine:
    """Lazy-loading, multi-model ASR engine with native C++ Silero VAD pre-filtering."""

    def __init__(self, vad: VadPipeline) -> None:
        self.vad = vad
        self.engine_type = os.getenv("FLOW_ASR_ENGINE", "faster_whisper").strip().lower()
        self.model_name = os.getenv(
            "FLOW_ASR_MODEL",
            "facebook/seamless-m4t-v2-large"
            if self.engine_type == "seamless_m4t_v2"
            else "distil-large-v3",
        ).strip()
        self.device = os.getenv("FLOW_ASR_DEVICE", "auto").strip().lower()
        self.compute_type = os.getenv("FLOW_ASR_COMPUTE_TYPE", "int8").strip()
        self._cache_lock = threading.Lock()
        self._model_cache: Dict[Tuple[str, str], Tuple[Any, Any, str]] = {}

    @property
    def label(self) -> str:
        return f"{self.engine_type} ({self.model_name})"

    def resolve_target(self, model_override: Optional[str] = None) -> Tuple[str, str]:
        choice = (model_override or "").strip()
        if not choice or choice.lower() == "auto":
            return self.engine_type, self.model_name

        norm = choice.lower()
        if norm in ("seamless-m4t-v2", "seamless_m4t_v2") or "seamless" in norm:
            target_name = (
                choice
                if "/" in choice
                else os.getenv("FLOW_SEAMLESS_MODEL", "facebook/seamless-m4t-v2-large")
            )
            return "seamless_m4t_v2", target_name

        if norm == "faster-whisper-distil-large-v3":
            return "faster_whisper", "distil-large-v3"
        if norm == "faster-whisper-large-v3-turbo":
            return "faster_whisper", "large-v3-turbo"
        if norm.startswith("faster-whisper-"):
            return "faster_whisper", choice[len("faster-whisper-") :]

        return self.engine_type, choice

    def _get_or_load_model(self, engine_type: str, model_name: str) -> Tuple[Any, Any, str]:
        key = (engine_type, model_name)
        with self._cache_lock:
            if key in self._model_cache:
                return self._model_cache[key]

            if engine_type == "seamless_m4t_v2":
                import torch  # type: ignore
                from transformers import AutoProcessor, SeamlessM4Tv2Model  # type: ignore

                device = (
                    "cuda"
                    if (self.device == "cuda" or (self.device == "auto" and torch.cuda.is_available()))
                    else "cpu"
                )
                logger.info("Loading SeamlessM4T v2 (%s) on %s…", model_name, device)
                processor = AutoProcessor.from_pretrained(model_name)
                model = SeamlessM4Tv2Model.from_pretrained(model_name).to(device)
                model.eval()
                self._model_cache[key] = (model, processor, device)
                return self._model_cache[key]

            from faster_whisper import WhisperModel  # type: ignore

            device = self.device
            if device == "auto":
                try:
                    import torch  # type: ignore

                    device = "cuda" if torch.cuda.is_available() else "cpu"
                except Exception:
                    device = "cpu"

            compute = self.compute_type
            if device == "cuda" and compute == "int8":
                compute = "float16"

            logger.info("Loading Faster-Whisper (%s) on %s (%s)…", model_name, device, compute)
            model = WhisperModel(model_name, device=device, compute_type=compute)
            self._model_cache[key] = (model, None, device)
            return self._model_cache[key]

    def transcribe_pcm16(
        self,
        pcm16: np.ndarray,
        language: str = "en",
        dictionary: Optional[List[Mapping[str, Any]]] = None,
        model_override: Optional[str] = None,
    ) -> Tuple[str, str, int]:
        """
        Runs C++ Silero VAD followed by ASR inference on 16 kHz mono Int16 PCM.
        Returns `(raw_text, detected_language, duration_ms)`.
        """
        if pcm16.size == 0:
            return "", language, 0

        total_duration_ms = int(round((pcm16.size / float(SAMPLE_RATE)) * 1000.0))

        # 1. Strip silence with native C++ Silero VAD so ASR never hallucinates on quiet tails
        filtered_pcm, has_speech = self.vad.extract_speech(pcm16)
        if not has_speech or filtered_pcm.size < int(SAMPLE_RATE * 0.15):
            return "", language, total_duration_ms

        engine_type, model_name = self.resolve_target(model_override)
        model, processor, device = self._get_or_load_model(engine_type, model_name)
        audio_f32 = filtered_pcm.astype(np.float32) / 32768.0

        if engine_type == "seamless_m4t_v2":
            import torch  # type: ignore

            tgt_lang = "eng" if language.lower().startswith("en") else language.lower()[:3]
            inputs = processor(
                audios=audio_f32, sampling_rate=SAMPLE_RATE, return_tensors="pt"
            ).to(device)
            with torch.inference_mode():
                output_tokens = model.generate(
                    **inputs, tgt_lang=tgt_lang, generate_speech=False
                )
            text = processor.decode(
                output_tokens[0].tolist()[0], skip_special_tokens=True
            ).strip()
            return text, language, total_duration_ms

        # Faster-Whisper inference
        initial_prompt = _build_initial_prompt(dictionary) or None
        lang_arg = None if language in ("", "auto") else language.split("-")[0]
        segments, info = model.transcribe(
            audio_f32,
            language=lang_arg,
            beam_size=2,
            vad_filter=False,  # Already filtered by native C++ Silero VAD
            initial_prompt=initial_prompt,
            condition_on_previous_text=False,
        )
        text = " ".join(seg.text.strip() for seg in segments if seg.text.strip()).strip()
        detected_lang = getattr(info, "language", None) or language
        return text, detected_lang, total_duration_ms
