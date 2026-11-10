"""ClaudeLlm(#278): 실제 호출 없이 가짜 응답(MockTransport)으로 요청 모양 · 오류 구분을 봅니다."""

import json
from collections.abc import Callable
from typing import Any

import httpx2
import pytest
from pydantic import SecretStr

from app.clients.llm import (
    CLAUDE_THINK_ROOM,
    CLAUDE_TOKEN_SCALE,
    ClaudeLlm,
    LlmCutError,
    LlmError,
    LlmRejectedError,
    LlmSetupError,
    SchoolLlm,
    claude_llm,
    llm_setup_problem,
    make_llm,
)
from app.core.config import Settings, settings

SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["natural"],
    "properties": {
        "natural": {
            "type": "array",
            "minItems": 5,
            "maxItems": 5,
            "items": {"type": "string", "maxLength": 20},
        }
    },
}
USAGE_LIMIT = (
    "You have reached your specified workspace API usage limits. "
    "You will regain access on 2026-12-01 at 00:00 UTC."
)


def message(text: str, *, stop: str = "end_turn", thinking: bool = False) -> dict[str, Any]:
    content: list[dict[str, Any]] = []
    if thinking:  # 생각을 끌 수 없는 모델은 답 앞에 thinking 블록이 올 수 있음
        content.append({"type": "thinking", "thinking": "", "signature": "sig"})
    content.append({"type": "text", "text": text})
    return {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-5-5",
        "content": content,
        "stop_reason": stop,
        "stop_sequence": None,
        "usage": {"input_tokens": 10, "output_tokens": 5},
    }


def error(status: int, kind: str, text: str, headers: dict[str, str] | None = None) -> Any:
    body = {"type": "error", "error": {"type": kind, "message": text}}
    return httpx2.Response(status, json=body, headers=headers or {})


class Server:
    def __init__(self, *replies: Any) -> None:
        self.replies = list(replies)
        self.bodies: list[dict[str, Any]] = []
        self.headers: list[httpx2.Headers] = []
        self.sleeps: list[float] = []
        self.now = 0.0  # 가짜 시계: 잠든 만큼만 흐름

    def sleep(self, sec: float) -> None:
        self.sleeps.append(sec)
        self.now += sec

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.bodies.append(json.loads(request.content))
        self.headers.append(request.headers)
        reply = self.replies.pop(0)
        if isinstance(reply, httpx2.Response):
            return reply
        return httpx2.Response(200, json=reply)

    def client(self, **kw: Any) -> ClaudeLlm:
        return ClaudeLlm(
            "test-key",
            gap_sec=0,
            base_url="https://claude.test",
            transport=httpx2.MockTransport(self.handle),
            sleep=self.sleep,
            clock=lambda: self.now,
            **kw,
        )


def call(llm: ClaudeLlm, model: str = "claude-sonnet-5-5", max_tokens: int = 100) -> Any:
    return llm.call(model, "시스템", "사용자", SCHEMA, "Naturals", max_tokens=max_tokens)


# ---------- 요청 모양 ----------


def test_sonnet_request_uses_structured_outputs_without_thinking_or_temperature() -> None:
    s = Server(message('{"natural": ["a"]}'))

    assert call(s.client()) == {"natural": ["a"]}

    body = s.bodies[0]
    assert body["model"] == "claude-sonnet-5-5"
    assert body["system"] == "시스템"
    assert body["messages"] == [{"role": "user", "content": "사용자"}]
    assert body["thinking"] == {"type": "between_tools"}
    assert body["max_tokens"] == 100 * CLAUDE_TOKEN_SCALE
    assert "temperature" not in body
    assert body["output_config"]["effort"] == "low"
    fmt = body["output_config"]["format"]
    assert fmt["type"] == "json_schema"
    # 지원하지 않는 제약은 보내지 않고 설명으로 옮김(서비스가 받은 뒤 개수 · 길이를 다시 봄)
    arr = fmt["schema"]["properties"]["natural"]
    assert "maxItems" not in arr and "maxLength" not in arr["items"]
    assert "test-key" in s.headers[0]["authorization"]  # SDK 2.x는 키를 Authorization으로 보냄
    assert s.headers[0]["anthropic-version"] == "2026-10-21"


def test_haiku_keeps_default_thinking_and_gets_room_for_it() -> None:
    s = Server(message('{"natural": []}', thinking=True))

    assert call(s.client(), model="claude-haiku-5-5") == {"natural": []}

    body = s.bodies[0]
    assert "thinking" not in body  # between_tools는 Sonnet 5.5만 받음(다른 모델은 400)
    assert body["max_tokens"] == 100 * CLAUDE_TOKEN_SCALE + CLAUDE_THINK_ROOM


def test_same_schema_is_transformed_once() -> None:
    s = Server(message("{}"), message("{}"))
    llm = s.client()
    call(llm)
    call(llm)
    assert s.bodies[0]["output_config"] == s.bodies[1]["output_config"]
    assert len(llm._schemas) == 1


# ---------- 응답 · 오류 ----------


def test_cut_json_is_repaired() -> None:
    s = Server(message('{"natural": ["a", "b"', stop="max_tokens"))
    assert call(s.client()) == {"natural": ["a", "b"]}


def test_unreadable_answer_is_retried_then_cut_error() -> None:
    s = Server(message("..."), message("..."), message("..."))
    with pytest.raises(LlmCutError):
        call(s.client())
    assert len(s.bodies) == 3


def test_refusal_is_rejected_without_resending() -> None:
    s = Server(message("", stop="refusal"))
    with pytest.raises(LlmRejectedError):
        call(s.client())
    assert len(s.bodies) == 1


def test_workspace_usage_limit_ends_the_job_at_once() -> None:
    s = Server(error(400, "invalid_request_error", USAGE_LIMIT))
    with pytest.raises(LlmSetupError) as e:
        call(s.client())
    assert e.value.retry is False  # 한도가 풀릴 때까지 다시 해도 같음
    assert len(s.bodies) == 1


def test_billing_error_ends_the_job_at_once() -> None:
    s = Server(error(402, "billing_error", "Your credit balance is too low."))
    with pytest.raises(LlmSetupError) as e:
        call(s.client())
    assert e.value.retry is False


def test_other_bad_request_is_rejected() -> None:
    s = Server(error(400, "invalid_request_error", "max_tokens: too large"))
    with pytest.raises(LlmRejectedError, match="HTTP 400"):
        call(s.client())
    assert len(s.bodies) == 1


@pytest.mark.parametrize("status", [401, 403, 404])
def test_key_or_model_problem_is_setup_error(status: int) -> None:
    s = Server(error(status, "authentication_error", "invalid x-api-key"))
    with pytest.raises(LlmSetupError) as e:
        call(s.client())
    assert e.value.retry is True


def test_rate_limit_waits_retry_after_then_resends() -> None:
    s = Server(
        error(429, "rate_limit_error", "slow down", {"retry-after": "7"}),
        message('{"natural": []}'),
    )
    llm = s.client()
    assert call(llm) == {"natural": []}
    assert len(s.bodies) == 2
    assert s.sleeps == [7]  # Retry-After만큼 모든 호출이 쉬고 다시 보냄
    assert llm._held == 7


@pytest.mark.parametrize("status", [500, 529])
def test_server_error_is_retried(status: int) -> None:
    s = Server(error(status, "overloaded_error", "busy"), message('{"natural": []}'))
    assert call(s.client()) == {"natural": []}
    assert s.sleeps == [4]


def test_server_error_every_time_gives_llm_error() -> None:
    s = Server(*(error(529, "overloaded_error", "busy") for _ in range(3)))
    with pytest.raises(LlmError, match="HTTP 529"):
        call(s.client())


def test_connection_error_is_retried() -> None:
    calls: list[int] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        calls.append(1)
        if len(calls) == 1:
            raise httpx2.ConnectError("down", request=request)
        return httpx2.Response(200, json=message("{}"))

    llm = ClaudeLlm(
        "k",
        gap_sec=0,
        base_url="https://claude.test",
        transport=httpx2.MockTransport(handle),
        sleep=lambda sec: None,
    )
    assert call(llm) == {}
    assert len(calls) == 2


# ---------- 설정 ----------


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> Callable[..., None]:
    def use(name: str, **values: object) -> None:
        monkeypatch.setattr(settings, "llm_provider", name)
        for key, value in values.items():
            monkeypatch.setattr(settings, key, value)

    return use


def test_claude_without_key_is_setup_error(provider: Callable[..., None]) -> None:
    provider("claude", anthropic_api_key=SecretStr(""))
    assert llm_setup_problem() == "ANTHROPIC_API_KEY"
    with pytest.raises(LlmSetupError, match="ANTHROPIC_API_KEY") as e:
        claude_llm()
    assert e.value.retry is False


def test_provider_picks_the_client(provider: Callable[..., None]) -> None:
    provider("claude", anthropic_api_key=SecretStr("k"))
    assert isinstance(make_llm(), ClaudeLlm)
    assert llm_setup_problem() is None
    provider("school", school_llm_base_url="https://llm.test")
    assert isinstance(make_llm(), SchoolLlm)
    assert llm_setup_problem() is None


def test_models_and_gap_follow_the_provider() -> None:
    claude = Settings(_env_file=None, llm_provider="claude")  # type: ignore[call-arg]
    assert (claude.quiz_gen_model, claude.quiz_check_model) == (
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
    )
    assert claude.recording_model == claude.note_split_model == "claude-sonnet-5-5"
    assert claude.call_gap_sec == 1.2

    school = Settings(_env_file=None, llm_provider="school")  # type: ignore[call-arg]
    assert (school.quiz_gen_model, school.quiz_check_model) == ("gemma-4-26b", "qwen-27b")
    assert school.call_gap_sec == 2.2


def test_model_and_gap_set_in_env_are_kept() -> None:
    s = Settings(  # type: ignore[call-arg]
        _env_file=None,
        llm_provider="claude",
        quiz_check_model="claude-sonnet-5-5",
        llm_call_gap_sec=0,
    )
    assert s.quiz_check_model == "claude-sonnet-5-5"
    assert s.quiz_gen_model == "claude-sonnet-5-5"
    assert s.call_gap_sec == 0
