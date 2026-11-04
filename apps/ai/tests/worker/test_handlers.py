import copy
from datetime import UTC, datetime
from typing import Any

import mongomock
import pytest

from app.clients.llm import LlmError
from app.worker import handlers
from app.worker.handlers import HANDLERS
from app.worker.jobs import JobStore
from app.worker.runner import run_once
from tests.fakes import FakeLlm
from tests.services.quiz.test_review import happy_llm, job_input

T0 = datetime(2026, 10, 29, 7, 0, tzinfo=UTC)


def run_job(
    monkeypatch: pytest.MonkeyPatch, llm: FakeLlm, inp: dict[str, Any], kind: str = "similar_quiz"
) -> dict[str, Any]:
    monkeypatch.setattr(handlers, "_llm", lambda: llm)
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    col.insert_one(
        {
            "_id": "j1",
            "type": kind,
            "status": "queued",
            "input": inp,
            "progress": 0,
            "attempts": 0,
            "result": None,
            "error": None,
            "createdAt": T0,
        }
    )
    store = JobStore(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: T0)
    assert run_once(store, HANDLERS)
    doc: dict[str, Any] = col.find_one({"_id": "j1"})
    return doc


def test_similar_quiz_job_is_processed_and_its_result_saved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    doc = run_job(monkeypatch, happy_llm(), job_input())
    assert (doc["status"], doc["progress"], doc["error"]) == ("succeeded", 100, None)
    assert [x["answer"] for x in doc["result"]["reviewQuestions"]] == ["stack", "be"]


def test_bad_similar_quiz_input_fails_without_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    inp = copy.deepcopy(job_input())
    inp["sets"] = []
    llm = FakeLlm()
    doc = run_job(monkeypatch, llm, inp)
    assert (doc["status"], doc["error"]) == ("failed", "입력 오류: input.sets에 이번 세트가 없음")
    assert doc["attempts"] == 1 and not llm.calls  # 다시 넣지 않고, LLM도 부르지 않음


def test_similar_quiz_job_is_retried_later_when_the_llm_is_down(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    doc = run_job(monkeypatch, FakeLlm({"Review": [LlmError("HTTP 503")] * 6}), job_input())
    assert (doc["status"], doc["attempts"], doc["result"]) == ("queued", 1, None)
    assert doc["error"] == "AI 응답을 받지 못함(문제 만들기 호출이 모두 실패)"
    assert doc["retryAt"] > T0  # 기다렸다가 다시 가져감


def test_today_review_job_is_processed_and_its_result_saved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    due = datetime(2026, 10, 29, 15)  # 서울 10/30 0시
    srs = {
        "step": 0,
        "dueAt": due,
        "lastResult": "wrong",
        "streak": 0,
        "reviews": 1,
        "state": "active",
        "checked": True,
    }
    question = {
        "id": "q1",
        "order": 1,
        "prompt": "쌓다는?",
        "answer": "stack",
        "choices": ["stack", "fasten", "request", "inform", "order"],
        "srs": srs,
    }
    inp = {
        "day": "2026-10-30",
        "sets": [{"id": "s1", "materialId": "m1", "questions": [question]}],
        "attempts": [],
        "notes": {},
    }
    doc = run_job(monkeypatch, FakeLlm(), inp, "today_review")
    assert (doc["status"], doc["error"]) == ("succeeded", None)
    assert [x["answer"] for x in doc["result"]["questions"]] == ["stack"]


def test_bad_today_review_input_fails_without_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    doc = run_job(monkeypatch, FakeLlm(), {"day": "오늘"}, "today_review")
    assert (doc["status"], doc["error"]) == ("failed", "입력 오류: input.day")
