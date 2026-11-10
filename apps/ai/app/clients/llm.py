"""LLM 클라이언트: Claude API(기본, #278) · 학교 LLM(OpenAI 호환). LLM_PROVIDER로 고릅니다.

둘 다 PacedLlm 위에서 돕니다: 보내는 간격 · 429 대기 · 사용자 작업 우선(background) · 멈춤 신호
(stop_on) · 오류 구분이 같고, 요청 모양과 응답 읽기만 다릅니다(_call · _exchange).

Claude(ClaudeLlm, 공식 SDK anthropic)
  - JSON 모양은 structured outputs(output_config.format)로 강제. 지원하지 않는 제약(maxItems ·
    maxLength · 2 이상의 minItems)은 SDK의 transform_schema가 설명으로 옮김. 그래서 개수 · 길이는
    서비스가 받은 뒤 다시 확인함(지금도 확인하고 있음)
  - temperature는 보내지 않음: SDK 2.x(API 버전 2026-10-21)에서 받지 않음
  - Sonnet 5.5는 생각을 끔(between_tools), Haiku 5.5는 끌 수 없어 effort를 낮추고 그만큼
    max_tokens를 더 줌. 한국어는 학교 LLM보다 토큰이 많아 max_tokens에 CLAUDE_TOKEN_SCALE을 곱함
  - 워크스페이스 사용 한도 초과(400) · 결제 오류(402)는 설정 문제: 모든 호출이 같으므로
    LlmSetupError(retry=False)로 작업을 바로 끝냄. 400을 LlmRejectedError로 두면 서비스가 자리마다
    계속 다시 불렀음
  - 거절(stop_reason refusal)은 이 요청 탓이라 LlmRejectedError
  - SDK 자체 재시도는 끔(max_retries=0): 다시 보내기는 아래 규칙대로 여기서 함

학교 LLM: 10/21 시험에서 확인한 서버 특성을 여기서 처리합니다.
  - User-Agent 헤더가 없으면 거절됨
  - qwen은 생각(thinking)을 꺼야 구조화 출력이 제때 끝남
  - JSON을 닫지 않고 빈 줄로 채운 채 멈출 때가 있음 → repair()
  - 동시 요청을 받음: gemma 4개를 한꺼번에 보내면 16초, 하나씩이면 약 32초(11/05). 그래서 보내는
    간격(gap_sec, 보낸 시각부터 다음 보낸 시각까지)만 지키고 응답은 여러 스레드가 함께 기다림

200이 아닌 응답(#262)
  - 429(분당 한도)  Retry-After(초 · HTTP 날짜)만큼 모든 스레드가 멈췄다가 다시 보냄. 일반 재시도
                    횟수와 따로 MAX_HOLDS번까지. MAX_HOLD_SEC보다 길게 쉬라면 기다리지 않고 그만둠
  - 3xx · 401 · 403 · 404  키 · 주소 · 모델 이름이 틀림. 모든 호출이 같으므로 LlmSetupError
                    (LlmError 아님) → 서비스가 초안 하나만 버리고 다른 자리를 계속 부르지 않고 작업
                    처리기까지 올라감. 게이트웨이가 잠깐 403 · 404를 줄 수도 있어 작업은 시도 한도
                    안에서 다시(/code-review #262)
  - 그 밖의 4xx     이 요청 탓(형식 · 길이). 다시 보내도 같아 바로 LlmRejectedError. 서비스는 그
                    초안만 버리고, 작업 처리기까지 올라오면 작업을 다시 넣지 않음
  - 408 · 409 · 425 · 5xx · 연결 오류  조금씩 늘려 기다린 뒤 다시 보냄(retries번까지)
"""

import email.utils
import json
import math
import re
import threading
import time
from collections import OrderedDict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any, Protocol

import anthropic
import httpx2

from app.core.config import settings

type JsonObject = dict[str, Any]

USER_AGENT = "NoteLink-AI/0.1"


class LlmError(Exception):
    """다시 보내도 답을 받지 못함. 메시지는 짧은 원인(예: 'HTTP 503', 'JSON')."""


class LlmCutError(LlmError):
    """답을 JSON으로 읽지 못함(주로 응답 잘림)."""


class LlmRejectedError(LlmError):
    """서버가 이 요청을 거절함(400 · 413 · 422 등). 다시 보내도 같아 보내지 않음(#262)."""


class LlmSetupError(Exception):
    """LLM 설정이 틀리거나 비어 있음(사용 한도 초과 포함). 모든 호출이 같음(#262).

    LlmError가 아님: 서비스는 LlmError를 초안 하나의 실패로 보고 다른 자리를 계속 부름. 이 오류는
    그대로 작업 처리기까지 올라가 작업을 끝냅니다(runner). retry가 참이면(서버가 거절: 3xx · 401 ·
    403 · 404) 시도 한도 안에서 다시, 거짓이면(설정 값이 비어 있음) 다시 해도 같아 바로 실패.
    """

    def __init__(self, message: str, *, retry: bool = True) -> None:
        super().__init__(message)
        self.retry = retry


SETUP_STATUSES = frozenset({401, 403, 404})
RESEND_4XX = frozenset({408, 409, 425})  # 4xx지만 잠깐 뒤 다시 보내면 되는 응답
MAX_HOLDS = 5  # 한 호출이 429를 받고 다시 보내는 횟수(일반 재시도와 따로)
HOLD_SEC = 20.0  # Retry-After가 없거나 읽지 못할 때
# 이보다 길게 쉬라면(시간 · 하루 한도) 기다렸다 보내도 다시 429라 그만둠: 작업은 처리기가 나중에
# 다시. 그만둘 때도 다른 호출은 이만큼 쉼(/code-review #262)
MAX_HOLD_SEC = 120.0


STOPPED = "멈춤(다 모았거나 시간 상한)"
# 마지막 사용자 작업 호출 뒤 이만큼(호출 간격의 배수)은 background 호출을 보내지 않음(#138).
# 사용자 맞춤 퀴즈는 혼자서도 간격을 거의 다 씀(36회/81초): 응답을 기다리는 사이 빈 차례를
# 미리 만들기가 가져가면 사용자 5문제가 2분 상한에 걸려 3문제로 끝났음(11/07 학교 LLM)
QUIET_GAPS = 3
MIN_YIELD_SEC = 0.2  # 양보한 background 호출이 다시 볼 때까지 최소 대기(간격 0일 때 헛돌지 않게)
SIGNAL_POLL_SEC = 0.25  # 멈춤 신호가 여럿일 때 기다리며 다시 보는 간격
_local = threading.local()


CANCELED = "멈춤(작업이 취소됨)"
type _Signal = tuple[threading.Event, str]


@contextmanager
def stop_on(event: threading.Event, why: str = STOPPED) -> Iterator[None]:
    """이 스레드의 호출은 event가 켜지면 보내지 않고 LlmError(why).

    차례를 기다리거나 다시 보내기 전에 기다리는 동안에도 event로 깨어나 멈춥니다. 맞춤 퀴즈가
    세트를 돌려준 뒤 남은 스레드가 차례를 기다리던 호출이나 재시도를 보내지 않게(Codex 리뷰
    #125). 신호는 이 스레드에만 걸리므로(threading.local) 블록 안에서 다른 스레드로 넘긴 호출은
    멈추지 않습니다. 여러 스레드로 넘기는 호출은 연결 객체로 감쌉니다(Stopping).
    겹쳐 걸면 모두 봅니다: 작업 취소 안에서 맞춤 퀴즈 자리 멈춤(generate._until)을 걸어도 둘 다
    (#263).
    """
    before: tuple[_Signal, ...] = getattr(_local, "stops", ())
    _local.stops = (*before, (event, why))
    try:
        yield
    finally:
        _local.stops = before


def _signals() -> tuple[_Signal, ...]:
    signals: tuple[_Signal, ...] = getattr(_local, "stops", ())
    return signals


def check_stop() -> None:
    """stop_on으로 건 신호 중 켜진 것이 있으면 LlmError(그 신호의 이유)."""
    for event, why in _signals():
        if event.is_set():
            raise LlmError(why)


class Stopping:
    """event가 켜지면 이 연결로 하는 호출을 멈춥니다(LlmError(why)). 여러 스레드에서 불러도 됨.

    작업 처리기가 취소를 알아채면 그 작업의 남은 호출을 보내지 않게(#263): 처리 함수는 자리마다
    스레드를 따로 두므로 스레드 신호(stop_on)가 아니라 연결 객체로 넘깁니다. 호출할 때마다 그
    스레드에서 stop_on을 걸어, 차례를 기다리거나 다시 보내기 전 대기 중인 호출도 깨어나 멈춥니다.
    이미 보낸 호출은 응답을 기다립니다.
    """

    def __init__(self, llm: "Llm", event: threading.Event, why: str = CANCELED) -> None:
        self._llm, self._event, self._why = llm, event, why

    def call(
        self,
        model: str,
        system: str,
        user: str,
        schema: "JsonObject",
        name: str,
        *,
        max_tokens: int = 1500,
        temperature: float = 0.0,
    ) -> "JsonObject":
        with stop_on(self._event, self._why):
            check_stop()  # 가짜 LLM처럼 stop_on을 보지 않는 클라이언트에도
            return self._llm.call(
                model, system, user, schema, name, max_tokens=max_tokens, temperature=temperature
            )


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


def retry_after(value: str | None, now: datetime | None = None) -> float:
    """429의 Retry-After(초 또는 HTTP 날짜)를 기다릴 초로. 최소 1초, 못 읽으면 HOLD_SEC.

    날짜 형식을 float()로만 읽으면 ValueError가 작업 처리기까지 올라가 작업이 '처리 중 오류'로
    다시 시도 없이 실패했음(#262).
    """
    if not value:
        return HOLD_SEC
    try:
        sec = float(value)
    except ValueError:
        try:
            when = email.utils.parsedate_to_datetime(value)
        except (TypeError, ValueError):
            return HOLD_SEC
        if when.tzinfo is None:  # '-0000'처럼 시간대가 없으면 UTC
            when = when.replace(tzinfo=UTC)
        sec = (when - (now or datetime.now(UTC))).total_seconds()
    if math.isnan(sec):
        return HOLD_SEC
    return max(sec, 1.0)


def _never() -> bool:
    """양보하지 않음(사용자 작업 호출) · 이어받지 않음(background 기본값)."""
    return False


class _TransportError(Exception):
    """보내지 못했거나 응답을 받지 못함(연결 · 시간 초과). 메시지는 오류 종류 이름."""


class PacedLlm:
    """호출 간격 · 429 대기 · 사용자 작업 우선 · 멈춤 신호 · 다시 보내기를 맡는 바탕.

    제공자마다 _call(요청 모양)과 _exchange(보내고 응답 읽기)만 다릅니다.
    """

    def __init__(
        self,
        *,
        gap_sec: float,
        retries: int,
        sleep: Callable[[float], None],
        clock: Callable[[], float],
    ) -> None:
        self._gap = gap_sec
        self._retries = retries
        self._sleep = sleep
        self._clock = clock
        # 다음 호출을 보낼 수 있는 가장 이른 시각(앞 호출을 보낸 시각 + gap). 한 프로세스 안의
        # 호출이 분당 한도를 같이 쓰므로 보낼 차례만 잠금으로 정하고 응답은 잠금 밖에서 기다림.
        # 응답을 받을 때까지 잠그면 호출이 하나씩만 나가서 맞춤 퀴즈 5문제에 7분이 걸렸음(#95)
        self._next = float("-inf")
        self._held = float("-inf")  # 429를 받아 이 시각까지는 아무도 보내지 않음
        # 도는 사용자 작업 호출 수(차례 기다림 · 답 기다림 · 다시 보내기 전 대기 모두)와 마지막
        # 사용자 호출이 끝난 시각. 도는 호출이 있거나 끝난 지 QUIET_GAPS 안이면 background 호출은
        # 보내지 않음(#138)
        self._active = 0
        self._last = float("-inf")
        self._lock = threading.Lock()

    def background(self, awaited: Callable[[], bool] = _never) -> "Llm":
        """같은 호출 간격 · 429 대기를 쓰되, 사용자 작업 호출이 도는 동안은 보내지 않는 연결.

        노트를 만들 때 미리 만드는 퀴즈(quiz_pregen)가 씁니다(#138). 분당 한도를 같이 쓰므로
        따로 돌리기만 하면 사용자 작업이 느려짐. 미리 만들기는 안에서 여러 스레드로 호출하므로
        스레드 변수가 아니라 연결 객체로 넘깁니다. 이미 보낸 background 호출은 그대로 둡니다.
        awaited()가 참이 되면(사용자가 이 작업을 이어받음) 차례를 기다리던 호출부터 사용자 작업
        호출처럼 보냅니다.
        """
        return _Background(self, awaited)

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
        return self._call(model, system, user, schema, name, max_tokens, temperature, _never)

    def _call(
        self,
        model: str,
        system: str,
        user: str,
        schema: JsonObject,
        name: str,
        max_tokens: int,
        temperature: float,
        background: Callable[[], bool],
    ) -> JsonObject:
        """요청 본문을 만들어 self._send(body, background)."""
        raise NotImplementedError

    def _exchange(self, body: JsonObject) -> tuple[int, str | None, str | None]:
        """한 번 보내고 (HTTP 상태, Retry-After, 200이면 답 글자).

        보내지 못하면 _TransportError. 제공자만 아는 판정(사용 한도 · 거절)은 여기서
        LlmSetupError · LlmRejectedError로 바로 올림.
        """
        raise NotImplementedError

    def _pause(self, sec: float) -> None:
        """sec초 기다림. stop_on으로 건 신호가 있으면 켜질 때 바로 깨어남."""
        events = [event for event, _ in _signals()]
        if not events or self._sleep is not time.sleep:
            self._sleep(sec)
        elif len(events) == 1:
            events[0].wait(sec)
        else:  # 신호 여럿(작업 취소 · 자리 멈춤): 짧게 나눠 기다리며 모두 봄
            end = time.monotonic() + sec
            while not any(e.is_set() for e in events) and (left := end - time.monotonic()) > 0:
                events[-1].wait(min(left, SIGNAL_POLL_SEC))

    def _turn(self, yields: Callable[[], bool], mine: list[bool]) -> None:
        """보낼 수 있을 때(앞 호출을 보낸 뒤 gap_sec, 429 대기 뒤)까지 기다려 차례를 가져갑니다.

        차례는 실제로 보낼 때만 가져갑니다. 미리 잡아 두면 기다리다 멈춘 호출의 빈 차례만큼
        다음 작업이 밀리고(/code-review #125), 429가 온 사이에 잡아 둔 차례대로 보내면 한도 안에서
        다시 429를 받음(/code-review #95). 깨어날 때마다 멈춤 신호를 봅니다.
        yields()가 참인 호출(background)은 사용자 작업 호출이 도는 동안(_user_busy) 보내지
        않습니다(#138). 깨어날 때마다 다시 보고, 거짓이 되면(사용자가 이어받음) 그때부터 사용자
        작업 호출로 셉니다(mine[0], _send가 끝날 때 뺌).
        """
        while True:
            check_stop()
            bg = yields()  # 잠금 밖에서(DB를 읽을 수 있음)
            check_stop()  # 읽는 동안 켜진 멈춤 신호(Codex 리뷰 #149)
            with self._lock:
                if not bg and not mine[0]:
                    self._active += 1
                    mine[0] = True
                now = self._clock()
                ready = max(self._next, self._held)
                if now >= ready and not (bg and self._user_busy(now)):
                    self._next = now + self._gap
                    return
                # 양보한 background 호출은 간격만큼 뒤에 다시 봄
                wait = ready - now if now < ready else max(self._gap, MIN_YIELD_SEC)
            self._pause(wait)

    def _user_busy(self, now: float) -> bool:
        """잠금 안에서: 사용자 작업 호출이 도는 중이거나 방금 끝났음."""
        return self._active > 0 or now < self._last + self._gap * QUIET_GAPS

    def _hold(self, sec: float) -> None:
        """429: 모든 스레드가 sec초 동안 보내지 않음."""
        with self._lock:
            self._held = max(self._held, self._clock() + sec)

    def _send(self, body: JsonObject, yields: Callable[[], bool] = _never) -> JsonObject:
        # 사용자 작업 호출로 셌는지. 다시 보내기 전 대기 중에도 세어 두어야 background 호출이
        # 그 사이 차례를 가져가지 않음(/code-review #138)
        mine = [False]
        try:
            return self._attempts(body, yields, mine)
        finally:
            if mine[0]:
                with self._lock:
                    self._active -= 1
                    self._last = self._clock()

    def _attempts(
        self, body: JsonObject, yields: Callable[[], bool], mine: list[bool]
    ) -> JsonObject:
        err = "retries"
        tries = holds = 0  # 다시 보낸 횟수: 일반(retries까지) · 429(MAX_HOLDS까지) 따로
        while tries <= self._retries:
            self._turn(yields, mine)  # 멈춤 신호도 여기서 봄(처음 · 다시 보내기 전)
            try:
                status, after, text = self._exchange(body)
            except _TransportError as e:
                err = str(e)
                tries += 1
                self._pause(4 * tries)
                continue
            if status == 429:
                err = "HTTP 429"
                wait = retry_after(after)
                self._hold(min(wait, MAX_HOLD_SEC))  # 그만둬도 남은 호출은 쉼
                holds += 1
                if holds > MAX_HOLDS or wait > MAX_HOLD_SEC:
                    break
                continue
            if 300 <= status < 400 or status in SETUP_STATUSES:  # 3xx: 주소가 틀림(따라가지 않음)
                raise LlmSetupError(f"HTTP {status}")
            if 400 <= status < 500 and status not in RESEND_4XX:
                raise LlmRejectedError(f"HTTP {status}")
            if status != 200:
                err = f"HTTP {status}"
                tries += 1
                self._pause(4 * tries)
                continue
            parsed = repair(text)
            if not isinstance(parsed, dict):
                err = "JSON"
                tries += 1
                continue
            return parsed
        check_stop()  # 마지막 대기 중에 멈췄으면 서버 실패가 아니라 멈춤
        if err == "JSON":
            raise LlmCutError(err)
        raise LlmError(err)


class SchoolLlm(PacedLlm):
    """학교 LLM(OpenAI 호환, /chat/completions)."""

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
        super().__init__(gap_sec=gap_sec, retries=retries, sleep=sleep, clock=clock)
        self._client = httpx2.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}", "User-Agent": USER_AGENT},
            timeout=timeout,
            transport=transport,
        )

    def _call(
        self,
        model: str,
        system: str,
        user: str,
        schema: JsonObject,
        name: str,
        max_tokens: int,
        temperature: float,
        background: Callable[[], bool],
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
        return self._send(body, background)

    def _exchange(self, body: JsonObject) -> tuple[int, str | None, str | None]:
        try:
            res = self._client.post("/chat/completions", json=body)
        except httpx2.TransportError as e:
            raise _TransportError(type(e).__name__) from e
        text = _content(res) if res.status_code == 200 else None
        return res.status_code, res.headers.get("retry-after"), text


# Claude: 학교 LLM에 맞춰 둔 max_tokens를 이만큼 늘림. 같은 한국어도 토큰이 더 많고, 쓰지 않은
# 몫은 청구되지 않음
CLAUDE_TOKEN_SCALE = 2
# 생각을 끌 수 없는 모델(Haiku 5.5 등)에 더 주는 max_tokens: 생각도 max_tokens 안에서 씀.
# effort low라 대개 짧지만, 생각만 하다 끝나면(빈 답) 같은 요청을 다시 보내게 되므로 넉넉히
CLAUDE_THINK_ROOM = 4000
# 생각을 끌 수 있는 모델(이름 앞부분): 이 모델만 thinking.type between_tools를 받음(다른 모델은 400)
CLAUDE_NO_THINK = ("claude-sonnet-5-5",)
USAGE_LIMIT_HINTS = ("usage limit", "credit balance")
# 바꾼 스키마를 기억해 두는 수. 개념 고르기(concepts._pick_schema)처럼 내용마다 다른 스키마도 있어
# 오래 쓰지 않은 것부터 버림(Codex 리뷰 #279)
SCHEMA_CACHE_MAX = 128


class ClaudeLlm(PacedLlm):
    """Claude API(공식 SDK). 요청 모양은 Messages API + structured outputs(#278)."""

    def __init__(
        self,
        api_key: str,
        *,
        effort: str = "low",
        gap_sec: float = 1.2,
        retries: int = 2,
        timeout: float = 180.0,
        base_url: str | None = None,
        transport: httpx2.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__(gap_sec=gap_sec, retries=retries, sleep=sleep, clock=clock)
        self._effort = effort
        self._sdk = anthropic.Anthropic(
            api_key=api_key,
            base_url=base_url,
            max_retries=0,  # 다시 보내기는 PacedLlm이(간격 · 429 대기를 지키며)
            timeout=timeout,
            default_headers={"User-Agent": USER_AGENT},
            http_client=anthropic.DefaultHttpxClient(transport=transport) if transport else None,
        )
        self._schemas: OrderedDict[str, JsonObject] = (
            OrderedDict()
        )  # 같은 스키마를 매번 바꾸지 않게
        self._schemas_lock = threading.Lock()

    def _wire_schema(self, schema: JsonObject) -> JsonObject:
        key = json.dumps(schema, sort_keys=True, ensure_ascii=False)
        with self._schemas_lock:
            if key in self._schemas:
                self._schemas.move_to_end(key)
                return self._schemas[key]
            wire = self._schemas[key] = anthropic.transform_schema(schema)
            while len(self._schemas) > SCHEMA_CACHE_MAX:
                self._schemas.popitem(last=False)
            return wire

    def _call(
        self,
        model: str,
        system: str,
        user: str,
        schema: JsonObject,
        name: str,
        max_tokens: int,
        temperature: float,  # Claude에는 보내지 않음(모듈 설명)
        background: Callable[[], bool],
    ) -> JsonObject:
        no_think = model.startswith(CLAUDE_NO_THINK)
        body: JsonObject = {
            "model": model,
            "max_tokens": max_tokens * CLAUDE_TOKEN_SCALE + (0 if no_think else CLAUDE_THINK_ROOM),
            "system": system,
            "messages": [{"role": "user", "content": user}],
            "output_config": {
                "effort": self._effort,
                "format": {"type": "json_schema", "schema": self._wire_schema(schema)},
            },
        }
        if no_think:
            body["thinking"] = {"type": "between_tools"}
        return self._send(body, background)

    def _exchange(self, body: JsonObject) -> tuple[int, str | None, str | None]:
        try:
            msg = self._sdk.messages.create(**body)
        except anthropic.APIConnectionError as e:  # 시간 초과 포함
            raise _TransportError(type(e).__name__) from e
        except anthropic.APIResponseValidationError:  # 200인데 응답 모양이 틀림: 못 읽은 답처럼
            return 200, None, None
        except anthropic.APIStatusError as e:
            status = e.status_code
            if status == 402 or (status == 400 and _usage_limited(e)):
                raise LlmSetupError(f"HTTP {status} 사용 한도", retry=False) from e
            return status, e.response.headers.get("retry-after"), None
        if not isinstance(msg, anthropic.types.Message):  # 200인데 JSON이 아니면 SDK가 글자로 줌
            return 200, None, None
        if msg.stop_reason == "refusal":
            raise LlmRejectedError("거절(refusal)")
        text = "".join(b.text for b in msg.content if b.type == "text")
        return 200, None, text


def _usage_limited(e: anthropic.APIStatusError) -> bool:
    """워크스페이스 · 조직 사용 한도에 닿은 400(11/10 받은 응답: 'You have reached your
    specified workspace API usage limits')."""
    message = str(e.message).lower()
    return any(hint in message for hint in USAGE_LIMIT_HINTS)


class _Background:
    """PacedLlm.background(): 사용자 작업 호출에 차례를 양보하는 연결(#138)."""

    def __init__(self, llm: PacedLlm, awaited: Callable[[], bool]) -> None:
        self._llm = llm
        self._awaited = awaited

    def _yields(self) -> bool:
        return not self._awaited()

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
        return self._llm._call(
            model, system, user, schema, name, max_tokens, temperature, self._yields
        )


def _content(res: httpx2.Response) -> str | None:
    try:
        content = res.json()["choices"][0]["message"]["content"]
    except (ValueError, KeyError, IndexError, TypeError):
        return None
    return content if isinstance(content, str) else None


# 제공자에 맞는 모델 이름인지 볼 설정(환경 변수 이름은 대문자)
MODEL_FIELDS = (
    "quiz_gen_model",
    "quiz_check_model",
    "note_split_model",
    "note_refine_model",
    "recording_model",
    "note_ask_model",
)


def llm_setup_problem(provider: str | None = None) -> str | None:
    """LLM_PROVIDER에 필요한 설정이 비었거나 모델 이름이 다른 제공자 것이면 그 이유.

    처리기가 시작할 때 보고(__main__), 클라이언트를 만들 때도 봅니다. 예전 .env에 학교 LLM
    모델 이름(QUIZ_CHECK_MODEL=qwen-27b 등)이 남은 채 Claude로 바뀌면 모든 호출이 404로
    시도 한도까지 돌다 실패했음(/code-review #278).
    """
    provider = provider or settings.llm_provider
    claude = provider == "claude"
    if claude and not settings.anthropic_api_key.get_secret_value():
        return "ANTHROPIC_API_KEY가 비어 있음"
    if not claude and not settings.school_llm_base_url:
        return "SCHOOL_LLM_BASE_URL이 비어 있음"
    for field in MODEL_FIELDS:
        model = getattr(settings, field)
        if model.startswith("claude-") != claude:
            return f"{field.upper()}={model}가 LLM_PROVIDER={provider}의 모델이 아님"
    return None


def _check_setup(provider: str) -> None:
    if problem := llm_setup_problem(provider):
        raise LlmSetupError(problem, retry=False)


def school_llm() -> SchoolLlm:
    _check_setup("school")
    return SchoolLlm(
        settings.school_llm_base_url,
        settings.school_llm_api_key.get_secret_value(),
        gap_sec=settings.call_gap_sec,
    )


def claude_llm() -> ClaudeLlm:
    _check_setup("claude")
    return ClaudeLlm(
        settings.anthropic_api_key.get_secret_value(),
        effort=settings.llm_effort,
        gap_sec=settings.call_gap_sec,
    )


def make_llm() -> PacedLlm:
    """LLM_PROVIDER(claude · school)에 맞는 클라이언트."""
    return school_llm() if settings.llm_provider == "school" else claude_llm()
