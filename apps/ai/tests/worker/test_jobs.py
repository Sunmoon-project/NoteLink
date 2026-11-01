from datetime import UTC, datetime, timedelta
from typing import Any

import mongomock
import pytest

from app.worker.jobs import JobGoneError, JobStore

T0 = datetime(2026, 10, 28, 9, 0, tzinfo=UTC)


class Clock:
    def __init__(self) -> None:
        self.t = T0

    def __call__(self) -> datetime:
        return self.t

    def tick(self, sec: float) -> None:
        self.t += timedelta(seconds=sec)


@pytest.fixture
def col() -> Any:
    return mongomock.MongoClient(tz_aware=True).db.ai_jobs


@pytest.fixture
def clock() -> Clock:
    return Clock()


def store(col: Any, clock: Clock, worker: str = "w1") -> JobStore:
    return JobStore(col, worker, lock_sec=60, max_attempts=3, retry_delay_sec=30, now=clock)


def add(col: Any, _id: str, type_: str = "quiz_generate", age_sec: int = 0, **extra: Any) -> None:
    """NestJS가 넣는 모양의 작업."""
    doc = {
        "_id": _id,
        "type": type_,
        "status": "queued",
        "targetType": "material",
        "targetId": "m1",
        "input": {"n": 1},
        "progress": 0,
        "attempts": 0,
        "result": None,
        "error": None,
        "createdAt": T0 - timedelta(seconds=age_sec),
    }
    col.insert_one({**doc, **extra})


# ---------- 가져오기 ----------


def test_claim_takes_oldest_job_of_registered_types(col: Any, clock: Clock) -> None:
    add(col, "new", age_sec=1)
    add(col, "old", age_sec=9)
    add(col, "other", "explain", age_sec=99)  # 처리 함수가 없는 종류
    job = store(col, clock).claim(["quiz_generate"])
    assert job is not None
    assert (job.id, job.type, job.input, job.attempts) == ("old", "quiz_generate", {"n": 1}, 1)
    doc = col.find_one({"_id": "old"})
    assert doc["status"] == "running"
    assert doc["lockedBy"] == "w1"
    assert doc["lockedUntil"] == T0 + timedelta(seconds=60)
    assert col.find_one({"_id": "other"})["status"] == "queued"


def test_two_workers_never_take_the_same_job(col: Any, clock: Clock) -> None:
    add(col, "j1")
    first = store(col, clock, "w1").claim(["quiz_generate"])
    second = store(col, clock, "w2").claim(["quiz_generate"])
    assert first is not None and first.id == "j1"
    assert second is None


def test_no_types_or_no_jobs_claims_nothing(col: Any, clock: Clock) -> None:
    assert store(col, clock).claim(["quiz_generate"]) is None
    add(col, "j1")
    assert store(col, clock).claim([]) is None


def test_stalled_job_is_taken_again_after_its_lock_ends(col: Any, clock: Clock) -> None:
    add(col, "j1")
    store(col, clock, "w1").claim(["quiz_generate"])  # w1이 멈춤
    assert store(col, clock, "w2").claim(["quiz_generate"]) is None
    clock.tick(61)
    job = store(col, clock, "w2").claim(["quiz_generate"])
    assert job is not None and job.attempts == 2
    assert col.find_one({"_id": "j1"})["lockedBy"] == "w2"


def test_taking_a_stalled_job_again_clears_the_old_progress(col: Any, clock: Clock) -> None:
    add(col, "j1")
    w1 = store(col, clock, "w1")
    job = w1.claim(["quiz_generate"])
    assert job is not None
    w1.progress(job, 80, "검사")  # 여기서 w1이 멈춤
    clock.tick(61)
    store(col, clock, "w2").claim(["quiz_generate"])
    doc = col.find_one({"_id": "j1"})
    assert doc["progress"] == 0
    assert "step" not in doc


def test_stalled_jobs_are_given_up_once_a_minute_not_on_every_poll(col: Any, clock: Clock) -> None:
    s = store(col, clock)
    assert s.claim(["quiz_generate"]) is None  # 첫 가져오기에서 정리
    add(col, "j1", status="running", attempts=3, lockedBy="w0", lockedUntil=T0 - timedelta(1))
    clock.tick(30)
    assert s.claim(["quiz_generate"]) is None
    assert col.find_one({"_id": "j1"})["status"] == "running"
    clock.tick(30)
    assert s.claim(["quiz_generate"]) is None
    assert col.find_one({"_id": "j1"})["status"] == "failed"


def test_canceled_job_put_back_by_nestjs_is_taken_at_once(col: Any, clock: Clock) -> None:
    add(col, "j1")
    s = store(col, clock)
    assert s.claim(["quiz_generate"]) is not None
    col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})  # 잠금 시간이 남은 채 취소
    col.update_one({"_id": "j1"}, {"$set": {"status": "queued", "attempts": 0}})  # 앱의 다시 시도
    job = store(col, clock, "w2").claim(["quiz_generate"])
    assert job is not None and job.attempts == 1


def test_job_stalled_up_to_the_limit_fails(col: Any, clock: Clock) -> None:
    add(col, "j1", status="running", attempts=3, lockedBy="w0", lockedUntil=T0 - timedelta(1))
    assert store(col, clock).claim(["quiz_generate"]) is None
    doc = col.find_one({"_id": "j1"})
    assert doc["status"] == "failed"
    assert doc["error"] == "처리가 끝나지 않음(시도 한도)"
    assert doc["lockedBy"] is None


def test_canceled_and_finished_jobs_are_not_taken(col: Any, clock: Clock) -> None:
    add(col, "c", status="canceled")
    add(col, "s", status="succeeded")
    add(col, "f", status="failed")
    assert store(col, clock).claim(["quiz_generate"]) is None


# ---------- 진행률 · 완료 ----------


def test_touch_extends_lock_and_stops_when_canceled(col: Any, clock: Clock) -> None:
    add(col, "j1")
    s = store(col, clock)
    job = s.claim(["quiz_generate"])
    assert job is not None
    clock.tick(40)
    s.touch(job)
    assert col.find_one({"_id": "j1"})["lockedUntil"] == T0 + timedelta(seconds=100)
    col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})
    with pytest.raises(JobGoneError):
        s.touch(job)


def test_progress_writes_value_and_step_and_extends_lock(col: Any, clock: Clock) -> None:
    add(col, "j1")
    s = store(col, clock)
    job = s.claim(["quiz_generate"])
    assert job is not None
    clock.tick(50)
    s.progress(job, 140, "문제 만드는 중")
    doc = col.find_one({"_id": "j1"})
    assert (doc["progress"], doc["step"]) == (100, "문제 만드는 중")
    assert doc["lockedUntil"] == T0 + timedelta(seconds=110)
    s.progress(job, -5)  # 단계 없이 진행률만
    doc = col.find_one({"_id": "j1"})
    assert (doc["progress"], doc["step"]) == (0, "문제 만드는 중")


def test_succeed_writes_result_and_releases_lock(col: Any, clock: Clock) -> None:
    add(col, "j1")
    s = store(col, clock)
    job = s.claim(["quiz_generate"])
    assert job is not None
    s.progress(job, 40, "검수 중")
    s.succeed(job, {"questions": [1, 2]})
    doc = col.find_one({"_id": "j1"})
    assert doc["status"] == "succeeded"
    assert (doc["progress"], doc["result"], doc["error"]) == (100, {"questions": [1, 2]}, None)
    assert (doc["lockedBy"], doc["lockedUntil"]) == (None, None)
    assert "step" not in doc  # 공용 스키마: step은 없거나 문자열


def test_canceled_job_is_not_written(col: Any, clock: Clock) -> None:
    add(col, "j1")
    s = store(col, clock)
    job = s.claim(["quiz_generate"])
    assert job is not None
    col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})  # 앱에서 취소
    with pytest.raises(JobGoneError):
        s.progress(job, 50)
    with pytest.raises(JobGoneError):
        s.succeed(job, {"x": 1})
    doc = col.find_one({"_id": "j1"})
    assert (doc["status"], doc["result"]) == ("canceled", None)


def test_worker_that_lost_its_lock_cannot_write(col: Any, clock: Clock) -> None:
    add(col, "j1")
    slow = store(col, clock, "w1")
    job = slow.claim(["quiz_generate"])
    assert job is not None
    clock.tick(61)
    store(col, clock, "w2").claim(["quiz_generate"])
    with pytest.raises(JobGoneError):
        slow.succeed(job, {"late": True})
    assert col.find_one({"_id": "j1"})["lockedBy"] == "w2"


# ---------- 실패 · 다시 시도 ----------


def test_retry_requeues_with_growing_wait_until_the_limit(col: Any, clock: Clock) -> None:
    add(col, "j1")
    s = store(col, clock)
    for attempt in (1, 2):
        job = s.claim(["quiz_generate"])
        assert job is not None and job.attempts == attempt
        s.progress(job, 30, "문제 만드는 중")
        assert s.fail(job, "AI 응답을 받지 못함(HTTP 503)", retry=True) == "queued"
        doc = col.find_one({"_id": "j1"})
        assert (doc["progress"], doc["error"]) == (0, "AI 응답을 받지 못함(HTTP 503)")
        assert "step" not in doc
        wait = 30 * attempt
        assert (doc["lockedUntil"], doc["retryAt"]) == (None, clock() + timedelta(seconds=wait))
        clock.tick(wait - 1)
        assert s.claim(["quiz_generate"]) is None  # 기다리는 중
        clock.tick(1)
    job = s.claim(["quiz_generate"])
    assert job is not None and job.attempts == 3
    assert col.find_one({"_id": "j1"})["error"] is None  # 다시 가져가면 지난 오류를 지움
    assert s.fail(job, "AI 응답을 받지 못함(JSON)", retry=True) == "failed"
    doc = col.find_one({"_id": "j1"})
    assert (doc["status"], doc["lockedUntil"], doc["retryAt"]) == ("failed", None, None)


def test_fail_without_retry_ends_at_once_keeping_progress(col: Any, clock: Clock) -> None:
    add(col, "j1")
    s = store(col, clock)
    job = s.claim(["quiz_generate"])
    assert job is not None
    s.progress(job, 60)
    assert s.fail(job, "입력 오류: questions 없음", retry=False) == "failed"
    doc = col.find_one({"_id": "j1"})
    assert (doc["status"], doc["progress"], doc["attempts"]) == ("failed", 60, 1)
