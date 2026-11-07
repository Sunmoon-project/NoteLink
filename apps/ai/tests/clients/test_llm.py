import json
import re
import threading
import time
from collections.abc import Callable

import httpx2
import pytest

from app.clients.llm import (
    MIN_YIELD_SEC,
    QUIET_GAPS,
    STOPPED,
    LlmCutError,
    LlmError,
    SchoolLlm,
    repair,
    stop_on,
)

SCHEMA = {"type": "object"}


def reply(
    content: str, status: int = 200, headers: dict[str, str] | None = None
) -> httpx2.Response:
    body = {"choices": [{"message": {"content": content}}]}
    return httpx2.Response(status, json=body, headers=headers)


class Server:
    """보낸 요청을 모아 두고 준비한 응답을 차례로 돌려주는 가짜 서버."""

    def __init__(self, *responses: httpx2.Response) -> None:
        self.responses = list(responses)
        self.requests: list[httpx2.Request] = []
        self.slept: list[float] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.responses.pop(0)

    def client(self, retries: int = 2) -> SchoolLlm:
        return SchoolLlm(
            "https://llm.test/v1/",
            "key",
            gap_sec=0,
            retries=retries,
            transport=httpx2.MockTransport(self.handle),
            sleep=self.slept.append,
        )


# ---------- repair ----------


def test_repair_reads_closed_json() -> None:
    assert repair('{"a": 1}') == {"a": 1}


def test_repair_closes_unfinished_brackets() -> None:
    assert repair('{"items": [{"a": 1}, {"b": 2}\n\n\n') == {"items": [{"a": 1}, {"b": 2}]}


def test_repair_drops_cut_off_trailing_value() -> None:
    assert repair('{"a": 1, "b": "잘린 글') == {"a": 1}


def test_repair_gives_up_on_empty_or_garbage() -> None:
    assert repair("") is None
    assert repair(None) is None
    assert repair('"') is None


# ---------- SchoolLlm ----------


def test_call_sends_headers_schema_and_returns_parsed_json() -> None:
    server = Server(reply('{"answer": "A"}'))
    r = server.client().call("gemma-4-26b", "sys", "user", SCHEMA, "Check", max_tokens=200)
    assert r == {"answer": "A"}
    req = server.requests[0]
    assert str(req.url) == "https://llm.test/v1/chat/completions"
    assert req.headers["user-agent"] == "NoteLink-AI/0.1"
    assert req.headers["authorization"] == "Bearer key"
    body = json.loads(req.content)
    assert body["max_tokens"] == 200
    assert body["response_format"]["json_schema"] == {
        "name": "Check",
        "strict": True,
        "schema": SCHEMA,
    }
    assert "chat_template_kwargs" not in body


def test_qwen_calls_turn_thinking_off() -> None:
    server = Server(reply("{}"))
    server.client().call("qwen-27b", "sys", "user", SCHEMA, "Check")
    body = json.loads(server.requests[0].content)
    assert body["chat_template_kwargs"] == {"enable_thinking": False}


class Clock:
    """자면 시각이 흐르는 가짜 시계. 보낸 시각을 sent에 남김."""

    def __init__(self, server: Server, gap: float) -> None:
        self.now = 100.0
        self.sent: list[float] = []
        self.on_sleep: list[Callable[[], None]] = []  # 다음 잠에 들기 전에 할 일(다른 스레드 흉내)
        handle = server.handle

        def record(request: httpx2.Request) -> httpx2.Response:
            self.sent.append(self.now)
            return handle(request)

        self.slept = server.slept
        self.llm = SchoolLlm(
            "https://llm.test",
            "key",
            gap_sec=gap,
            transport=httpx2.MockTransport(record),
            sleep=self.sleep,
            clock=lambda: self.now,
        )

    def sleep(self, sec: float) -> None:
        if self.on_sleep:
            self.on_sleep.pop(0)()
        self.slept.append(sec)
        self.now += sec


def test_rate_limit_waits_retry_after_then_succeeds() -> None:
    server = Server(reply("", 429, {"Retry-After": "7"}), reply('{"ok": true}'))
    c = Clock(server, gap=0)
    assert c.llm.call("gemma", "s", "u", SCHEMA, "X") == {"ok": True}
    assert c.slept == [7.0] and c.sent == [100.0, 107.0]


def test_a_rate_limit_holds_calls_of_other_threads_too() -> None:
    server = Server(reply("", 429, {"Retry-After": "7"}), reply("{}"), reply("{}"))
    c = Clock(server, gap=2.2)
    c.llm.call("gemma", "s", "u", SCHEMA, "X")  # 429 → 7초 뒤 다시(107)
    c.llm.call("gemma", "s", "u", SCHEMA, "X")  # 다른 호출도 다시 보낸 호출 뒤 2.2초
    assert c.sent == [100.0, 107.0, pytest.approx(109.2)]


def test_a_turn_taken_before_a_rate_limit_waits_for_it() -> None:
    # 두 번째 호출이 차례(102.2)를 기다리는 사이 다른 스레드가 429(Retry-After 7)를 받음:
    # 잡아 둔 차례에 보내지 않고 대기가 끝난 107에 보냄(/code-review #95)
    server = Server(reply("{}"), reply("{}"))
    c = Clock(server, gap=2.2)
    c.llm.call("gemma", "s", "u", SCHEMA, "X")
    c.on_sleep.append(lambda: c.llm._hold(7))
    c.llm.call("gemma", "s", "u", SCHEMA, "X")
    assert c.sent == [100.0, 107.0]


def test_answers_are_awaited_together() -> None:
    """앞 호출의 응답을 기다리는 동안 다음 호출을 보냄: 첫 응답은 두 번째 요청이 와야 돌아감."""
    both = threading.Barrier(2, timeout=5)

    def handle(request: httpx2.Request) -> httpx2.Response:
        both.wait()  # 잠금을 잡은 채 기다리면 두 번째 요청이 오지 않아 시간 초과
        return reply("{}")

    llm = SchoolLlm("https://llm.test", "key", gap_sec=0, transport=httpx2.MockTransport(handle))
    out: list[object] = []
    threads = [
        threading.Thread(target=lambda: out.append(llm.call("gemma", "s", "u", SCHEMA, "X")))
        for _ in range(2)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(10)
    assert out == [{}, {}]


def test_server_errors_back_off_then_raise() -> None:
    server = Server(*(reply("", 503) for _ in range(3)))
    with pytest.raises(LlmError, match="HTTP 503"):
        server.client(retries=2).call("gemma", "s", "u", SCHEMA, "X")
    assert server.slept == [4, 8, 12]


def test_unreadable_answer_is_retried_then_raises() -> None:
    server = Server(reply("모르겠습니다"), reply("[1, 2]"))
    with pytest.raises(LlmError, match="JSON"):
        server.client(retries=1).call("gemma", "s", "u", SCHEMA, "X")
    assert len(server.requests) == 2


def test_unreadable_answer_raises_cut_error_with_same_message() -> None:
    server = Server(reply("모르겠습니다"), reply("[1, 2]"))
    with pytest.raises(LlmCutError, match="^JSON$"):
        server.client(retries=1).call("gemma", "s", "u", SCHEMA, "X")


def test_server_error_is_not_a_cut_error() -> None:
    server = Server(reply("", 503))
    with pytest.raises(LlmError) as e:
        server.client(retries=0).call("gemma", "s", "u", SCHEMA, "X")
    assert not isinstance(e.value, LlmCutError)


def test_calls_keep_the_minimum_gap_from_the_previous_send() -> None:
    server = Server(reply("{}"), reply("{}"))
    c = Clock(server, gap=2.2)
    c.llm.call("gemma", "s", "u", SCHEMA, "X")
    c.now += 0.5
    c.llm.call("gemma", "s", "u", SCHEMA, "X")
    assert c.slept == [pytest.approx(1.7)] and c.sent == [100.0, pytest.approx(102.2)]


def test_a_call_stopped_while_waiting_for_its_turn_is_not_sent() -> None:
    # 맞춤 퀴즈가 세트를 돌려주는 동안 차례(102.2)를 기다리던 호출: 보내지 않음(Codex 리뷰 #125)
    server = Server(reply("{}"), reply("{}"))
    c = Clock(server, gap=2.2)
    c.llm.call("gemma", "s", "u", SCHEMA, "X")
    stop = threading.Event()
    c.on_sleep.append(stop.set)
    with stop_on(stop), pytest.raises(LlmError, match=re.escape(STOPPED)):
        c.llm.call("gemma", "s", "u", SCHEMA, "X")
    assert c.sent == [100.0]
    # 멈춘 호출은 차례를 가져가지 않음: 다음 호출이 그 빈 차례 뒤로 밀리지 않음(/code-review #125)
    c.llm.call("gemma", "s", "u", SCHEMA, "X")
    assert c.sent == [100.0, pytest.approx(102.2)]


def test_a_stop_wakes_a_call_waiting_for_its_turn() -> None:
    # 실제 대기(time.sleep)일 때: 429로 10초를 기다리던 호출이 멈춤 신호에 바로 깨어남
    server = Server(reply("{}"))
    llm = SchoolLlm(
        "https://llm.test", "key", gap_sec=0, transport=httpx2.MockTransport(server.handle)
    )
    llm._hold(10)
    stop = threading.Event()
    threading.Timer(0.1, stop.set).start()
    start = time.monotonic()
    with stop_on(stop), pytest.raises(LlmError, match=re.escape(STOPPED)):
        llm.call("gemma", "s", "u", SCHEMA, "X")
    assert time.monotonic() - start < 2 and server.requests == []


def test_a_stop_during_the_last_backoff_is_a_stop_not_a_server_error() -> None:
    # 마지막 시도의 503 뒤 대기 중에 멈춤: 'HTTP 503'(서버 실패)이 아니라 멈춤(/code-review #125)
    server = Server(reply("", 503), reply("", 503), reply("", 503))
    c = Clock(server, gap=0)
    stop = threading.Event()
    c.on_sleep += [lambda: None, lambda: None, stop.set]  # 세 번째(마지막) 대기 중에
    with stop_on(stop), pytest.raises(LlmError, match=re.escape(STOPPED)):
        c.llm.call("gemma", "s", "u", SCHEMA, "X")
    assert len(c.sent) == 3


def test_a_stop_during_the_last_unreadable_answer_is_a_stop_not_a_cut() -> None:
    # 마지막 시도의 답이 JSON이 아닌데 그 사이 멈춤: 답 잘림(LlmCutError)이 아니라 멈춤
    stop = threading.Event()
    server = Server()

    def handle(request: httpx2.Request) -> httpx2.Response:
        server.requests.append(request)
        stop.set()  # 응답을 기다리는 사이 다른 스레드가 멈춤 신호를 켬
        return reply("모르겠습니다")

    llm = SchoolLlm(
        "https://llm.test",
        "key",
        gap_sec=0,
        retries=0,
        transport=httpx2.MockTransport(handle),
        sleep=server.slept.append,
    )
    with stop_on(stop), pytest.raises(LlmError, match=re.escape(STOPPED)) as e:
        llm.call("gemma", "s", "u", SCHEMA, "X")
    assert not isinstance(e.value, LlmCutError)
    assert len(server.requests) == 1


def test_a_retry_is_not_sent_after_a_stop() -> None:
    server = Server(reply("", 503), reply("{}"))
    c = Clock(server, gap=0)
    stop = threading.Event()
    c.on_sleep.append(stop.set)  # 503 뒤 다시 보내기 전에 기다리는 사이 멈춤
    with stop_on(stop), pytest.raises(LlmError, match=re.escape(STOPPED)):
        c.llm.call("gemma", "s", "u", SCHEMA, "X")
    assert c.sent == [100.0]


def test_stop_on_only_covers_its_own_block() -> None:
    server = Server(reply("{}"))
    stop = threading.Event()
    stop.set()
    with stop_on(stop):
        pass
    assert server.client().call("gemma", "s", "u", SCHEMA, "X") == {}  # 블록 밖에서는 보냄


# ---------- 미리 해 두는 작업은 사용자 작업 호출에 양보(#138) ----------


def test_a_background_call_goes_at_once_when_no_user_call_runs() -> None:
    server = Server(reply("{}"))
    c = Clock(server, gap=2.2)
    assert c.llm.background().call("gemma", "s", "u", SCHEMA, "X") == {}
    assert c.sent == [100.0]


def test_a_background_call_waits_a_quiet_time_after_a_user_call() -> None:
    # 사용자 호출(100)이 답을 받은 뒤 간격 × QUIET_GAPS가 지나야 보냄: 다음 사용자 호출이 곧 옴
    server = Server(reply("{}"), reply("{}"))
    c = Clock(server, gap=2.2)
    c.llm.call("gemma", "s", "u", SCHEMA, "X")
    c.llm.background().call("gemma", "s", "u", SCHEMA, "X")
    quiet = 100 + 2.2 * QUIET_GAPS
    assert c.sent[0] == 100.0 and quiet - 1e-9 <= c.sent[1] < quiet + 2.2


def test_a_background_call_waits_while_a_user_call_is_answered() -> None:
    # 사용자 호출이 답을 기다리는 동안(차례는 이미 가져감)에도 보내지 않음
    server = Server(reply("{}"))
    c = Clock(server, gap=2.2)
    c.llm._inflight = 1

    def answered() -> None:  # 가짜 시계는 한 스레드라 다른 스레드가 답을 받은 것을 흉내
        c.llm._inflight = 0

    c.on_sleep.extend([lambda: None, answered])
    c.llm.background().call("gemma", "s", "u", SCHEMA, "X")
    assert c.slept == [pytest.approx(2.2), pytest.approx(2.2)]
    assert c.sent == [pytest.approx(104.4)]


def test_a_background_call_yielding_with_no_gap_does_not_spin() -> None:
    server = Server(reply("{}"))
    c = Clock(server, gap=0)
    c.llm._waiting = 1

    def user_went() -> None:
        c.llm._waiting = 0

    c.on_sleep.append(user_went)
    c.llm.background().call("gemma", "s", "u", SCHEMA, "X")
    assert c.slept == [MIN_YIELD_SEC]


def test_a_user_call_that_stops_or_fails_is_not_counted_as_running() -> None:
    # 기다리다 멈춘 호출 · 연결 오류가 난 호출이 수에 남으면 미리 만들기가 영영 못 보냄
    server = Server(reply("{}"))
    c = Clock(server, gap=2.2)
    c.llm.call("gemma", "s", "u", SCHEMA, "X")
    stop = threading.Event()
    c.on_sleep.append(stop.set)
    with stop_on(stop), pytest.raises(LlmError, match=re.escape(STOPPED)):
        c.llm.call("gemma", "s", "u", SCHEMA, "X")
    assert (c.llm._waiting, c.llm._inflight) == (0, 0)

    def broken(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("끊김")

    llm = SchoolLlm(
        "https://llm.test",
        "key",
        gap_sec=0,
        retries=0,
        transport=httpx2.MockTransport(broken),
        sleep=lambda sec: None,
    )
    with pytest.raises(LlmError):
        llm.call("gemma", "s", "u", SCHEMA, "X")
    assert (llm._waiting, llm._inflight) == (0, 0)


def test_user_calls_go_first_with_real_threads() -> None:
    """실제 스레드: 미리 만들기 호출 여럿이 기다려도, 나중에 온 사용자 호출이 다음 차례를 가져감."""
    sent: list[str] = []
    lock = threading.Lock()

    def handle(request: httpx2.Request) -> httpx2.Response:
        with lock:
            sent.append(json.loads(request.content)["messages"][1]["content"])
        return reply("{}")

    llm = SchoolLlm("https://llm.test", "key", gap_sec=0.05, transport=httpx2.MockTransport(handle))
    bg = llm.background()
    bg.call("gemma", "s", "first", SCHEMA, "X")
    threads = [
        threading.Thread(target=bg.call, args=("gemma", "s", f"bg{i}", SCHEMA, "X"))
        for i in range(3)
    ]
    for t in threads:
        t.start()
    time.sleep(0.01)  # 미리 만들기 호출이 모두 차례를 기다리는 중
    user = threading.Thread(target=llm.call, args=("gemma", "s", "user", SCHEMA, "X"))
    user.start()
    for t in [*threads, user]:
        t.join(5)
    assert sent[0] == "first" and sent[1] == "user"
    assert sorted(sent[2:]) == ["bg0", "bg1", "bg2"]
