import json
import threading
from collections.abc import Callable

import httpx2
import pytest

from app.clients.llm import LlmError, SchoolLlm, repair

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


def test_calls_keep_the_minimum_gap_from_the_previous_send() -> None:
    server = Server(reply("{}"), reply("{}"))
    now = [100.0]
    llm = SchoolLlm(
        "https://llm.test",
        "key",
        gap_sec=2.2,
        transport=httpx2.MockTransport(server.handle),
        sleep=server.slept.append,
        clock=lambda: now[0],
    )
    llm.call("gemma", "s", "u", SCHEMA, "X")
    now[0] += 0.5
    llm.call("gemma", "s", "u", SCHEMA, "X")
    assert server.slept == [pytest.approx(1.7)]
