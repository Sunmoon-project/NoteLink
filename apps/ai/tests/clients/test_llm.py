import json

import httpx2
import pytest

from app.clients.llm import LlmCutError, LlmError, SchoolLlm, repair

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


def test_rate_limit_waits_retry_after_then_succeeds() -> None:
    server = Server(reply("", 429, {"Retry-After": "7"}), reply('{"ok": true}'))
    assert server.client().call("gemma", "s", "u", SCHEMA, "X") == {"ok": True}
    assert server.slept == [7.0]


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


def test_calls_keep_the_minimum_gap() -> None:
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
