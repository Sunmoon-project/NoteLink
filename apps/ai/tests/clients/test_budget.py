"""Claude 비용 제한(#298): 비용 계산 · 작업마다 기록 · 한도에 닿으면 학교 LLM으로.

실제 호출 없음(가짜 서버 · 가짜 LLM).
"""

import json
import threading
import time
from datetime import UTC, datetime
from typing import Any

import mongomock
import pytest
from pydantic import SecretStr
from pymongo.errors import AutoReconnect

from app.clients.llm import (
    Budgeted,
    ClaudeLlm,
    JsonObject,
    LlmCutError,
    LlmError,
    LlmRejectedError,
    LlmSetupError,
    LlmUsageLimitError,
    Metered,
    PacedLlm,
    Spend,
    charge,
    claude_cost,
    fallback_school_llm,
    make_llm,
    metering,
    school_models,
    stop_on,
)
from app.core.config import settings
from app.worker import handlers
from app.worker import jobs as jobs_module
from app.worker.jobs import COST_FIELD, COST_IDS_FIELD, Job, JobStore
from tests.clients.test_claude_llm import SCHEMA, USAGE_LIMIT, Server, call, error, message
from tests.fakes import FakeLlm

SONNET_10_5 = (10 * 2.0 + 5 * 10.0) / 1_000_000  # message()의 usage: 입력 10 · 출력 5


# ---------- 비용 계산 ----------


def test_cost_uses_the_model_prices() -> None:
    assert claude_cost("claude-sonnet-5-5", 1_000_000, 0) == pytest.approx(2.0)
    assert claude_cost("claude-sonnet-5-5", 0, 1_000_000) == pytest.approx(10.0)
    assert claude_cost("claude-haiku-5-5", 100_000, 1_000_000) == pytest.approx(0.51)
    # 날짜가 붙은 이름도 앞부분으로 찾음
    assert claude_cost("claude-haiku-5-5-20261001", 100_000, 0) == pytest.approx(0.01)
    # 프롬프트 캐시 토큰은 input_tokens 밖에 따로 옴: 쓰기 1.25배 · 읽기 0.1배로 셈
    assert claude_cost("claude-sonnet-5-5", 0, 0, 1_000_000, 0) == pytest.approx(2.5)
    assert claude_cost("claude-sonnet-5-5", 0, 0, 0, 1_000_000) == pytest.approx(0.2)


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


def test_spend_counts_its_own_costs_and_rereads_the_db_after_ttl() -> None:
    db = [10.0]
    clock = Clock()
    spend = Spend(lambda: db[0], ttl=300, clock=clock)
    assert spend.total() == 10.0
    spend.add(0.5)
    db[0] = 10.5  # 작업 문서에 적힘
    assert spend.total() == 10.5  # 다시 읽기 전에도 바로 셈
    db[0] = 12.0  # 다른 처리기가 더 씀
    clock.now = 299
    assert spend.total() == 10.5
    clock.now = 300
    assert spend.total() == 12.0  # 큰 쪽: DB 합계


def test_a_cost_that_never_reached_the_db_is_not_dropped() -> None:
    # 작업 문서에 적기를 실패해도(Metered가 로그만 남김) 다시 읽은 뒤 사라지지 않음
    clock = Clock()
    spend = Spend(lambda: 10.0, ttl=300, clock=clock)
    assert spend.total() == 10.0
    spend.add(1.0)
    clock.now = 600
    assert spend.total() == 11.0


def test_spend_is_unknown_until_the_first_read_works() -> None:
    clock = Clock()
    reads: list[Any] = [RuntimeError("DB down"), RuntimeError("DB down"), 7.0]

    def read() -> float:
        r = reads.pop(0)
        if isinstance(r, Exception):
            raise r
        return float(r)

    spend = Spend(read, ttl=300, retry=5, clock=clock)
    assert spend.total() == float("inf")  # 모르면 한도에 닿은 것으로(학교 LLM)
    clock.now = 4
    assert spend.total() == float("inf") and len(reads) == 2  # retry 전에는 다시 읽지 않음
    clock.now = 5
    assert spend.total() == float("inf")
    clock.now = 10
    assert spend.total() == 7.0


def test_spend_keeps_the_last_total_when_a_later_read_fails() -> None:
    clock = Clock()
    reads: list[Any] = [7.0, RuntimeError("DB down")]

    def read() -> float:
        r = reads.pop(0)
        if isinstance(r, Exception):
            raise r
        return float(r)

    spend = Spend(read, ttl=300, clock=clock)
    assert spend.total() == 7.0
    spend.add(1.0)
    clock.now = 301
    assert spend.total() == 8.0


def test_only_one_thread_reads_and_the_others_use_the_last_total() -> None:
    clock = Clock()
    started, release = threading.Event(), threading.Event()
    values = [5.0, 6.0]

    def read() -> float:
        if len(values) == 1:  # 두 번째 읽기: 다른 스레드가 기다리게 막음
            started.set()
            release.wait(5)
        return values.pop(0)

    spend = Spend(read, ttl=300, clock=clock)
    assert spend.total() == 5.0
    clock.now = 300
    reader = threading.Thread(target=spend.total)
    reader.start()
    assert started.wait(5)
    assert spend.total() == 5.0  # 읽는 중: 기다리지 않고 지난 값
    release.set()
    reader.join(5)
    assert spend.total() == 6.0


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


def test_a_usage_limit_answer_switches_to_the_school_llm_for_good() -> None:
    # Console 한도가 코드에서 센 비용보다 먼저 닿음: 그 호출부터 학교 LLM, 다시 Claude로 가지 않음
    class Limited(FakeLlm):
        sent = 0

        def call(self, *a: Any, **kw: Any) -> Any:
            self.sent += 1
            raise LlmUsageLimitError("HTTP 400 사용 한도")

    claude, school = Limited(), FakeLlm(answers={"X": [{"a": 1}, {"b": 2}]})
    b = budgeted(10.0, claude, school)
    assert b.call("claude-haiku-5-5", "s", "u", SCHEMA, "X") == {"a": 1}
    b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X")
    assert claude.sent == 1
    assert [c.model for c in school.calls] == ["qwen-27b", "gemma-4-26b"]


def test_claude_usage_limit_answers_are_usage_limit_errors() -> None:
    for reply in (
        error(400, "invalid_request_error", USAGE_LIMIT),
        error(402, "billing_error", "credit balance is too low"),
    ):
        with pytest.raises(LlmUsageLimitError) as e:
            call(Server(reply).client())
        assert isinstance(e.value, LlmSetupError) and e.value.retry is False


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


def test_a_claude_model_shared_by_settings_maps_to_their_most_common_school_model(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 검사도 Sonnet이면: Sonnet을 쓰는 항목 6개 중 5개가 gemma
    monkeypatch.setattr(settings, "quiz_check_model", "claude-sonnet-5-5")
    assert school_models() == {"claude-sonnet-5-5": "gemma-4-26b"}
    # 같은 수면 MODEL_FIELDS 앞쪽: Haiku를 검사(qwen)와 노트 묻기(gemma)가 함께 쓰면 qwen
    monkeypatch.setattr(settings, "quiz_check_model", "claude-haiku-5-5")
    monkeypatch.setattr(settings, "note_ask_model", "claude-haiku-5-5")
    assert school_models()["claude-haiku-5-5"] == "qwen-27b"


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


# ---------- Codex 리뷰 #299 ----------


class StepSpend(Spend):
    """total()이 차례로 값을 돌려주는 가짜(마지막 값은 계속)."""

    def __init__(self, *totals: float) -> None:
        super().__init__(lambda: 0.0)
        self.totals = list(totals)

    def total(self) -> float:
        return self.totals.pop(0) if len(self.totals) > 1 else self.totals[0]


def test_a_call_that_waited_past_the_limit_is_not_sent_to_claude() -> None:
    # 고를 때는 한도 아래(10)였지만 차례를 기다리는 사이 다른 호출이 넘김(80): 보내기 직전에 멈춤
    s = Server(message('{"natural": ["a"]}'))
    school = FakeLlm(answers={"X": [{"school": True}]})
    b = Budgeted(s.client(), lambda: school, StepSpend(10.0, 80.0), 70.0, school_models())
    assert b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X") == {"school": True}
    assert s.bodies == []  # Claude에는 아무것도 보내지 않음
    assert [c.model for c in school.calls] == ["gemma-4-26b"]


def test_the_gate_is_checked_before_each_resend() -> None:
    # 첫 답을 못 읽어 다시 보내기 전에 한도에 닿음: 다시 보내지 않음
    s = Server(message("..."), message('{"natural": ["a"]}'))
    school = FakeLlm(answers={"X": [{"school": True}]})
    b = Budgeted(s.client(), lambda: school, StepSpend(10.0, 10.0, 80.0), 70.0, {})
    assert b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X") == {"school": True}
    assert len(s.bodies) == 1


class FlakyCol:
    """update_one이 처음 fail번은 실패하는 컬렉션."""

    def __init__(self, col: Any, fail: int) -> None:
        self.col, self.fail = col, fail

    def update_one(self, *a: Any, **kw: Any) -> Any:
        if self.fail:
            self.fail -= 1
            raise AutoReconnect("DB down")
        return self.col.update_one(*a, **kw)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.col, name)


def test_a_cost_that_failed_to_write_is_written_with_the_next_one() -> None:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    a, b = col.insert_one({"type": "x"}).inserted_id, col.insert_one({"type": "x"}).inserted_id
    store = JobStore(FlakyCol(col, 1), "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30)  # type: ignore[arg-type]
    with pytest.raises(AutoReconnect):
        store.add_cost(Job(a, "x", {}, 1), 1.0)
    store.add_cost(Job(b, "x", {}, 1), 0.5)
    # 다시 시작해도 남음: 새 Spend가 DB 합계를 읽음
    assert col.find_one({"_id": a})[COST_FIELD] == 1.0
    assert Spend(store.claude_spent).total() == pytest.approx(1.5)


def test_unwritten_costs_stay_queued_while_the_db_is_down() -> None:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    a = col.insert_one({"type": "x"}).inserted_id
    store = JobStore(FlakyCol(col, 2), "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30)  # type: ignore[arg-type]
    for usd in (1.0, 2.0):
        with pytest.raises(AutoReconnect):
            store.add_cost(Job(a, "x", {}, 1), usd)
    store.add_cost(Job(a, "x", {}, 1), 4.0)
    assert col.find_one({"_id": a})[COST_FIELD] == 7.0


# ---------- Codex 재리뷰(2차) #299 ----------


@pytest.fixture(autouse=True)
def _no_leftover_costs() -> Any:
    jobs_module._unrecorded.clear()
    jobs_module._writing.clear()
    jobs_module._spooled[0] = False
    jobs_module._spool.clear()
    yield
    jobs_module._unrecorded.clear()
    jobs_module._writing.clear()
    jobs_module._spooled[0] = False
    jobs_module._spool.clear()


def test_a_resend_sees_the_cost_of_the_answer_before_it() -> None:
    # 69.50에서 첫 응답(못 읽음)이 0.75: 같은 호출의 다시 보내기 직전에 한도를 넘긴 것을 봄
    costly = message("...")
    costly["usage"] = {"input_tokens": 0, "output_tokens": 75_000}  # Sonnet 0.75달러
    s = Server(costly, message('{"natural": ["a"]}'))
    school = FakeLlm(answers={"X": [{"school": True}]})
    spend = Spend(lambda: 69.5)
    b = Budgeted(s.client(), lambda: school, spend, 70.0, school_models())
    assert b.call("claude-sonnet-5-5", "s", "u", SCHEMA, "X") == {"school": True}
    assert len(s.bodies) == 1
    assert spend.total() == pytest.approx(70.25)  # 응답마다 한 번만 셈


class LostAckCol(FlakyCol):
    """update_one을 반영한 뒤 처음 fail번은 응답이 끊긴 것처럼 예외."""

    def update_one(self, *a: Any, **kw: Any) -> Any:
        r = self.col.update_one(*a, **kw)
        if self.fail:
            self.fail -= 1
            raise AutoReconnect("응답 끊김")
        return r


def test_a_cost_written_but_not_acknowledged_is_not_added_twice() -> None:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    a = col.insert_one({"type": "x"}).inserted_id
    store = JobStore(LostAckCol(col, 1), "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30)  # type: ignore[arg-type]
    with pytest.raises(AutoReconnect):
        store.add_cost(Job(a, "x", {}, 1), 0.25)
    store.add_cost(Job(a, "x", {}, 1), 0.5)  # 끊긴 0.25를 다시 적어도 한 번만
    assert col.find_one({"_id": a})[COST_FIELD] == pytest.approx(0.75)


def test_reading_the_total_writes_queued_costs_from_any_store() -> None:
    # 학교 LLM으로 넘긴 뒤 새 비용이 없어도, 합계를 읽는 쪽(다른 JobStore)이 모아 둔 비용을 적음
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    a = col.insert_one({"type": "x"}).inserted_id
    lane = JobStore(FlakyCol(col, 1), "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30)  # type: ignore[arg-type]
    with pytest.raises(AutoReconnect):
        lane.add_cost(Job(a, "x", {}, 1), 1.0)
    totals = JobStore(col, "w1:spend", lock_sec=60, max_attempts=3, retry_delay_sec=30)
    assert totals.claude_spent() == pytest.approx(1.0)
    assert col.find_one({"_id": a})[COST_FIELD] == 1.0


# ---------- Codex 재리뷰(3차) #299 ----------


def test_unwritten_costs_survive_a_restart_through_the_spool_file(tmp_path: Any) -> None:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    a = col.insert_one({"type": "x"}).inserted_id
    spool = str(tmp_path / "llm-cost-spool.json")
    assert jobs_module.use_spool(spool, col) == 0  # 처음: 남긴 것 없음
    lane = JobStore(FlakyCol(col, 1), "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30)  # type: ignore[arg-type]
    with pytest.raises(AutoReconnect):
        lane.add_cost(Job(a, "x", {}, 1), 1.0)
    # 처리기가 다시 시작: 메모리는 비고 파일만 남음
    jobs_module._unrecorded.clear()
    assert jobs_module.use_spool(spool, col) == 1
    totals = JobStore(col, "w1:spend", lock_sec=60, max_attempts=3, retry_delay_sec=30)
    assert Spend(totals.claude_spent).total() == pytest.approx(1.0)
    assert col.find_one({"_id": a})[COST_FIELD] == 1.0
    assert not (tmp_path / "llm-cost-spool.json").exists()  # 다 적으면 파일도 지움


def test_a_broken_spool_file_does_not_stop_the_worker(tmp_path: Any) -> None:
    (tmp_path / "s.json").write_text("{", encoding="utf-8")
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    assert jobs_module.use_spool(str(tmp_path / "s.json"), col) == 0


def test_the_total_is_still_read_after_switching_on_a_usage_limit() -> None:
    # Console 한도 오류로 넘긴 뒤에도 합계를 읽음: 읽을 때 모아 둔 비용을 다시 적으므로
    reads: list[int] = []
    clock = Clock()

    def read() -> float:
        reads.append(1)
        return 10.0

    b = Budgeted(FakeLlm(), FakeLlm, Spend(read, ttl=300, clock=clock), 70.0, {})
    b.exhaust()
    assert b.over()
    clock.now = 300
    assert b.over()
    assert len(reads) == 2


# ---------- Codex 재리뷰(4차) #299 ----------


def test_a_cost_being_rewritten_stays_in_the_spool_when_another_write_fails(tmp_path: Any) -> None:
    # A가 지난번 비용을 다시 적는 동안(응답 대기) B의 기록이 실패: 파일에 둘 다 남아야 함
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    a, b = col.insert_one({"type": "x"}).inserted_id, col.insert_one({"type": "x"}).inserted_id
    spool = tmp_path / "spool.json"
    spool.write_text(json.dumps([{"job": str(a), "id": "old", "usd": 1.0}]), encoding="utf-8")
    inside, release = threading.Event(), threading.Event()

    class Col(FlakyCol):
        def update_one(self, flt: Any, *a: Any, **kw: Any) -> Any:
            if flt[COST_IDS_FIELD]["$ne"] == "old":
                inside.set()
                release.wait(5)
                return self.col.update_one(flt, *a, **kw)
            raise AutoReconnect("DB down")

    assert jobs_module.use_spool(str(spool), Col(col, 0)) == 1
    store = JobStore(Col(col, 0), "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30)  # type: ignore[arg-type]
    flusher = threading.Thread(target=store.flush_costs)
    flusher.start()
    assert inside.wait(5)
    with pytest.raises(AutoReconnect):
        store.add_cost(Job(b, "x", {}, 1), 0.5)
    assert sorted(r["usd"] for r in json.loads(spool.read_text(encoding="utf-8"))) == [0.5, 1.0]
    release.set()
    flusher.join(5)
    assert [r["usd"] for r in json.loads(spool.read_text(encoding="utf-8"))] == [0.5]
    assert col.find_one({"_id": a})[COST_FIELD] == 1.0


def test_after_a_restart_unwritable_costs_still_count_in_the_total(tmp_path: Any) -> None:
    # 다시 시작: DB 합계 69, 파일에 1. 적기는 실패하고 읽기만 됨 → 합계 70(한도에 닿음)
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    col.insert_one({"type": "x", COST_FIELD: 69.0})
    a = col.insert_one({"type": "x"}).inserted_id
    spool = tmp_path / "spool.json"
    spool.write_text(json.dumps([{"job": str(a), "id": "c1", "usd": 1.0}]), encoding="utf-8")
    down = FlakyCol(col, 99)
    assert jobs_module.use_spool(str(spool), down) == 1
    totals = JobStore(down, "w1:spend", lock_sec=60, max_attempts=3, retry_delay_sec=30)  # type: ignore[arg-type]
    assert Spend(totals.claude_spent).total() == pytest.approx(70.0)


def test_after_switching_a_recovered_db_gets_the_queued_cost() -> None:
    # 사용 한도로 넘긴 뒤 DB가 돌아오면, 합계를 다시 읽을 때 모아 둔 비용이 실제로 적힘
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    a = col.insert_one({"type": "x"}).inserted_id
    flaky = FlakyCol(col, 1)
    store = JobStore(flaky, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30)  # type: ignore[arg-type]
    with pytest.raises(AutoReconnect):
        store.add_cost(Job(a, "x", {}, 1), 1.0)
    clock = Clock()
    b = Budgeted(FakeLlm(), FakeLlm, Spend(store.claude_spent, ttl=300, clock=clock), 70.0, {})
    b.exhaust()
    clock.now = 300
    b.over()
    assert col.find_one({"_id": a})[COST_FIELD] == 1.0
    assert store.unwritten_usd() == 0.0


# ---------- Codex 리뷰(5차) #277 ----------


class Timed(PacedLlm):
    """실제 시계로 보낸 시각만 적는 연결."""

    def __init__(self, gap: float) -> None:
        super().__init__(gap_sec=gap, retries=0, sleep=time.sleep, clock=time.monotonic)
        self.sent: list[float] = []

    def _exchange(self, body: JsonObject) -> tuple[int, str | None, str | None]:
        self.sent.append(time.monotonic())
        return 200, None, "{}"


def test_a_slow_budget_read_does_not_shrink_the_gap_between_calls() -> None:
    # 합계를 읽는 한 호출만 느림(Spend: 한 스레드만 DB를 읽고 나머지는 지난 값). 예전에는 차례를
    # 가져간 뒤에 읽어, 그 사이 다음 차례를 받은 호출과 거의 함께 나갔음
    gap = 0.2
    llm = Timed(gap)
    reading = threading.Event()

    def over() -> bool:
        if not reading.is_set():
            reading.set()
            time.sleep(gap)
        return False

    llm.set_gate(over)
    slow = threading.Thread(target=llm._send, args=({},))
    slow.start()
    assert reading.wait(5)
    fast = threading.Thread(target=llm._send, args=({},))
    fast.start()
    slow.join(5)
    fast.join(5)

    assert len(llm.sent) == 2
    assert abs(llm.sent[1] - llm.sent[0]) >= gap * 0.8


def test_a_call_canceled_during_the_budget_read_is_not_sent() -> None:
    llm = Timed(0)
    stop = threading.Event()

    def over() -> bool:
        stop.set()  # 합계를 읽는 동안 작업이 취소됨
        return False

    llm.set_gate(over)
    with stop_on(stop), pytest.raises(LlmError):
        llm._send({})
    assert llm.sent == []


@pytest.mark.parametrize(
    "text",
    [
        "null",
        "{}",
        '"글"',
        "[{}]",
        "[null]",
        '[{"id": "c1", "job": "아이디가 아님", "usd": 1.0}]',
        '[{"id": "c1", "job": "6543210fedcba9876543210f", "usd": "1.0"}]',
        '[{"id": "c1", "job": "6543210fedcba9876543210f", "usd": NaN}]',
        '[{"id": "c1", "job": "6543210fedcba9876543210f", "usd": -1}]',
        '[{"id": 1, "job": "6543210fedcba9876543210f", "usd": 1.0}]',
        '[{"id": "c1", "job": 1, "usd": 1.0}]',
    ],
)
def test_a_spool_file_of_another_shape_does_not_stop_the_worker(tmp_path: Any, text: str) -> None:
    (tmp_path / "s.json").write_text(text, encoding="utf-8")
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    jobs_module._unrecorded.clear()

    assert jobs_module.use_spool(str(tmp_path / "s.json"), col) == 0
    assert jobs_module._unrecorded == {}


def test_good_rows_of_a_partly_broken_spool_file_are_kept(tmp_path: Any) -> None:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    a = col.insert_one({"type": "x"}).inserted_id
    rows = [{}, {"id": "c1", "job": str(a), "usd": 1.5}, None]
    (tmp_path / "s.json").write_text(json.dumps(rows), encoding="utf-8")
    jobs_module._unrecorded.clear()

    assert jobs_module.use_spool(str(tmp_path / "s.json"), col) == 1
    totals = JobStore(col, "w1:spend", lock_sec=60, max_attempts=3, retry_delay_sec=30)
    assert totals.claude_spent() == pytest.approx(1.5)
    assert col.find_one({"_id": a})[COST_FIELD] == 1.5
    assert not (tmp_path / "s.json").exists()  # 다 적으면 버린 줄이 있던 파일도 지움
