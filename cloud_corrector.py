from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from stt_corrector import CorrectionRecord, CorrectionResult


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "y", "on"}


@dataclass
class CloudLlmCorrector:
    """OpenAI/Anthropic/Gemini API를 사용하는 클라우드 교정기."""

    vocabulary: list[str] = field(default_factory=list)
    provider: str = "openai"
    api_key: str = ""
    model: str = ""
    timeout_sec: float = 8.0
    max_chars: int = 300
    endpoint: str = ""

    def __init__(self, vocabulary: list[str] | None = None, **_: Any) -> None:
        self.vocabulary = []
        if vocabulary:
            self.load_vocabulary(vocabulary)

        self.provider = os.environ.get("STT_CLOUD_PROVIDER", "openai").strip().lower()
        self.api_key = os.environ.get("STT_CLOUD_API_KEY", "").strip()
        self.timeout_sec = float(os.environ.get("STT_CLOUD_TIMEOUT_SEC", "8"))
        self.max_chars = int(os.environ.get("STT_CLOUD_MAX_CHARS", "300"))
        self.endpoint = os.environ.get("STT_CLOUD_ENDPOINT", "").strip()

        if self.provider == "anthropic":
            self.model = os.environ.get("STT_CLOUD_MODEL", "claude-3-5-haiku-latest").strip()
        elif self.provider == "gemini":
            self.model = os.environ.get("STT_CLOUD_MODEL", "gemini-1.5-flash").strip()
        else:
            self.provider = "openai"
            self.model = os.environ.get("STT_CLOUD_MODEL", "gpt-4o-mini").strip()

        if not self.api_key:
            raise RuntimeError("STT_CLOUD_API_KEY가 비어 있습니다.")

    def load_vocabulary(self, words: list[str]) -> None:
        seen: set[str] = set()
        clean: list[str] = []
        for w in words:
            token = str(w).strip()
            if token and token not in seen:
                seen.add(token)
                clean.append(token)
        self.vocabulary = clean

    def add_words(self, words: list[str]) -> None:
        self.load_vocabulary(self.vocabulary + list(words))

    def remove_word(self, word: str) -> None:
        target = word.strip()
        self.load_vocabulary([w for w in self.vocabulary if w != target])

    def process(self, raw_text: str) -> CorrectionResult:
        text = (raw_text or "").strip()
        if not text:
            return CorrectionResult(text="", original="", raw="", corrections=[])

        # API 비용/지연 관리: 너무 긴 텍스트는 앞부분만 교정 시도
        clipped = text[: self.max_chars]
        corrected = self._request_correction(clipped)
        if not corrected:
            corrected = clipped
        if len(text) > len(clipped):
            corrected = corrected + text[len(clipped) :]

        return CorrectionResult(
            text=corrected,
            original=text,
            raw=text,
            corrections=[],
        )

    def _request_correction(self, text: str) -> str:
        vocab_hint = ", ".join(self.vocabulary[:80]) if self.vocabulary else ""
        system_prompt = (
            "당신은 한국어 STT 후처리기입니다. 오탈자/동음이의 인식 오류만 최소한으로 교정하세요. "
            "문장 부호를 과도하게 추가하지 말고, 의미를 바꾸지 마세요. "
            "반드시 순수 텍스트 한 줄만 반환하세요."
        )
        if vocab_hint:
            system_prompt += f" 가능한 경우 다음 도메인 어휘를 우선 고려하세요: {vocab_hint}"

        if self.provider == "anthropic":
            payload = {
                "model": self.model,
                "max_tokens": 300,
                "system": system_prompt,
                "messages": [{"role": "user", "content": text}],
            }
            endpoint = self.endpoint or "https://api.anthropic.com/v1/messages"
            headers = {
                "x-api-key": self.api_key,
                "anthropic-version": "2023-06-01",
            }
            result = self._post_json(endpoint, payload, headers)
            return self._extract_anthropic_text(result) or text

        if self.provider == "gemini":
            payload = {
                "contents": [{"parts": [{"text": f"{system_prompt}\n\n입력: {text}\n출력:"}]}],
                "generationConfig": {"temperature": 0.0},
            }
            endpoint = self.endpoint or (
                f"https://generativelanguage.googleapis.com/v1beta/models/"
                f"{self.model}:generateContent?key={self.api_key}"
            )
            result = self._post_json(endpoint, payload, {})
            return self._extract_gemini_text(result) or text

        payload = {
            "model": self.model,
            "temperature": 0.0,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": text},
            ],
        }
        endpoint = self.endpoint or "https://api.openai.com/v1/chat/completions"
        headers = {"Authorization": f"Bearer {self.api_key}"}
        result = self._post_json(endpoint, payload, headers)
        return self._extract_openai_text(result) or text

    def _post_json(self, url: str, payload: dict[str, Any], headers: dict[str, str]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req_headers = {"Content-Type": "application/json", **headers}
        req = urllib.request.Request(url=url, data=body, headers=req_headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_sec) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
                parsed = json.loads(raw)
                return parsed if isinstance(parsed, dict) else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"클라우드 API 오류({e.code}): {detail[:300]}") from e
        except Exception as e:
            raise RuntimeError(f"클라우드 API 요청 실패: {e}") from e

    @staticmethod
    def _extract_openai_text(data: dict[str, Any]) -> str:
        choices = data.get("choices")
        if isinstance(choices, list) and choices:
            msg = choices[0].get("message", {})
            content = msg.get("content")
            if isinstance(content, str):
                return content.strip()
        return ""

    @staticmethod
    def _extract_anthropic_text(data: dict[str, Any]) -> str:
        content = data.get("content")
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, dict) and item.get("type") == "text":
                    t = item.get("text")
                    if isinstance(t, str) and t.strip():
                        parts.append(t.strip())
            return " ".join(parts).strip()
        return ""

    @staticmethod
    def _extract_gemini_text(data: dict[str, Any]) -> str:
        candidates = data.get("candidates")
        if isinstance(candidates, list) and candidates:
            content = candidates[0].get("content", {})
            parts = content.get("parts", [])
            chunks: list[str] = []
            if isinstance(parts, list):
                for part in parts:
                    if isinstance(part, dict):
                        t = part.get("text")
                        if isinstance(t, str) and t.strip():
                            chunks.append(t.strip())
            return " ".join(chunks).strip()
        return ""
