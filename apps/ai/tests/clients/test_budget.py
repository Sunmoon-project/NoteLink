"""Claude 비용 제한(#298): 비용 계산 · 작업마다 기록 · 한도에 닿으면 학교 LLM으로.

실제 호출 없음(가짜 서버 · 가짜 LLM).
"""

import threading
from datetime import UTC, datetime
from typing import Any

import mongomock
import pytest
from pydantic import SecretStr

from app.clients.llm import (
    Budgeted,
    ClaudeLlm,
    LlmCutError,
    LlmRejectedError,
    LlmSetupError,
    Metered,
    Spend,
    charge,
    claude_cost,
    fallback_school_llm,
    make_llm,
    metering,
    school_models,
)
from app.core.config import settings
from app.worker import handlers
from app.worker.jobs import COST_FIELD, Job, JobStore
from tests.clients.test_claude_llm import SCHEMA, Server, call, error, message
from tests.fakes import FakeLlm

SONNET_10_5 = (10 * 2.0 + 5 * 10.0) / 1_000_000  # message()의 usage: 입력 10 · 출력 5


# ---------- 비용 계산 ----------


def test_cost_uses_the_model_prices() -> None:
    assert claude_cost("claude-sonnet-5-5", 1_000_000, 0) == pytest.approx(2.0)
    assert claude_cost("claude-sonnet-5-5", 0, 1_000_000) == pytest.approx(10.0)
    assert claude_cost("claude-haiku-5-5", 100_000, 1_000_000) == pytest.approx(0.51)
    # 날짜가 붙은 이름도 앞부분으로 찾음
    assert claude_cost("claude-haiku-5-5-20261001", 100_000, 0) == pytest.approx(0.01)


def test_a_long_haiku_prompt_costs_more() -> None:
    assert claude_cost("claude-haiku-5-5", 100_000, 0) == pytest.approx(0.01)
    assert claude_cost("claude-haiku-5-5", 100_001, 1_000_000) == pytest.approx(
        100_001 * 0.50 / 1_000_000 + 2.50
    )


def test_an_unknown_model_is_priced_as_the_most_expensive_known() -> None:
    # 예산을 적게 세지 않게
    assert claude_cost("claude-opus-5-5", 1_000_000, 1_000_000) == pytest.approx(12.0)


# ---------- ClaudeLlm이 응답마다 비용을 셈 ----------


def test_each_answer_is_charged_including_retries() -> None:
    # 못 읽은 답도 청구됨: 다시 보낸 것까지 둘 다 셈
    s = Server(message("..."), message('{"natural": ["a"]}'))
    with metering() as m:
        assert call(s.client()) == {"natural": ["a"]}
    assert m.usd == pytest.approx(2 * SONNET_10_5)


def test_answers_that_fail_the_call_are_still_charged() -> None:
    # 끝내 못 읽은 답(LlmCutError) · 거절도 청구됨
    s = Server(message("..."), message("..."), message("..."))
    with metering() as m, pytest.raises(LlmCutError):
        call(s.client())
    assert m.usd == pytest.approx(3 * SONNET_10_5)
    s = Server(message("", stop="refusal"))
    with metering() as m, pytest.raises(LlmRejectedError):
        call(s.client())
    assert m.usd == pytest.approx(SONNET_10_5)


def test_errors_without_an_answer_cost_nothing() -> None:
    s = Server(error(400, "invalid_request_error", "bad"), error(500, "api_error", "x"))
    with metering() as m, pytest.raises(Exception):  # noqa: B017 - 4xx · 5xx 모두
        call(s.client(retries=0))
    assert m.usd == 0.0


def test_meters_are_per_thread() -> None:
    seen: list[float] = []

    def other() -> None:
        with metering() as m:
            seen.append(m.usd)

    with metering() as mine:
        charge(1.0)
        t = threading.Thread(target=other)
        t.start()
        t.join()
    assert mine.usd == 1.0 and seen == [0.0]


# ---------- Metered: 작업마다 기록 ----------


class Charging(FakeLlm):
    """호출마다 cost를 청구하는 가짜(ClaudeLlm처럼)."""

    def __init__(self, cost: float, fail: Exception | None = None) -> None:
        super().__init__()
        self.cost, self.fail = cost, fail

    def call(self, *a: Any, **kw: Any) -> Any:
        charge(self.cost)
        if self.fail:
            raise self.fail
        return {"ok": True}


def test_metered_reports_each_call_and_failed_calls_too() -> None:
    costs: list[float] = []
    assert Metered(Charging(0.25), costs.append).call("m", "s", "u", SCHEMA, "X") == {"ok": True}
    with pytest.raises(LlmCutError):
        Metered(Charging(0.5, LlmCutError("잘림")), costs.append).call("m", "s", "u", SCHEMA, "X")
    Metered(FakeLlm(answers={"X": [{}]}), costs.append).call("m", "s", "u", SCHEMA, "X")
    assert costs == [0.25, 0.5]  # 비용 없는 호출(학교 LLM)은 적지 않음


def test_a_failed_cost_write_does_not_fail_the_call() -> None:
    def broken(usd: float) -> None:
        raise RuntimeError("DB down")

    assert Metered(Charging(0.1), broken).call("m", "s", "u", SCHEMA, "X") == {"ok": True}


# ---------- Spend: 합계 캐시 ----------


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_spend_rereads_the_total_after_ttl_and_adds_what_was_spent_since() -> None:
    db = [10.0]
    clock = Clock()
    spend = Spend(lambda: db[0], ttl=30, clock=clock)
    assert spend.total() == 10.0
    db[0] = 12.0
    spend.add(0.5)
    clock.now = 29
    assert spend.total() == 10.5  # 아직 다시 읽지 않음: 그사이 쓴 것만 더함
    clock.now = 30
    assert spend.total() == 12.0  # 다시 읽으면 DB 합계(그사이 쓴 것은 DB에 들어 있음)


def test_spend_keeps_the_last_total_when_reading_fails() -> None:
    clock = Clock()
    reads: list[Any] = [7.0, RuntimeError("DB down")]

    def read() -> float:
        r = reads.pop(0)
        if isinstance(r, Exception):
            raise r
        return float(r)

    spend = Spend(read, ttl=30, clock=clock)
    assert spend.total() == 7.0
    spend.add(1.0)
    clock.now = 31
    assert spend.total() == 8.0


# ---------- Budgeted: 한도에 닿으면 학교 LLM ----------


def budgeted(spent: float, claude: Any, school: Any, limit: float = 70.0) -> Budgeted:
    return Budgeted(
        claude,
        lambda: school,
        Spend(lambda: spent),
        limit,
        {"claude-sonnet-5-5": "gemma-4-26b", "claude-haiku-5-5": "qwen-27b"},
    )


def test_under_the_limit_calls_go_to_claude_and_are_added_to_spend() -> None:
    claude, school = Charging(0.25), FakeLlm()
    b = budgeted(69.0, claude, school)
    b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    assert school.calls == []
    assert b.spend.total() == pytest.approx(69.25)


def test_at_the_limit_calls_go_to_the_school_llm_with_its_models() -> None:
    claude, school = Charging(0.25), FakeLlm(answers={"X": [{"a": 1}, {"b": 2}, {"c": 3}]})
    b = budgeted(70.0, claude, school)
    assert b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X") == {"a": 1}
    b.call("claude-haiku-5-5", "s", "u", SCHEMA, "X")
    b.call("gemma-4-26b", "s", "u", SCHEMA, "X")  # 모르는 이름은 그대로
    assert [c.model for c in school.calls] == ["gemma-4-26b", "qwen-27b", "gemma-4-26b"]


def test_crossing_the_limit_switches_the_next_call() -> None:
    claude, school = Charging(0.75), FakeLlm(answers={"X": [{}]})
    b = budgeted(69.5, claude, school)
    b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")  # 69.5 → 70.25
    b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    assert len(school.calls) == 1


def test_background_calls_also_switch() -> None:
    claude, school = FakeLlm(answers={"X": [{}]}), FakeLlm(answers={"X": [{}]})
    awaited = lambda: False  # noqa: E731
    budgeted(10.0, claude, school).background(awaited).call(
        "claude-sonnet-5-5", "s", "u", SCHEMA, "X"
    )
    assert claude.backgrounded and claude.awaited is awaited and not school.calls
    budgeted(80.0, claude, school).background(awaited).call(
        "claude-sonnet-5-5", "s", "u", SCHEMA, "X"
    )
    assert school.backgrounded and school.awaited is awaited and len(school.calls) == 1


def test_the_school_client_is_made_once_and_only_when_needed() -> None:
    made: list[FakeLlm] = []

    def make() -> FakeLlm:
        made.append(FakeLlm(answers={"X": [{}, {}]}))
        return made[-1]

    b = Budgeted(FakeLlm(answers={"X": [{}]}), make, Spend(lambda: 0.0), 70.0, {})
    b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    assert made == []
    b = Budgeted(FakeLlm(), make, Spend(lambda: 70.0), 70.0, {})
    b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    assert len(made) == 1


def test_without_school_settings_the_switch_is_a_setup_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "school_llm_base_url", "")
    with pytest.raises(LlmSetupError, match="SCHOOL_LLM_BASE_URL") as e:
        fallback_school_llm()
    assert e.value.retry is False


def test_the_school_fallback_uses_the_school_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "school_llm_base_url", "https://llm.test")
    assert fallback_school_llm()._gap == 2.2


def test_school_models_map_each_setting() -> None:
    assert school_models() == {"claude-sonnet-5-5": "gemma-4-26b", "claude-haiku-5-5": "qwen-27b"}


def test_make_llm_budgets_claude_only_with_a_spend_and_a_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", SecretStr("k"))
    spend = Spend(lambda: 0.0)
    assert isinstance(make_llm(spend), Budgeted)
    assert isinstance(make_llm(), ClaudeLlm)  # 비용을 읽을 곳이 없으면 제한 없음
    monkeypatch.setattr(settings, "claude_budget_usd", 0.0)
    assert isinstance(make_llm(spend), ClaudeLlm)


# ---------- ai_jobs에 쌓기 ----------

T0 = datetime(2026, 11, 11, 9, 0, tzinfo=UTC)


def jobs() -> tuple[Any, JobStore]:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    return col, JobStore(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: T0)


def test_costs_add_up_on_the_job_and_in_total() -> None:
    col, store = jobs()
    a, b = col.insert_one({"type": "x"}).inserted_id, col.insert_one({"type": "x"}).inserted_id
    col.insert_one({"type": "x"})  # 비용 없는 작업
    store.add_cost(Job(a, "x", {}, 1), 0.25)
    store.add_cost(Job(a, "x", {}, 1), 0.5)
    store.add_cost(Job(b, "x", {}, 1), 1.0)
    assert col.find_one({"_id": a})[COST_FIELD] == pytest.approx(0.75)
    assert store.claude_spent() == pytest.approx(1.75)


def test_no_costs_total_zero() -> None:
    assert jobs()[1].claude_spent() == 0.0


def test_a_handler_writes_its_claude_cost_through_the_report(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from tests.worker.test_handlers import StubReport

    def fake_run(llm: Any, inp: Any, report: Any) -> dict[str, Any]:
        llm.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
        return {}

    monkeypatch.setattr(handlers, "_llm", lambda: Charging(0.3))
    report = StubReport(False)
    handlers._handler(fake_run)({}, report)
    assert report.costs == [0.3]


def test_use_spend_budgets_the_process_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "anthropic_api_key", SecretStr("k"))
    handlers._llm.cache_clear()
    try:
        handlers.use_spend(lambda: 0.0)
        assert isinstance(handlers._llm(), Budgeted)
    finally:
        handlers._spend.clear()
        handlers._llm.cache_clear()


def test_a_real_claude_answer_is_metered_end_to_end() -> None:
    # ClaudeLlm(가짜 서버) → Metered: 작업에 적히는 금액이 응답의 usage와 같음
    s = Server(message('{"natural": ["a"]}'))
    costs: list[float] = []
    Metered(s.client(), costs.append).call("claude-haiku-5-5", "s", "u", SCHEMA, "X")
    assert costs == [pytest.approx((10 * 0.10 + 5 * 0.50) / 1_000_000)]
