"""작업마다 LLM 사용량 모으기(#621): 모델별 호출 수 · 토큰 · 비용, 학교 LLM으로 넘긴 수, 누적.

실제 호출 없음(가짜 서버 · 가짜 LLM).
"""

import threading
from typing import Any

import httpx2
import pytest

from app.clients.llm import (
    Budgeted,
    JobUsage,
    LlmSetupError,
    Metered,
    Spend,
    charge,
    claude_cost,
)
from app.core.config import settings
from tests.clients import test_llm as school_fakes
from tests.clients.test_claude_llm import SCHEMA, Server, message
from tests.fakes import FakeLlm

SONNET_10_5 = claude_cost("claude-sonnet-5-5", 10, 5)  # message()의 usage: 입력 10 · 출력 5


@pytest.fixture(autouse=True)
def claude_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "llm_provider", "claude")


class Priced(FakeLlm):
    """호출마다 model 이름으로 청구하는 가짜(ClaudeLlm처럼 토큰과 함께)."""

    def __init__(self, input_tokens: int = 1000, output_tokens: int = 200) -> None:
        super().__init__()
        self.tokens = (input_tokens, output_tokens)

    def call(self, model: str, *a: Any, **kw: Any) -> Any:
        charge(claude_cost(model, *self.tokens), model, *self.tokens)
        return {"ok": True}


def school_reply(prompt: int, completion: int) -> httpx2.Response:
    body = {
        "choices": [{"message": {"content": '{"ok": true}'}}],
        "usage": {"prompt_tokens": prompt, "completion_tokens": completion},
    }
    return httpx2.Response(200, json=body)


def test_claude_answers_are_counted_by_model_including_retries() -> None:
    # 못 읽은 답도 청구되므로 호출 수 · 토큰에 셈(다시 보낸 것까지 2회)
    usage = JobUsage()
    s = Server(message("..."), message('{"natural": ["a"]}'))
    costs: list[float] = []
    llm = Metered(s.client(), costs.append, usage)
    assert llm.call("claude-sonnet-5-5", "s", "u", SCHEMA, "Naturals") == {"natural": ["a"]}
    assert costs == [pytest.approx(2 * SONNET_10_5)]
    assert usage.usd == pytest.approx(2 * SONNET_10_5)  # 0.00014
    assert usage.summary() == (
        "LLM claude · claude-sonnet-5-5 2회 입력 20/출력 10 $0.0001 · 합계 $0.0001"
    )


def test_school_answers_are_counted_with_their_tokens_at_no_cost() -> None:
    usage = JobUsage()
    server = school_fakes.Server(school_reply(1234, 56), school_fakes.reply('{"ok": true}'))
    llm = Metered(server.client(), lambda usd: None, usage)
    llm.call("gemma-4-26b", "s", "u", SCHEMA, "X")
    llm.call("gemma-4-26b", "s", "u", SCHEMA, "X")  # usage가 없는 응답: 호출만 셈
    assert usage.usd == 0.0
    assert usage.summary(provider="school") == (
        "LLM school · gemma-4-26b 2회 입력 1,234/출력 56 $0 · 합계 $0"
    )


def test_models_are_listed_by_cost_and_amounts_are_readable() -> None:
    usage = JobUsage()
    llm = Metered(Priced(12_345, 2_345), lambda usd: None, usage)
    llm.call("claude-haiku-5-5", "s", "u", SCHEMA, "X")
    llm.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    llm.call("claude-haiku-5-5", "s", "u", SCHEMA, "X")
    # Sonnet 0.04814 · Haiku 2 × 0.002407, 합계 0.052954. 소수 넷째 자리까지(끝의 0은 뺌)
    assert usage.summary() == (
        "LLM claude · claude-sonnet-5-5 1회 입력 12,345/출력 2,345 $0.0481"
        " · claude-haiku-5-5 2회 입력 24,690/출력 4,690 $0.0048 · 합계 $0.053"
    )


def test_a_job_without_llm_calls_says_so() -> None:
    assert JobUsage().summary() == "LLM claude · 호출 없음 · 합계 $0"


def test_calls_from_many_threads_are_all_counted() -> None:
    # 퀴즈 자리처럼 여러 스레드가 같은 작업 연결로 부름
    usage = JobUsage()
    llm = Metered(Priced(10, 5), lambda usd: None, usage)
    threads = [
        threading.Thread(target=llm.call, args=("claude-sonnet-5-5", "s", "u", SCHEMA, "X"))
        for _ in range(20)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert "claude-sonnet-5-5 20회 입력 200/출력 100" in usage.summary()
    assert usage.usd == pytest.approx(20 * SONNET_10_5)


# ---------- Budgeted: 학교 LLM으로 넘긴 수 · 누적 ----------


def test_fallbacks_and_the_running_total_are_shown_without_reading_the_db_again() -> None:
    reads: list[float] = []

    def read() -> float:
        reads.append(69.95)
        return 69.95

    b = Budgeted(Priced(), lambda: FakeLlm(answers={"X": [{}, {}]}), Spend(read), 70.0, {})
    usage = JobUsage()
    llm = Metered(b, lambda usd: None, usage)
    llm.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")  # 69.95 + 0.004 → 69.954
    b.spend.add(0.05)  # 다른 작업이 같은 사이 씀 → 70.004
    llm.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")  # 한도: 학교 LLM
    llm.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    seen = len(reads)
    line = usage.summary()
    assert len(reads) == seen  # 로그를 위해 DB 합계를 다시 읽지 않음
    assert " · 학교 LLM으로 넘김 2회" in line
    assert line.endswith(" · 누적 $70.004/$70")


def test_the_running_total_is_left_out_when_it_was_never_read() -> None:
    # 합계를 한 번도 못 읽음(inf): 누적 대신 이 작업 값만
    def read() -> float:
        raise RuntimeError("DB down")

    b = Budgeted(Priced(), lambda: FakeLlm(answers={"X": [{}]}), Spend(read), 70.0, {})
    usage = JobUsage()
    Metered(b, lambda usd: None, usage).call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    line = usage.summary()
    assert "누적" not in line and "학교 LLM으로 넘김 1회" in line


def test_spend_known_does_not_read() -> None:
    reads: list[int] = []

    def read() -> float:
        reads.append(1)
        return 5.0

    spend = Spend(read)
    assert spend.known() is None and reads == []
    assert spend.total() == 5.0
    spend.add(0.5)
    assert spend.known() == 5.5 and reads == [1]


# ---------- /code-review 반영 ----------


def test_the_provider_shown_is_the_one_that_answered() -> None:
    # LLM_PROVIDER=claude여도 문단 나누기가 학교 LLM(NOTE_SPLIT_PROVIDER=school)이면 둘 다 보임
    usage = JobUsage()
    Metered(Priced(10, 5), lambda usd: None, usage).call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    server = school_fakes.Server(school_reply(30, 3))
    Metered(server.client(), lambda usd: None, usage).call("gemma-4-26b", "s", "u", SCHEMA, "X")
    assert usage.summary().startswith("LLM claude+school · ")


def test_a_tiny_cost_is_not_shown_as_free() -> None:
    usage = JobUsage()
    Metered(Priced(20, 5), lambda usd: None, usage).call("claude-haiku-5-5", "s", "u", SCHEMA, "X")
    assert usage.summary() == (
        "LLM claude · claude-haiku-5-5 1회 입력 20/출력 5 <$0.0001 · 합계 <$0.0001"
    )


def test_a_fallback_that_could_not_reach_the_school_llm_is_not_counted() -> None:
    def no_school() -> Any:
        raise LlmSetupError("SCHOOL_LLM_BASE_URL이 비어 있음", retry=False)

    b = Budgeted(Priced(), no_school, Spend(lambda: 80.0), 70.0, {})
    usage = JobUsage()
    with pytest.raises(LlmSetupError):
        Metered(b, lambda usd: None, usage).call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    assert "학교 LLM으로 넘김" not in usage.summary()
