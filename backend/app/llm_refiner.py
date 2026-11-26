"""
Layer 2 LLM Refiner — App-aware, Style-aware, Dictionary-aware text polishing.

Connects to any OpenAI-compatible chat completions endpoint (Ollama, vLLM,
Groq, OpenAI, OpenRouter, llama.cpp server) with an anti-duplication guard and
a deterministic regex + dictionary fallback so dictation always succeeds cleanly.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, List, Mapping, Optional

import httpx

from .app_classifier import (
    AppStyleDecision,
    build_layer2_system_prompt,
    strip_transcript_delimiters,
    wrap_untrusted_transcript,
)

logger = logging.getLogger("crisptype.llm")

FILLER_REGEX = re.compile(
    r"\b(?:um+|uh+|er+|ah+|hmm+|you know|i mean|sort of|kind of|basically)\b,?\s*",
    re.IGNORECASE,
)
STUTTER_REGEX = re.compile(r"\b(\w+)\s+\1\b", re.IGNORECASE)
CORRECTION_REGEX = re.compile(
    r"\b(\w+)\s*,?\s+(?:actually\s+no|i\s+mean|sorry|wait\s+no|no\s+wait)\s*,?\s+",
    re.IGNORECASE,
)


def _normalize_words(text: str) -> List[str]:
    return re.findall(r"[a-z0-9']+", text.lower())


def is_duplicated_output(raw_text: str, cleaned_text: str) -> bool:
    raw_words = _normalize_words(raw_text)
    out_words = _normalize_words(cleaned_text)
    if len(raw_words) < 4 or len(out_words) < int(len(raw_words) * 1.75):
        return False
    half = len(out_words) // 2
    if half > 4 and out_words[:half] == out_words[half : half * 2]:
        return True
    raw_joined = " ".join(raw_words)
    out_joined = " ".join(out_words)
    first = out_joined.find(raw_joined)
    return first != -1 and out_joined.find(raw_joined, first + len(raw_joined)) != -1


def apply_dictionary_rules(text: str, dictionary: Optional[List[Mapping[str, Any]]]) -> str:
    if not text or not dictionary:
        return text
    result = text
    for item in dictionary:
        trigger = str(item.get("trigger", "")).strip()
        if not trigger:
            continue
        item_type = str(item.get("type", "word")).strip()
        replacement = str(item.get("replacement", "")).strip()
        pattern = re.compile(rf"\b{re.escape(trigger)}\b", re.IGNORECASE)
        if item_type == "replacement" and replacement:
            result = pattern.sub(replacement, result)
        else:
            result = pattern.sub(trigger, result)
    return result


def deterministic_fallback_polish(
    raw_text: str,
    decision: AppStyleDecision,
    cleanup: Optional[Mapping[str, Any]] = None,
    dictionary: Optional[List[Mapping[str, Any]]] = None,
) -> str:
    """Fast local fallback if no Layer 2 LLM URL is configured or if the LLM times out."""
    cfg = cleanup or {}
    text = raw_text.strip()
    if not text:
        return ""

    if cfg.get("removeFillerWords", True):
        text = FILLER_REGEX.sub("", text)

    if cfg.get("applySelfCorrections", True):
        text = CORRECTION_REGEX.sub("", text)
        text = STUTTER_REGEX.sub(r"\1", text)

    text = re.sub(r"\s{2,}", " ", text).strip()
    text = apply_dictionary_rules(text, dictionary)

    if decision.style == "very_casual":
        if text:
            text = text[0].lower() + text[1:]
        text = re.sub(r"\.$", "", text)
    else:
        if cfg.get("autoCapitalization", True) and text:
            text = text[0].upper() + text[1:]
        if cfg.get("autoPunctuation", True) and decision.style in ("formal", "standard"):
            if text and text[-1] not in ".!?":
                text += "."
        elif decision.style == "casual":
            text = re.sub(r"\.$", "", text)

    return text.strip()


class Layer2Refiner:
    """Async Layer 2 LLM polisher with automatic deterministic fallback."""

    def __init__(self) -> None:
        self.base_url = (
            os.getenv("CRISPTYPE_LLM_URL") or os.getenv("FLOW_LLM_URL") or ""
        ).strip().rstrip("/")
        self.api_key = (
            os.getenv("CRISPTYPE_LLM_API_KEY") or os.getenv("FLOW_LLM_API_KEY") or ""
        ).strip()
        self.model = (
            os.getenv("CRISPTYPE_LLM_MODEL") or os.getenv("FLOW_LLM_MODEL") or "llama3.2:3b"
        ).strip()
        self.timeout_sec = float(
            os.getenv("CRISPTYPE_LLM_TIMEOUT_SEC") or os.getenv("FLOW_LLM_TIMEOUT_SEC") or "15"
        )

    @property
    def provider_label(self) -> str:
        if not self.base_url:
            return "deterministic-fallback"
        return f"llm ({self.model})"

    def _endpoint_url(self) -> str:
        if self.base_url.endswith("/chat/completions"):
            return self.base_url
        if self.base_url.endswith("/v1"):
            return f"{self.base_url}/chat/completions"
        return f"{self.base_url}/v1/chat/completions"

    async def refine(
        self,
        raw_text: str,
        decision: AppStyleDecision,
        cleanup: Optional[Mapping[str, Any]] = None,
        dictionary: Optional[List[Mapping[str, Any]]] = None,
        language: str = "en",
    ) -> str:
        if not raw_text.strip():
            return ""

        if not self.base_url:
            return deterministic_fallback_polish(raw_text, decision, cleanup, dictionary)

        system_prompt = build_layer2_system_prompt(
            decision=decision,
            cleanup=cleanup,
            dictionary=dictionary,
            language=language,
        )

        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"

        payload = {
            "model": self.model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": wrap_untrusted_transcript(raw_text)},
            ],
        }

        try:
            async with httpx.AsyncClient(timeout=self.timeout_sec) as client:
                resp = await client.post(self._endpoint_url(), headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                raw_polished = (
                    data.get("choices", [{}])[0]
                    .get("message", {})
                    .get("content", "")
                    .strip()
                )
                polished = strip_transcript_delimiters(raw_polished) if raw_polished else ""
                if polished and not is_duplicated_output(raw_text, polished):
                    return apply_dictionary_rules(polished, dictionary)
        except Exception as exc:
            # Never log raw or formatted user transcripts
            logger.warning(
                "Layer 2 LLM unavailable (%s); falling back to deterministic cleaner.",
                type(exc).__name__,
            )

        return deterministic_fallback_polish(raw_text, decision, cleanup, dictionary)
