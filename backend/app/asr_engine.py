"""
Audio Decoding & Multi-Engine ASR Inference Engine for CrispType.

Supports:
- `parakeet` (NVIDIA Parakeet TDT via `onnx_asr` or NeMo — ultra-fast, high-accuracy STT)
- `faster_whisper` (default zero-GPU-required CTranslate2 int8/float16 Whisper)
- `seamless_m4t_v2` (Meta `facebook/seamless-m4t-v2-large` via Hugging Face Transformers)

Zero-retention guarantee:
- WebSocket 16 kHz Int16 PCM streams are processed completely in memory.
- Container uploads (`webm`, `wav`, `ogg`, `mp3`, `m4a`, `flac`) are decoded via
  in-memory `soundfile` or an ephemeral temporary file guaranteed to be deleted
  inside a `finally` block.
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

logger = logging.getLogger("crisptype.asr")

AVAILABLE_MODEL_PRESETS: List[str] = [
    "parakeet-tdt-0.6b-v2",
    "faster-whisper-distil-large-v3",
    "faster-whisper-large-v3-turbo",
    "seamless-m4t-v2",
]

ALLOWED_AUDIO_EXTENSIONS = frozenset({
    ".webm",
    ".wav",
    ".ogg",
    ".mp3",
    ".m4a",
    ".flac",
    ".aac",
    ".mp4",
})

FFMPEG_DECODE_TIMEOUT_SEC = 30


def _sanitize_audio_suffix(filename: str) -> str:
    ext = os.path.splitext(filename or "")[1].lower()
    return ext if ext in ALLOWED_AUDIO_EXTENSIONS else ".webm"


def decode_audio_bytes_to_pcm16(audio_bytes: bytes, filename: str = "audio.webm") -> np.ndarray:
    """Decodes container audio bytes into a mono 16 kHz Int16 PCM numpy array with zero disk retention."""
    if not audio_bytes:
        return np.empty(0, dtype=np.int16)

    # Fast in-memory path for standard WAV via soundfile
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
    # Strict extension allowlist + explicit finally deletion ensures zero retention on disk.
    suffix = _sanitize_audio_suffix(filename)
    tmp_path: Optional[str] = None
    try:
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp_path = tmp.name
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
                tmp_path,
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
            timeout=FFMPEG_DECODE_TIMEOUT_SEC,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError("Audio container decoding failed.")
        return np.frombuffer(proc.stdout, dtype=np.int16).copy()
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Audio decoding timed out.") from exc
    finally:
        if tmp_path and os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


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
        self.engine_type = (
            os.getenv("CRISPTYPE_ASR_ENGINE")
            or os.getenv("FLOW_ASR_ENGINE")
            or "faster_whisper"
        ).strip().lower()

        default_model = "distil-large-v3"
        if self.engine_type == "parakeet":
            default_model = "nemo-parakeet-tdt-0.6b-v2"
        elif self.engine_type == "seamless_m4t_v2":
            default_model = "facebook/seamless-m4t-v2-large"

        self.model_name = (
            os.getenv("CRISPTYPE_ASR_MODEL")
            or os.getenv("FLOW_ASR_MODEL")
            or default_model
        ).strip()
        self.device = (
            os.getenv("CRISPTYPE_ASR_DEVICE")
            or os.getenv("FLOW_ASR_DEVICE")
            or "auto"
        ).strip().lower()
        self.compute_type = (
            os.getenv("CRISPTYPE_ASR_COMPUTE_TYPE")
            or os.getenv("FLOW_ASR_COMPUTE_TYPE")
            or "int8"
        ).strip()
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
        if "parakeet" in norm:
            target = choice if ("/" in choice or norm.startswith("nemo-")) else "nemo-parakeet-tdt-0.6b-v2"
            return "parakeet", target

        if norm in ("seamless-m4t-v2", "seamless_m4t_v2") or "seamless" in norm:
            target_name = (
                choice
                if "/" in choice
                else os.getenv("CRISPTYPE_SEAMLESS_MODEL")
                or os.getenv("FLOW_SEAMLESS_MODEL")
                or "facebook/seamless-m4t-v2-large"
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

            if engine_type == "parakeet":
                # Prefer lightweight onnx-asr (CPU/GPU ONNX Runtime); fall back to NVIDIA NeMo if installed
                try:
                    import onnx_asr  # type: ignore

                    logger.info("Loading NVIDIA Parakeet via onnx-asr (%s)…", model_name)
                    model = onnx_asr.load_model(model_name)
                    self._model_cache[key] = (model, "onnx_asr", self.device)
                    return self._model_cache[key]
                except ImportError:
                    import nemo.collections.asr as nemo_asr  # type: ignore

                    nemo_id = (
                        model_name
                        if "/" in model_name
                        else f"nvidia/{model_name.removeprefix('nemo-')}"
                    )
                    logger.info("Loading NVIDIA Parakeet via NeMo (%s)…", nemo_id)
                    model = nemo_asr.models.ASRModel.from_pretrained(model_name=nemo_id)
                    model.eval()
                    self._model_cache[key] = (model, "nemo", self.device)
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

        if engine_type == "parakeet":
            if processor == "onnx_asr":
                raw = model.recognize(audio_f32, sample_rate=SAMPLE_RATE)
                text = (raw if isinstance(raw, str) else " ".join(raw)).strip()
                return text, language, total_duration_ms

            # NeMo path — uses an ephemeral wav deleted immediately in finally
            import soundfile as sf  # type: ignore

            tmp_wav: Optional[str] = None
            try:
                with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
                    tmp_wav = tmp.name
                sf.write(tmp_wav, audio_f32, SAMPLE_RATE)
                hyps = model.transcribe([tmp_wav])
                first = hyps[0] if hyps else ""
                text = (getattr(first, "text", first) or "").strip()
                return text, language, total_duration_ms
            finally:
                if tmp_wav and os.path.exists(tmp_wav):
                    try:
                        os.remove(tmp_wav)
                    except OSError:
                        pass

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
