"""학교 LLM(OpenAI 호환) 클라이언트.

10/21 시험에서 확인한 서버 특성을 여기서 처리합니다.
  - User-Agent 헤더가 없으면 거절됨
  - qwen은 생각(thinking)을 꺼야 구조화 출력이 제때 끝남
  - JSON을 닫지 않고 빈 줄로 채운 채 멈출 때가 있음 → repair()
  - 429(분당 한도)는 Retry-After만큼 기다리고, 5xx는 조금씩 늘려 기다린 뒤 다시 보냄
  - 동시 요청을 받음: gemma 4개를 한꺼번에 보내면 16초, 하나씩이면 약 32초(11/05). 그래서 보내는
    간격(gap_sec, 보낸 시각부터 다음 보낸 시각까지)만 지키고 응답은 여러 스레드가 함께 기다림
"""

import json
import re
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, Protocol

import httpx2

from app.core.config import settings

type JsonObject = dict[str, Any]

USER_AGENT = "NoteLink-AI/0.1"


class LlmError(Exception):
    """다시 보내도 답을 받지 못함. 메시지는 짧은 원인(예: 'HTTP 503', 'JSON')."""


class LlmCutError(LlmError):
    """답을 JSON으로 읽지 못함(주로 응답 잘림)."""


STOPPED = "멈춤(다 모았거나 시간 상한)"
_local = threading.local()


@contextmanager
def stop_on(event: threading.Event) -> Iterator[None]:
    """이 스레드의 호출은 event가 켜지면 보내지 않고 LlmError(STOPPED).

    차례를 기다리거나 다시 보내기 전에 기다리는 동안에도 event로 깨어나 멈춥니다. 맞춤 퀴즈가
    세트를 돌려준 뒤 남은 스레드가 차례를 기다리던 호출이나 재시도를 보내지 않게(Codex 리뷰
    #125). 신호는 이 스레드에만 걸리므로(threading.local) 블록 안에서 다른 스레드로 넘긴 호출은
    멈추지 않습니다. 지금은 _Until(generate.py)이 호출하는 스레드에서 감쌉니다.
    """
    before = getattr(_local, "stop", None)
    _local.stop = event
    try:
        yield
    finally:
        _local.stop = before


def _stop_event() -> threading.Event | None:
    event: threading.Event | None = getattr(_local, "stop", None)
    return event


def check_stop() -> None:
    """stop_on으로 건 신호가 켜졌으면 LlmError(STOPPED)."""
    event = _stop_event()
    if event is not None and event.is_set():
        raise LlmError(STOPPED)


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
        # 다음 호출을 보낼 수 있는 가장 이른 시각(앞 호출을 보낸 시각 + gap). 한 프로세스 안의
        # 호출이 분당 한도를 같이 쓰므로 보낼 차례만 잠금으로 정하고 응답은 잠금 밖에서 기다림.
        # 응답을 받을 때까지 잠그면 호출이 하나씩만 나가서 맞춤 퀴즈 5문제에 7분이 걸렸음(#95)
        self._next = float("-inf")
        self._held = float("-inf")  # 429를 받아 이 시각까지는 아무도 보내지 않음
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
        return self._send(body)

    def _pause(self, sec: float) -> None:
        """sec초 기다림. stop_on으로 건 신호가 있으면 켜질 때 바로 깨어남."""
        event = _stop_event()
        if event is not None and self._sleep is time.sleep:
            event.wait(sec)
        else:
            self._sleep(sec)

    def _turn(self) -> None:
        """보낼 수 있을 때(앞 호출을 보낸 뒤 gap_sec, 429 대기 뒤)까지 기다려 차례를 가져갑니다.

        차례는 실제로 보낼 때만 가져갑니다. 미리 잡아 두면 기다리다 멈춘 호출의 빈 차례만큼
        다음 작업이 밀리고(/code-review #125), 429가 온 사이에 잡아 둔 차례대로 보내면 한도 안에서
        다시 429를 받음(/code-review #95). 깨어날 때마다 멈춤 신호를 봅니다.
        """
        while True:
            check_stop()
            with self._lock:
                now = self._clock()
                ready = max(self._next, self._held)
                if now >= ready:
                    self._next = now + self._gap
                    return
                wait = ready - now
            self._pause(wait)

    def _hold(self, sec: float) -> None:
        """429: 모든 스레드가 sec초 동안 보내지 않음."""
        with self._lock:
            self._held = max(self._held, self._clock() + sec)

    def _send(self, body: JsonObject) -> JsonObject:
        err = "retries"
        for attempt in range(self._retries + 1):
            self._turn()  # 멈춤 신호도 여기서 봄(처음 · 다시 보내기 전)
            try:
                res = self._client.post("/chat/completions", json=body)
            except httpx2.TransportError as e:
                err = type(e).__name__
                self._pause(4 * (attempt + 1))
                continue
            if res.status_code == 429:
                self._hold(float(res.headers.get("retry-after") or 20))
                err = "HTTP 429"
                continue
            if res.status_code != 200:
                err = f"HTTP {res.status_code}"
                self._pause(4 * (attempt + 1))
                continue
            parsed = repair(_content(res))
            if not isinstance(parsed, dict):
                err = "JSON"
                continue
            return parsed
        check_stop()  # 마지막 대기 중에 멈췄으면 서버 실패가 아니라 멈춤
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
