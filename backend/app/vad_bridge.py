"""
Silero VAD Bridge — prefers native C++17 `libsilero_vad` (ONNX Runtime C++),
falling back cleanly to Python ONNX Runtime Silero VAD or RMS energy gating.
"""

from __future__ import annotations

import ctypes
import logging
import os
import platform
from pathlib import Path
from typing import Tuple

import numpy as np

logger = logging.getLogger("flow.vad")

SAMPLE_RATE = 16000
FRAME_SAMPLES = 512
CONTEXT_SAMPLES = 64


def _default_lib_name() -> str:
    sys_name = platform.system().lower()
    if sys_name == "darwin":
        return "libsilero_vad.dylib"
    if sys_name == "windows":
        return "silero_vad.dll"
    return "libsilero_vad.so"


class NativeSileroVad:
    """Thin ctypes wrapper around the compiled C++17 `libsilero_vad` library."""

    def __init__(self, lib_path: Path, model_path: Path) -> None:
        self._lib = ctypes.CDLL(str(lib_path))
        self._lib.silero_vad_create.argtypes = [ctypes.c_char_p, ctypes.c_int]
        self._lib.silero_vad_create.restype = ctypes.c_void_p

        self._lib.silero_vad_reset.argtypes = [ctypes.c_void_p]
        self._lib.silero_vad_reset.restype = None

        self._lib.silero_vad_filter_pcm.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int16),
            ctypes.c_size_t,
            ctypes.c_float,
            ctypes.c_int,
            ctypes.POINTER(ctypes.c_int16),
            ctypes.POINTER(ctypes.c_size_t),
        ]
        self._lib.silero_vad_filter_pcm.restype = ctypes.c_int

        self._lib.silero_vad_destroy.argtypes = [ctypes.c_void_p]
        self._lib.silero_vad_destroy.restype = None

        self._handle = self._lib.silero_vad_create(str(model_path).encode("utf-8"), SAMPLE_RATE)
        if not self._handle:
            raise RuntimeError(f"Failed to initialize C++ Silero VAD from {model_path}")

    def filter_pcm(
        self, pcm16: np.ndarray, threshold: float = 0.45, pad_ms: int = 240
    ) -> Tuple[np.ndarray, bool]:
        if pcm16.size < FRAME_SAMPLES:
            return pcm16, False
        contiguous = np.ascontiguousarray(pcm16, dtype=np.int16)
        out_buf = np.empty_like(contiguous)
        out_samples = ctypes.c_size_t(0)

        status = self._lib.silero_vad_filter_pcm(
            self._handle,
            contiguous.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)),
            contiguous.size,
            ctypes.c_float(threshold),
            ctypes.c_int(pad_ms),
            out_buf.ctypes.data_as(ctypes.POINTER(ctypes.c_int16)),
            ctypes.byref(out_samples),
        )
        if status == 1 and out_samples.value > 0:
            return out_buf[: out_samples.value].copy(), True
        if status == 0:
            return np.empty(0, dtype=np.int16), False
        raise RuntimeError("C++ Silero VAD returned an error status during filtering")

    def close(self) -> None:
        if getattr(self, "_handle", None):
            self._lib.silero_vad_destroy(self._handle)
            self._handle = None

    def __del__(self) -> None:
        self.close()


class PythonOnnxSileroVad:
    """Fallback Silero VAD v5 using Python onnxruntime when C++ shared library is not built."""

    def __init__(self, model_path: Path) -> None:
        import onnxruntime as ort  # type: ignore

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 1
        opts.inter_op_num_threads = 1
        self._session = ort.InferenceSession(
            str(model_path), sess_options=opts, providers=["CPUExecutionProvider"]
        )

    def filter_pcm(
        self, pcm16: np.ndarray, threshold: float = 0.45, pad_ms: int = 240
    ) -> Tuple[np.ndarray, bool]:
        total_frames = pcm16.size // FRAME_SAMPLES
        if total_frames == 0:
            return np.empty(0, dtype=np.int16), False

        state = np.zeros((2, 1, 128), dtype=np.float32)
        context = np.zeros(CONTEXT_SAMPLES, dtype=np.float32)
        sr = np.array([SAMPLE_RATE], dtype=np.int64)

        is_speech = np.zeros(total_frames, dtype=bool)
        for f in range(total_frames):
            chunk = pcm16[f * FRAME_SAMPLES : (f + 1) * FRAME_SAMPLES].astype(np.float32) / 32768.0
            inp = np.concatenate([context, chunk])[None, :]
            context = chunk[-CONTEXT_SAMPLES:]
            out, state = self._session.run(None, {"input": inp, "state": state, "sr": sr})
            if float(out[0][0]) >= threshold:
                is_speech[f] = True

        if not np.any(is_speech):
            return np.empty(0, dtype=np.int16), False

        pad_frames = max(1, int((pad_ms * SAMPLE_RATE) / (1000 * FRAME_SAMPLES)))
        keep = np.zeros(total_frames, dtype=bool)
        for idx in np.flatnonzero(is_speech):
            keep[max(0, idx - pad_frames) : min(total_frames, idx + pad_frames + 1)] = True

        kept_chunks = [
            pcm16[f * FRAME_SAMPLES : (f + 1) * FRAME_SAMPLES]
            for f in range(total_frames)
            if keep[f]
        ]
        return np.concatenate(kept_chunks), True


class EnergyVadFallback:
    """Zero-dependency RMS energy VAD fallback if neither C++ nor ONNX model is present."""

    def filter_pcm(
        self, pcm16: np.ndarray, threshold: float = 0.012, pad_ms: int = 240
    ) -> Tuple[np.ndarray, bool]:
        total_frames = pcm16.size // FRAME_SAMPLES
        if total_frames == 0:
            return np.empty(0, dtype=np.int16), False

        rms_threshold = min(0.05, max(0.006, threshold * 0.025))
        is_speech = np.zeros(total_frames, dtype=bool)
        for f in range(total_frames):
            frame = pcm16[f * FRAME_SAMPLES : (f + 1) * FRAME_SAMPLES].astype(np.float32) / 32768.0
            if float(np.sqrt(np.mean(frame * frame))) >= rms_threshold:
                is_speech[f] = True

        if not np.any(is_speech):
            return np.empty(0, dtype=np.int16), False

        pad_frames = max(1, int((pad_ms * SAMPLE_RATE) / (1000 * FRAME_SAMPLES)))
        keep = np.zeros(total_frames, dtype=bool)
        for idx in np.flatnonzero(is_speech):
            keep[max(0, idx - pad_frames) : min(total_frames, idx + pad_frames + 1)] = True

        kept_chunks = [
            pcm16[f * FRAME_SAMPLES : (f + 1) * FRAME_SAMPLES]
            for f in range(total_frames)
            if keep[f]
        ]
        return np.concatenate(kept_chunks), True


class VadPipeline:
    """Auto-selects the fastest available VAD implementation (C++ Silero -> Python ONNX -> RMS)."""

    def __init__(self) -> None:
        backend_root = Path(__file__).resolve().parent.parent
        model_path = Path(
            os.getenv("SILERO_VAD_MODEL_PATH", str(backend_root / "models" / "silero_vad.onnx"))
        )
        lib_path = Path(
            os.getenv(
                "SILERO_VAD_LIB_PATH",
                str(backend_root / "native" / "build" / _default_lib_name()),
            )
        )

        self.engine_name = "energy-fallback"
        self._impl: NativeSileroVad | PythonOnnxSileroVad | EnergyVadFallback = EnergyVadFallback()

        if lib_path.exists() and model_path.exists():
            try:
                self._impl = NativeSileroVad(lib_path, model_path)
                self.engine_name = "silero-vad-cpp"
                logger.info("Loaded native C++17 Silero VAD from %s", lib_path)
                return
            except Exception as exc:
                logger.warning("Native C++ Silero VAD failed to load (%s); trying Python ONNX.", exc)

        if model_path.exists():
            try:
                self._impl = PythonOnnxSileroVad(model_path)
                self.engine_name = "silero-vad-onnx-py"
                logger.info("Loaded Python ONNX Silero VAD from %s", model_path)
                return
            except Exception as exc:
                logger.warning("Python ONNX Silero VAD unavailable (%s); using RMS fallback.", exc)

        logger.info("Using lightweight RMS energy VAD fallback (run install.sh for C++ Silero VAD).")

    def extract_speech(self, pcm16: np.ndarray, threshold: float = 0.45) -> Tuple[np.ndarray, bool]:
        return self._impl.filter_pcm(pcm16, threshold=threshold)
