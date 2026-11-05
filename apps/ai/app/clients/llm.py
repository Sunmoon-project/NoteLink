"""학교 LLM(OpenAI 호환) 클라이언트.

10/21 시험에서 확인한 서버 특성을 여기서 처리합니다.
  - User-Agent 헤더가 없으면 거절됨
  - qwen은 생각(thinking)을 꺼야 구조화 출력이 제때 끝남
  - JSON을 닫지 않고 빈 줄로 채운 채 멈출 때가 있음 → repair()
  - 429(분당 한도)는 Retry-After만큼 기다리고, 5xx는 조금씩 늘려 기다린 뒤 다시 보냄
"""

import json
import re
import threading
import time
from collections.abc import Callable
from typing import Any, Protocol

import httpx2

from app.core.config import settings

type JsonObject = dict[str, Any]

USER_AGENT = "NoteLink-AI/0.1"


class LlmError(Exception):
    """다시 보내도 답을 받지 못함. 메시지는 짧은 원인(예: 'HTTP 503', 'JSON')."""


class LlmCutError(LlmError):
    """답을 JSON으로 읽지 못함(주로 응답 잘림)."""


class Llm(Protocol):
    """서비스 코드는 이 형태에만 기대고, 테스트에서는 가짜로 바꿔 끼웁니다."""

    def call(
        self,
        model: str,
        system: str,
        user: str,
        schema: JsonObject,
        name: str,
        *,
        max_tokens: int = 1500,
        temperature: float = 0.0,
    ) -> JsonObject: ...


def repair(text: str | None) -> Any:
    """모델이 쓰다 만 JSON을 닫아서 읽습니다. 끝내 못 읽으면 None."""
    if not text:
        return None
    t = text.strip()
    try:
        return json.loads(t)
    except json.JSONDecodeError:
        pass
    t = re.sub(r",\s*$", "", t)
    for _ in range(12):
        try:
            return json.loads(t)
        except json.JSONDecodeError:
            if t.count("[") > t.count("]"):
                t += "]"
            elif t.count("{") > t.count("}"):
                t += "}"
            else:
                # 괄호는 맞는데 마지막 값이 잘림: 쓰다 만 키나 문자열을 떼어 냄
                t = re.sub(r',?\s*"[^"]*$', "", t)
                if not t:
                    return None
    return None


class SchoolLlm:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        gap_sec: float = 2.2,
        retries: int = 2,
        timeout: float = 180.0,
        transport: httpx2.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._client = httpx2.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}", "User-Agent": USER_AGENT},
            timeout=timeout,
            transport=transport,
        )
        self._gap = gap_sec
        self._retries = retries
        self._sleep = sleep
        self._clock = clock
        self._last = float("-inf")
        # 한 프로세스 안의 호출이 한도를 같이 쓰므로 순서대로 보냄
        self._lock = threading.Lock()

    def call(
        self,
        model: str,
        system: str,
        user: str,
        schema: JsonObject,
        name: str,
        *,
        max_tokens: int = 1500,
        temperature: float = 0.0,
    ) -> JsonObject:
        body: JsonObject = {
            "model": model,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": name, "strict": True, "schema": schema},
            },
        }
        if model.startswith("qwen"):
            body["chat_template_kwargs"] = {"enable_thinking": False}
        with self._lock:
            return self._send(body)

    def _send(self, body: JsonObject) -> JsonObject:
        err = "retries"
        for attempt in range(self._retries + 1):
            wait = self._gap - (self._clock() - self._last)
            if wait > 0:
                self._sleep(wait)
            try:
                res = self._client.post("/chat/completions", json=body)
            except httpx2.TransportError as e:
                err = type(e).__name__
                self._last = self._clock()
                self._sleep(4 * (attempt + 1))
                continue
            self._last = self._clock()
            if res.status_code == 429:
                self._sleep(float(res.headers.get("retry-after") or 20))
                err = "HTTP 429"
                continue
            if res.status_code != 200:
                err = f"HTTP {res.status_code}"
                self._sleep(4 * (attempt + 1))
                continue
            parsed = repair(_content(res))
            if not isinstance(parsed, dict):
                err = "JSON"
                continue
            return parsed
        if err == "JSON":
            raise LlmCutError(err)
        raise LlmError(err)


def _content(res: httpx2.Response) -> str | None:
    try:
        content = res.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    return content if isinstance(content, str) else None


def school_llm() -> SchoolLlm:
    if not settings.school_llm_base_url:
        raise LlmError("SCHOOL_LLM_BASE_URL이 비어 있음")
    return SchoolLlm(
        settings.school_llm_base_url,
        settings.school_llm_api_key.get_secret_value(),
        gap_sec=settings.llm_call_gap_sec,
    )
