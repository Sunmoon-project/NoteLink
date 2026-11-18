import signal
import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import mongomock
import pytest
from pydantic import SecretStr, ValidationError

from app.clients.llm import MODEL_FIELDS
from app.core.config import Settings, settings
from app.worker import __main__ as entry
from app.worker.handlers import BACKGROUND, HANDLERS, HEAVY
from app.worker.jobs import JobStore
from app.worker.runner import Lane


def test_worker_refuses_to_start_without_db_address(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "mongodb_uri", SecretStr(""))
    with pytest.raises(SystemExit, match="MONGODB_URI"):
        entry.main()


def test_worker_with_jobs_refuses_to_start_without_llm_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "mongodb_uri", SecretStr("mongodb://127.0.0.1:27017"))
    monkeypatch.setattr(settings, "llm_provider", "school")
    monkeypatch.setattr(settings, "school_llm_base_url", "")
    monkeypatch.setitem(entry.HANDLERS, "quiz_generate", lambda inp, report: {})
    with pytest.raises(SystemExit, match="SCHOOL_LLM_BASE_URL"):
        entry.main()


def test_worker_with_jobs_refuses_to_start_without_claude_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "mongodb_uri", SecretStr("mongodb://127.0.0.1:27017"))
    monkeypatch.setattr(settings, "llm_provider", "claude")
    monkeypatch.setattr(settings, "anthropic_api_key", SecretStr(""))
    monkeypatch.setitem(entry.HANDLERS, "quiz_generate", lambda inp, report: {})
    with pytest.raises(SystemExit, match="ANTHROPIC_API_KEY"):
        entry.main()


def test_worker_refuses_to_start_when_only_the_split_needs_a_missing_claude_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "mongodb_uri", SecretStr("mongodb://127.0.0.1:27017"))
    monkeypatch.setattr(settings, "llm_provider", "school")
    monkeypatch.setattr(settings, "school_llm_base_url", "https://llm.test")
    for field in MODEL_FIELDS:
        if field != "note_split_model":
            monkeypatch.setattr(settings, field, "gemma-4-26b")
    monkeypatch.setattr(settings, "note_split_provider", "claude")
    monkeypatch.setattr(settings, "anthropic_api_key", SecretStr(""))
    monkeypatch.setitem(entry.HANDLERS, "quiz_generate", lambda inp, report: {})
    with pytest.raises(SystemExit, match="ANTHROPIC_API_KEY"):
        entry.main()


@pytest.fixture
def keep_signal_handlers() -> Iterator[None]:
    saved = {sig: signal.getsignal(sig) for sig in entry.STOP_SIGNALS}
    yield
    for sig, handler in saved.items():
        signal.signal(sig, handler)


@pytest.mark.usefixtures("keep_signal_handlers")
@pytest.mark.parametrize("first", list(entry.STOP_SIGNALS))
def test_first_signal_asks_to_stop_and_the_next_one_ends_at_once(first: signal.Signals) -> None:
    stop = threading.Event()
    entry.stop_on_signal(stop)
    handler = signal.getsignal(first)
    assert callable(handler) and not stop.is_set()
    handler(first, None)
    assert stop.is_set()  # 지금 작업을 끝낸 뒤 멈춤
    assert all(signal.getsignal(sig) == signal.SIG_DFL for sig in entry.STOP_SIGNALS)


T0 = datetime(2026, 11, 18, 9, 0, tzinfo=UTC)


def lanes_on(col: Any, user_lanes: int) -> tuple[list[Lane], list[str]]:
    workers: list[str] = []

    def store(suffix: str) -> JobStore:
        workers.append("w1" + suffix)
        return JobStore(col, workers[-1], lock_sec=60, max_attempts=3, retry_delay_sec=30)

    return entry.make_lanes(store, user_lanes), workers


def test_one_user_lane_is_the_same_as_before() -> None:
    lanes, workers = lanes_on(mongomock.MongoClient(tz_aware=True).db.ai_jobs, 1)
    assert [lane.name for lane in lanes] == ["background", "user"]
    assert workers == ["w1:bg", "w1"]  # 잠금 주인 이름도 그대로(배포 중 처리하던 작업을 이어 봄)
    assert lanes[0].handlers.keys() == BACKGROUND
    assert lanes[1].handlers is HANDLERS and lanes[1].awaited_only == BACKGROUND


def test_extra_user_lanes_take_light_jobs_and_leave_heavy_ones_to_the_first() -> None:
    # 노트 · 녹음 정리는 첫 사용자 반복만: 동시에 하나만 돌아 API와 같이 쓰는 메모리를 지킴(#521)
    lanes, workers = lanes_on(mongomock.MongoClient(tz_aware=True).db.ai_jobs, 3)
    assert [lane.name for lane in lanes] == ["background", "user", "user-2", "user-3"]
    assert len(set(workers)) == len(workers)  # 반복마다 잠금 주인이 다름
    assert HEAVY and HEAVY <= HANDLERS.keys() and not HEAVY & BACKGROUND
    for lane in lanes[2:]:
        assert lane.handlers.keys() == HANDLERS.keys() - HEAVY
        assert lane.awaited_only == BACKGROUND  # 이어받은 미리 만들기는 가져감


def test_an_extra_lane_skips_an_older_heavy_job_for_a_light_one() -> None:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    for i, kind in enumerate(["handwriting_summary", "quiz_generate"]):
        col.insert_one(
            {
                "_id": kind,
                "type": kind,
                "status": "queued",
                "input": {},
                "progress": 0,
                "attempts": 0,
                "createdAt": T0 + timedelta(seconds=i),
            }
        )
    lanes, _ = lanes_on(col, 2)
    first, extra = lanes[1], lanes[2]

    def claim(lane: Lane) -> Any:  # run_once가 가져가는 것과 같게
        kinds = [t for t in lane.handlers if t not in lane.awaited_only]
        return lane.store.claim(kinds, lane.awaited_only)

    assert claim(extra).type == "quiz_generate"  # 먼저 들어온 노트 정리는 건너뜀
    assert claim(first).type == "handwriting_summary"


@pytest.mark.parametrize("value", ["0", "5"])
def test_user_lanes_out_of_range_are_refused(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("AI_JOB_USER_LANES", value)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]
