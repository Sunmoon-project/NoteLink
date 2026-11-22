import signal
import threading
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import mongomock
import pytest
from pydantic import SecretStr, ValidationError

from app.clients.llm import MODEL_FIELDS, JsonObject
from app.core.config import Settings, settings
from app.worker import __main__ as entry
from app.worker.handlers import BACKGROUND, HANDLERS, HEAVY
from app.worker.jobs import JobStore
from app.worker.runner import Handler, JobReport, Lane, run_once


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


def lanes_on(col: Any, user_lanes: int, heavy_lanes: int = 1) -> tuple[list[Lane], list[str]]:
    workers: list[str] = []

    def store(suffix: str) -> JobStore:
        workers.append("w1" + suffix)
        return JobStore(col, workers[-1], lock_sec=60, max_attempts=3, retry_delay_sec=30)

    return entry.make_lanes(store, user_lanes, heavy_lanes), workers


def test_one_user_lane_is_the_same_as_before() -> None:
    lanes, workers = lanes_on(mongomock.MongoClient(tz_aware=True).db.ai_jobs, 1)
    assert [lane.name for lane in lanes] == ["background", "user"]
    assert workers == ["w1:bg", "w1"]  # AI_JOB_USER_LANES=1이면 #521 전과 같은 구성
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


def test_heavy_jobs_go_first_to_the_first_lane_and_light_ones_to_the_others() -> None:
    # 가벼운 작업 둘 뒤에 노트 정리가 들어옴: 첫 반복은 노트 정리를 먼저, 늘린 반복은 가벼운 작업
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    for i, (job_id, kind) in enumerate(
        [("q1", "quiz_generate"), ("q2", "note_ask"), ("h1", "handwriting_summary")]
    ):
        col.insert_one(
            {
                "_id": job_id,
                "type": kind,
                "status": "queued",
                "input": {},
                "progress": 0,
                "attempts": 0,
                "createdAt": T0 + timedelta(seconds=i),
            }
        )
    _, first, extra = lanes_on(col, 2)[0]
    done: list[tuple[str, str]] = []

    def fake(lane: Lane, kind: str) -> Handler:
        def handle(inp: JsonObject, report: JobReport) -> JsonObject:
            done.append((lane.name, kind))
            return {}

        return handle

    def run(lane: Lane) -> None:  # 처리 함수만 바꾸고 가져가기는 runner 그대로
        handlers = {t: fake(lane, t) for t in lane.handlers}
        assert run_once(lane.store, handlers, awaited_only=lane.awaited_only, first=lane.first)

    run(first)
    run(extra)
    assert done == [("user", "handwriting_summary"), ("user-2", "quiz_generate")]


@pytest.mark.parametrize("value", ["0", "5"])
def test_user_lanes_out_of_range_are_refused(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("AI_JOB_USER_LANES", value)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


@pytest.mark.parametrize("value", ["0", "3"])
def test_heavy_lanes_out_of_range_are_refused(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setenv("AI_JOB_HEAVY_LANES", value)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)  # type: ignore[call-arg]


def test_heavy_lanes_default_to_one() -> None:
    assert Settings(_env_file=None).ai_job_heavy_lanes == 1  # type: ignore[call-arg]


def test_two_heavy_lanes_take_heavy_jobs_first_and_the_rest_stay_light() -> None:
    lanes, _ = lanes_on(mongomock.MongoClient(tz_aware=True).db.ai_jobs, 4, 2)
    assert [lane.name for lane in lanes] == ["background", "user", "user-2", "user-3", "user-4"]
    for lane in lanes[1:3]:
        assert lane.handlers.keys() == HANDLERS.keys() and lane.first == HEAVY
    for lane in lanes[3:]:
        assert lane.handlers.keys() == HANDLERS.keys() - HEAVY and not lane.first


def test_heavy_lanes_never_exceed_user_lanes() -> None:
    # 모든 반복이 무거운 종류를 받으면 먼저 가져가지 않음: 가벼운 작업이 그 뒤에서 기다리지 않게
    lanes, _ = lanes_on(mongomock.MongoClient(tz_aware=True).db.ai_jobs, 1, 2)
    assert [lane.name for lane in lanes] == ["background", "user"]
    assert lanes[1].handlers is HANDLERS and not lanes[1].first


def test_two_heavy_lanes_run_two_note_jobs_at_once() -> None:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    for i, job_id in enumerate(["h1", "h2", "q1"]):
        col.insert_one(
            {
                "_id": job_id,
                "type": "quiz_generate" if job_id == "q1" else "handwriting_summary",
                "status": "queued",
                "input": {},
                "progress": 0,
                "attempts": 0,
                "createdAt": T0 + timedelta(seconds=i),
            }
        )
    _, first, second, light = lanes_on(col, 3, 2)[0]
    done: list[tuple[str, str]] = []

    def run(lane: Lane) -> None:
        def fake(kind: str) -> Handler:
            def handle(inp: JsonObject, report: JobReport) -> JsonObject:
                done.append((lane.name, kind))
                return {}

            return handle

        handlers = {t: fake(t) for t in lane.handlers}
        assert run_once(lane.store, handlers, awaited_only=lane.awaited_only, first=lane.first)

    run(first)
    run(second)
    run(light)
    assert done == [
        ("user", "handwriting_summary"),
        ("user-2", "handwriting_summary"),
        ("user-3", "quiz_generate"),
    ]


def test_the_background_lane_takes_a_pregen_before_older_card_jobs() -> None:
    # 개념 카드 작업(#558)은 퀴즈마다 생겨 쌓일 수 있음: 새 노트의 미리 만들기가 그 뒤에서
    # 기다리지 않게
    col = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    for i, kind in enumerate(["quiz_flashcards", "quiz_flashcards", "quiz_pregen"]):
        col.insert_one(
            {
                "type": kind,
                "status": "queued",
                "input": {},
                "progress": 0,
                "attempts": 0,
                "createdAt": T0 + timedelta(seconds=i),
            }
        )
    background = lanes_on(col, 1)[0][0]
    done: list[str] = []

    def fake(kind: str) -> Handler:
        def handle(inp: JsonObject, report: JobReport) -> JsonObject:
            done.append(kind)
            return {}

        return handle

    handlers = {t: fake(t) for t in background.handlers}
    for _ in range(3):
        assert run_once(background.store, handlers, first=background.first)
    assert done == ["quiz_pregen", "quiz_flashcards", "quiz_flashcards"]
