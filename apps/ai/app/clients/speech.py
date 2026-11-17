"""Azure AI Speech 빠른 전사 클라이언트. 녹음은 Blob 읽기 전용 주소로 넘김.

오류 문구에 주소(SAS)를 넣지 않습니다.
"""

import json
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import httpx2

from app.clients.llm import USER_AGENT
from app.core.config import settings

API_VERSION = "2025-10-15"
LOCALE = "ko-KR"
PATH = "/speechtotext/transcriptions:transcribe"


class SpeechError(Exception):
    """전사 실패. 다시 보내도 같음(키 · 입력 오류)."""


class SpeechUnavailableError(SpeechError):
    """일시 오류가 다시 보내도 풀리지 않음."""


class NoSpeechError(SpeechError):
    """인식된 말이 없음(무음 · 잡음)."""


@dataclass(frozen=True)
class Word:
    text: str
    start_ms: int
    duration_ms: int


@dataclass(frozen=True)
class Phrase:
    text: str
    start_ms: int
    duration_ms: int
    words: tuple[Word, ...]


@dataclass(frozen=True)
class Transcript:
    duration_ms: int
    phrases: tuple[Phrase, ...]


class Speech:
    def __init__(
        self,
        endpoint: str,
        api_key: str,
        *,
        retries: int = 5,
        timeout: float = 1800.0,  # 동기 호출이라 긴 녹음은 응답까지 오래 걸림
        transport: httpx2.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._client = httpx2.Client(
            base_url=endpoint.rstrip("/"),
            headers={"Ocp-Apim-Subscription-Key": api_key, "User-Agent": USER_AGENT},
            timeout=timeout,
            transport=transport,
        )
        self._retries = retries
        self._sleep = sleep

    def transcribe(self, audio_url: str) -> Transcript:
        """녹음 주소 → 한국어 문장 · 단어별 시각. 말이 없으면 NoSpeechError."""
        definition = json.dumps({"locales": [LOCALE], "audioUrl": audio_url})
        err = "retries"
        for attempt in range(self._retries + 1):
            wait = float(2 ** (attempt + 1))
            try:
                res = self._client.post(
                    PATH,
                    params={"api-version": API_VERSION},
                    files={"definition": (None, definition)},
                )
            except httpx2.TransportError as e:
                err = type(e).__name__
            else:
                if res.status_code == 429 or res.status_code >= 500:
                    err = f"HTTP {res.status_code}"
                    wait = _retry_after(res) or wait
                elif res.status_code != 200:
                    raise SpeechError(f"HTTP {res.status_code}")  # 다시 보내도 같음
                else:
                    return _transcript(res)
            if attempt < self._retries:
                self._sleep(wait)
        raise SpeechUnavailableError(err)


def _retry_after(res: httpx2.Response) -> float | None:
    try:
        sec = float(res.headers.get("retry-after", ""))
    except ValueError:
        return None
    return sec if math.isfinite(sec) and sec > 0 else None


def _transcript(res: httpx2.Response) -> Transcript:
    try:
        data = res.json()
        duration = _ms(data["durationMilliseconds"])
        phrases = tuple(_phrase(p) for p in data.get("phrases") or [] if _has_text(p))
    except (ValueError, KeyError, TypeError, AttributeError) as e:
        raise SpeechError("응답 모양") from e
    if not phrases:
        raise NoSpeechError("인식된 말이 없음")
    return Transcript(duration, phrases)


def _has_text(phrase: dict[str, Any]) -> bool:
    text = phrase["text"]
    if not isinstance(text, str):
        raise TypeError("text")
    return bool(text.strip())


def _phrase(phrase: dict[str, Any]) -> Phrase:
    return Phrase(
        text=phrase["text"],
        start_ms=_ms(phrase["offsetMilliseconds"]),
        duration_ms=_ms(phrase["durationMilliseconds"]),
        words=tuple(_word(w) for w in phrase.get("words") or []),
    )


def _word(word: dict[str, Any]) -> Word:
    text = word["text"]
    if not isinstance(text, str):
        raise TypeError("text")
    return Word(text, _ms(word["offsetMilliseconds"]), _ms(word["durationMilliseconds"]))


def _ms(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError("밀리초")
    return value


def speech() -> Speech:
    key = settings.azure_speech_key.get_secret_value()
    if not settings.azure_speech_endpoint or not key:
        raise SpeechError("AZURE_SPEECH_ENDPOINT · AZURE_SPEECH_KEY가 비어 있음")
    return Speech(settings.azure_speech_endpoint, key)
