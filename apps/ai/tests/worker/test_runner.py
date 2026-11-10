import threading
from datetime import UTC, datetime, timedelta
from typing import Any

import mongomock
import pytest
from pymongo.errors import AutoReconnect

from app.clients.llm import JsonObject, LlmError, LlmRejectedError, LlmSetupError
from app.worker import runner
from app.worker.jobs import Job, JobStore
from app.worker.runner import (
    Handler,
    JobInputError,
    JobReport,
    Lane,
    Report,
    run_forever,
    run_lanes,
    run_once,
)

T0 = datetime(2026, 10, 28, 9, 0, tzinfo=UTC)


@pytest.fixture
def col() -> Any:
    c = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    c.insert_one(
        {
            "_id": "j1",
            "type": "quiz_generate",
            "status": "queued",
            "input": {"materialId": "m1", "count": 2},
            "progress": 0,
            "attempts": 0,
            "result": None,
            "error": None,
            "createdAt": T0,
        }
    )
    return c


def store(col: Any) -> JobStore:
    return JobStore(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: T0)


def run(col: Any, handler: Handler) -> dict[str, Any]:
    assert run_once(store(col), {"quiz_generate": handler})
    doc: dict[str, Any] = col.find_one({"_id": "j1"})
    return doc


def test_handler_gets_input_reports_progress_and_result_is_saved(col: Any) -> None:
    seen: list[JsonObject] = []

    def handler(inp: JsonObject, report: Report) -> JsonObject:
        seen.append(inp)
        report(50, "문제 만드는 중")
        assert col.find_one({"_id": "j1"})["step"] == "문제 만드는 중"
        return {"questions": inp["count"]}

    doc = run(col, handler)
    assert seen == [{"materialId": "m1", "count": 2}]
    assert (doc["status"], doc["result"], doc["progress"]) == ("succeeded", {"questions": 2}, 100)


def lane_store(col: Any, worker: str) -> JobStore:
    return JobStore(col, worker, lock_sec=60, max_attempts=3, retry_delay_sec=30)


def test_a_user_job_starts_while_a_pregen_is_running(col: Any) -> None:
    # 미리 만들기(p1)가 먼저 들어와 처리 중: j1은 그 작업이 끝나기를 기다리지 않고 시작(#138)
    col.insert_one(
        {
            **col.find_one({"_id": "j1"}),
            "_id": "p1",
            "type": "quiz_pregen",
            "createdAt": T0 - timedelta(minutes=5),
        }
    )
    pregen_started, user_done, stop = threading.Event(), threading.Event(), threading.Event()

    def pregen(inp: JsonObject, report: Report) -> JsonObject:
        pregen_started.set()
        assert user_done.wait(5), "사용자 작업이 미리 만들기 뒤로 밀림"
        return {"pregen": True}

    def user(inp: JsonObject, report: Report) -> JsonObject:
        assert pregen_started.wait(5)
        user_done.set()
        return {"user": True}

    def stop_when_both_done() -> None:
        while col.count_documents({"status": "succeeded"}) < 2:
            if stop.wait(0.01):
                return
        stop.set()

    watcher = threading.Thread(target=stop_when_both_done, daemon=True)
    watcher.start()
    lanes = [
        Lane("background", lane_store(col, "w1:bg"), {"quiz_pregen": pregen}),
        Lane("user", lane_store(col, "w1"), {"quiz_generate": user}),
    ]
    run_lanes(lanes, poll_sec=0.01, stop=stop)
    watcher.join(5)
    assert col.find_one({"_id": "j1"})["result"] == {"user": True}
    assert col.find_one({"_id": "p1"})["result"] == {"pregen": True}
    assert (col.find_one({"_id": "p1"})["lockedBy"], col.find_one({"_id": "j1"})["lockedBy"]) == (
        None,
        None,
    )


def test_a_lane_that_breaks_stops_the_others_and_raises(col: Any) -> None:
    class Broken(JobStore):
        def claim(self, types: Any, awaited_types: Any = ()) -> Any:
            raise RuntimeError("고장")

    stop = threading.Event()
    lanes = [
        Lane(
            "background",
            Broken(col, "w1:bg", lock_sec=60, max_attempts=3, retry_delay_sec=30),
            {"quiz_pregen": lambda inp, report: {}},
        ),
        Lane("user", lane_store(col, "w1"), {"quiz_generate": lambda inp, report: {}}),
    ]
    with pytest.raises(RuntimeError, match="고장"):
        run_lanes(lanes, poll_sec=0.01, stop=stop)
    assert stop.is_set()


def test_no_lane_with_handlers_waits_for_the_stop(col: Any) -> None:
    stop = threading.Event()
    threading.Timer(0.05, stop.set).start()
    run_lanes([Lane("background", store(col), {})], poll_sec=0.01, stop=stop)
    assert stop.is_set()


def test_nothing_to_do_returns_false(col: Any) -> None:
    assert not run_once(store(col), {"explain": lambda inp, report: {}})


def test_llm_error_is_retried_later(col: Any) -> None:
    def handler(inp: JsonObject, report: Report) -> JsonObject:
        raise LlmError("HTTP 503")

    doc = run(col, handler)
    assert (doc["status"], doc["error"]) == ("queued", "AI 응답을 받지 못함(HTTP 503)")


def test_a_setup_error_from_the_server_is_retried_later(col: Any) -> None:
    # 게이트웨이가 잠깐 403 · 404를 줄 수도 있어 시도 한도 안에서 다시(#262)
    def handler(inp: JsonObject, report: Report) -> JsonObject:
        raise LlmSetupError("HTTP 401")

    doc = run(col, handler)
    assert (doc["status"], doc["error"]) == ("queued", "AI 설정 오류(HTTP 401)")


def test_a_missing_setting_fails_without_retry(col: Any) -> None:
    def handler(inp: JsonObject, report: Report) -> JsonObject:
        raise LlmSetupError("SCHOOL_LLM_BASE_URL이 비어 있음", retry=False)

    doc = run(col, handler)
    assert (doc["status"], doc["error"]) == (
        "failed",
        "AI 설정 오류(SCHOOL_LLM_BASE_URL이 비어 있음)",
    )


def test_a_rejected_request_fails_without_retry(col: Any) -> None:
    # 같은 요청을 다시 보내도 같음: 작업을 다시 넣지 않음(/code-review #262)
    def handler(inp: JsonObject, report: Report) -> JsonObject:
        raise LlmRejectedError("HTTP 413")

    doc = run(col, handler)
    assert (doc["status"], doc["error"]) == ("failed", "AI가 요청을 거절함(HTTP 413)")


def test_bad_input_fails_without_retry(col: Any) -> None:
    def handler(inp: JsonObject, report: Report) -> JsonObject:
        raise JobInputError("questions 없음")

    doc = run(col, handler)
    assert (doc["status"], doc["error"]) == ("failed", "입력 오류: questions 없음")


def test_input_error_with_code_starts_with_the_code(col: Any) -> None:
    def handler(inp: JsonObject, report: Report) -> JsonObject:
        raise JobInputError("녹음이 너무 김", code="INVALID_FILE")

    doc = run(col, handler)
    assert (doc["status"], doc["error"], doc["attempts"]) == (
        "failed",
        "INVALID_FILE: 녹음이 너무 김",
        1,
    )


def test_input_that_is_not_an_object_fails(col: Any) -> None:
    col.update_one({"_id": "j1"}, {"$set": {"input": None}})
    called: list[bool] = []

    def handler(inp: JsonObject, report: Report) -> JsonObject:
        called.append(True)
        return {}

    doc = run(col, handler)
    assert (doc["status"], doc["error"]) == ("failed", "입력 오류: input이 객체가 아님")
    assert called == []


def test_code_error_fails_without_details_in_the_job(col: Any) -> None:
    def handler(inp: JsonObject, report: Report) -> JsonObject:
        raise KeyError("secret-looking detail")

    doc = run(col, handler)
    assert (doc["status"], doc["error"]) == ("failed", "처리 중 오류")


def test_canceled_while_running_discards_the_result(col: Any) -> None:
    def handler(inp: JsonObject, report: Report) -> JsonObject:
        col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})  # 앱에서 취소
        return {"questions": 2}

    doc = run(col, handler)
    assert (doc["status"], doc["result"]) == ("canceled", None)


def test_canceled_job_stops_at_the_next_progress_report(col: Any) -> None:
    steps: list[int] = []

    def handler(inp: JsonObject, report: Report) -> JsonObject:
        for p in (10, 20, 30):
            if p == 20:
                col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})
            report(p)
            steps.append(p)
        return {}

    doc = run(col, handler)
    assert steps == [10]
    assert doc["status"] == "canceled"


def test_canceled_while_failing_is_left_canceled(col: Any) -> None:
    def handler(inp: JsonObject, report: Report) -> JsonObject:
        col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})
        raise LlmError("HTTP 503")

    doc = run(col, handler)
    assert (doc["status"], doc["error"]) == ("canceled", None)


@pytest.mark.parametrize("broken", ["progress", "succeed"])
def test_db_error_while_running_is_retried_after_the_lock_ends(col: Any, broken: str) -> None:
    now = [T0]
    drops = [broken]

    class Flaky(JobStore):
        def progress(self, job: Any, value: int, step: str | None = None) -> None:
            if "progress" in drops:
                drops.clear()
                raise AutoReconnect("연결 끊김")
            super().progress(job, value, step)

        def succeed(self, job: Any, result: JsonObject) -> None:
            if "succeed" in drops:
                drops.clear()
                raise AutoReconnect("연결 끊김")
            super().succeed(job, result)

    s = Flaky(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: now[0])

    def handler(inp: JsonObject, report: Report) -> JsonObject:
        report(50)
        return {"questions": 2}

    with pytest.raises(AutoReconnect):
        run_once(s, {"quiz_generate": handler})
    doc = col.find_one({"_id": "j1"})
    assert (doc["status"], doc["error"]) == ("running", None)  # 실패로 쓰지 않음
    assert not run_once(s, {"quiz_generate": handler})  # 잠금이 남아 있는 동안은 안 가져감
    now[0] += timedelta(seconds=61)
    assert run_once(s, {"quiz_generate": handler})
    doc = col.find_one({"_id": "j1"})
    assert (doc["status"], doc["result"], doc["attempts"]) == ("succeeded", {"questions": 2}, 2)


def test_handler_gets_back_what_it_saved_on_the_next_attempt(col: Any) -> None:
    now = [T0]
    s = JobStore(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: now[0])
    loaded: list[object] = []

    def handler(inp: JsonObject, report: JobReport) -> JsonObject:
        loaded.append(report.load_checkpoint())
        if len(loaded) == 1:
            report.save_checkpoint({"step": "stt"})
            raise LlmError("HTTP 503")
        return {"ok": True}

    assert run_once(s, {"quiz_generate": handler})
    assert col.find_one({"_id": "j1"})["checkpoint"] == {"step": "stt"}
    now[0] += timedelta(seconds=31)
    assert run_once(s, {"quiz_generate": handler})
    doc = col.find_one({"_id": "j1"})
    assert loaded == [None, {"step": "stt"}]
    assert doc["status"] == "succeeded"
    assert "checkpoint" not in doc


def test_canceled_while_saving_a_checkpoint_stops_the_handler(col: Any) -> None:
    after: list[bool] = []

    def handler(inp: JsonObject, report: JobReport) -> JsonObject:
        col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})
        report.save_checkpoint({"step": "stt"})
        after.append(True)
        return {}

    doc = run(col, handler)
    assert after == []
    assert doc["status"] == "canceled"
    assert "checkpoint" not in doc


def test_heartbeat_extends_lock_while_handler_is_quiet(col: Any) -> None:
    touched = threading.Event()

    class Counting(JobStore):
        def touch(self, job: Any) -> None:
            super().touch(job)
            touched.set()

    s = Counting(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: T0)

    def handler(inp: JsonObject, report: Report) -> JsonObject:
        assert touched.wait(2)  # 진행률을 쓰지 않는 긴 LLM 호출 동안
        return {"ok": True}

    assert run_once(s, {"quiz_generate": handler}, heartbeat_sec=0.01)
    assert col.find_one({"_id": "j1"})["status"] == "succeeded"


@pytest.fixture
def quick_cancel_check(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner, "CANCEL_CHECK_SEC", 0.01)


@pytest.mark.usefixtures("quick_cancel_check")
def test_a_cancel_is_noticed_while_the_handler_is_quiet_and_the_lock_is_released(
    col: Any,
) -> None:
    # 잠금 연장(기본 300초)을 기다리지 않고 몇 초 안에 알아채 처리 함수에 알림(#263)
    noticed: list[bool] = []

    def handler(inp: JsonObject, report: JobReport) -> JsonObject:
        col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})  # 앱에서 취소
        noticed.append(report.canceled().wait(2))
        return {"late": True}

    assert run_once(store(col), {"quiz_generate": handler}, heartbeat_sec=60)
    doc = col.find_one({"_id": "j1"})
    assert noticed == [True]
    # 결과는 버리고, 처리 함수가 끝났으니 잠금을 풂: '다시 시도'가 바로 됨
    assert (doc["status"], doc["result"], doc["lockedBy"], doc["lockedUntil"]) == (
        "canceled",
        None,
        None,
        None,
    )


@pytest.mark.usefixtures("quick_cancel_check")
def test_a_cancel_seen_while_failing_also_releases_the_lock(col: Any) -> None:
    def handler(inp: JsonObject, report: JobReport) -> JsonObject:
        col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})
        report.canceled().wait(2)
        raise LlmError("멈춤(작업이 취소됨)")

    doc = run(col, handler)
    assert (doc["status"], doc["error"], doc["lockedBy"]) == ("canceled", None, None)


@pytest.mark.usefixtures("quick_cancel_check")
def test_a_job_that_is_not_canceled_is_not_signaled(col: Any) -> None:
    def handler(inp: JsonObject, report: JobReport) -> JsonObject:
        assert not report.canceled().wait(0.1)  # 상태를 여러 번 읽는 동안
        return {"ok": True}

    doc = run(col, handler)
    assert (doc["status"], doc["result"]) == ("succeeded", {"ok": True})


@pytest.mark.usefixtures("quick_cancel_check")
def test_a_job_taken_by_another_worker_is_signaled_but_left_locked(col: Any) -> None:
    def handler(inp: JsonObject, report: JobReport) -> JsonObject:
        col.update_one({"_id": "j1"}, {"$set": {"lockedBy": "w2"}})  # 잠금이 끝나 w2가 가져감
        assert report.canceled().wait(2)
        return {"late": True}

    doc = run(col, handler)
    assert (doc["status"], doc["lockedBy"]) == ("running", "w2")


def test_run_forever_keeps_going_after_db_error_and_stops_on_request(col: Any) -> None:
    stop = threading.Event()
    calls: list[str] = []

    class FlakyStore(JobStore):
        def claim(self, types: Any, awaited_types: Any = ()) -> Any:
            calls.append("claim")
            if len(calls) == 1:
                raise AutoReconnect("연결 끊김")
            stop.set()
            return super().claim(types, awaited_types)

    flaky = FlakyStore(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: T0)
    run_forever(flaky, {"quiz_generate": lambda inp, report: {"ok": True}}, poll_sec=0, stop=stop)
    assert calls == ["claim", "claim"]
    assert col.find_one({"_id": "j1"})["status"] == "succeeded"


class AwaitedStore(JobStore):
    def __init__(self, col: Any, answers: list[Any]) -> None:
        super().__init__(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30)
        self.answers, self.reads = answers, 0

    def awaited(self, job: Job) -> bool:
        self.reads += 1
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return bool(a)


def test_report_reads_awaited_at_most_every_few_seconds_and_keeps_it(col: Any) -> None:
    now = [0.0]
    s = AwaitedStore(col, [False, AutoReconnect("끊김"), True])
    report = runner._StoreReport(s, Job("j1", "quiz_pregen", {}, 1), clock=lambda: now[0])
    assert report.awaited() is False and s.reads == 0  # 막 가져온 작업은 가져올 때 값(False)
    now[0] += runner.AWAITED_CHECK_SEC
    assert report.awaited() is False and s.reads == 1
    assert report.awaited() is False and s.reads == 1  # 간격 안에서는 다시 읽지 않음
    now[0] += runner.AWAITED_CHECK_SEC
    assert report.awaited() is False and s.reads == 2  # 못 읽으면 지난 값
    now[0] += runner.AWAITED_CHECK_SEC
    assert report.awaited() is True and s.reads == 3
    now[0] += runner.AWAITED_CHECK_SEC
    assert report.awaited() is True and s.reads == 3  # 한 번 참이면 더 읽지 않음


def test_report_of_a_job_taken_over_before_it_started_is_awaited(col: Any) -> None:
    s = AwaitedStore(col, [])
    report = runner._StoreReport(s, Job("j1", "quiz_pregen", {}, 1, awaited=True))
    assert report.awaited() is True and s.reads == 0


def test_the_user_lane_runs_a_taken_over_pregen(col: Any) -> None:
    col.update_one({"_id": "j1"}, {"$set": {"type": "quiz_pregen", "awaited": True}})
    seen: list[bool] = []

    def handler(inp: JsonObject, report: JobReport) -> JsonObject:
        seen.append(report.awaited())
        return {}

    s = store(col)
    assert run_once(s, {"quiz_pregen": handler}, awaited_only={"quiz_pregen"})
    assert seen == [True] and col.find_one({"_id": "j1"})["status"] == "succeeded"


def test_report_does_not_wait_while_another_thread_reads_awaited(col: Any) -> None:
    # DB가 느려도 다른 퀴즈 자리 스레드는 기다리지 않고 지난 값(/code-review #138)
    now = [0.0]
    s = AwaitedStore(col, [True])
    report = runner._StoreReport(s, Job("j1", "quiz_pregen", {}, 1), clock=lambda: now[0])
    now[0] += runner.AWAITED_CHECK_SEC
    with report._lock:  # 다른 스레드가 읽는 중
        assert report.awaited() is False and s.reads == 0
    assert report.awaited() is True and s.reads == 1
