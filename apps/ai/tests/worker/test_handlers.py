import copy
import threading
from datetime import UTC, datetime
from typing import Any

import mongomock
import pytest

from app.clients.llm import LlmError
from app.worker import handlers
from app.worker.handlers import HANDLERS
from app.worker.jobs import JobStore
from app.worker.runner import JobInputError, run_once
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
    assert "checkpoint" not in doc


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
    assert "checkpoint" not in doc


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


@pytest.mark.parametrize(("kind", "background"), [("quiz_generate", False), ("quiz_pregen", True)])
def test_quiz_generate_and_pregen_are_registered(
    monkeypatch: pytest.MonkeyPatch, kind: str, background: bool
) -> None:
    llm = FakeLlm()
    doc = run_job(monkeypatch, llm, {"day": "2026-11-04"}, kind)
    assert (doc["status"], doc["error"]) == ("failed", "입력 오류: input.material.pages")
    assert llm.backgrounded is background  # 미리 만들기만 LLM 차례를 양보(#138)
    if background:  # 사용자가 이어받았는지는 그 작업의 report로 봄
        assert llm.awaited is not None and llm.awaited() is False


def test_no_questions_fails_with_a_code_and_without_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    # 0문제 결과로 성공하지 않고 코드를 붙여 바로 실패(#175). 일반 입력 오류는 코드 없음
    def fake_run(llm: Any, inp: Any, report: Any) -> dict[str, Any]:
        raise handlers.generate.NoQuestionsError("만든 문제가 없음(검사 탈락)")

    monkeypatch.setattr(handlers, "_llm", lambda: FakeLlm())
    with pytest.raises(JobInputError) as e:
        handlers._handler(fake_run)({}, StubReport(False))
    assert (e.value.code, str(e.value)) == ("NO_QUESTIONS", "만든 문제가 없음(검사 탈락)")


def test_a_canceled_job_sends_no_llm_call(monkeypatch: pytest.MonkeyPatch) -> None:
    # 처리기가 취소를 알아채면(report.canceled) 처리 함수의 호출이 나가지 않음(#263)
    llm = happy_llm()
    report = StubReport(awaited=False)
    report.canceled().set()
    monkeypatch.setattr(handlers, "_llm", lambda: llm)
    with pytest.raises(LlmError):
        handlers.similar_quiz(job_input(), report)
    assert llm.calls == []


def test_only_pregen_runs_in_the_background_lane() -> None:
    assert handlers.BACKGROUND == {"quiz_pregen"}
    assert handlers.BACKGROUND <= HANDLERS.keys()


class StubReport:
    def __init__(self, awaited: bool) -> None:
        self._awaited = awaited
        self._canceled = threading.Event()

    def __call__(self, value: int, step: str | None = None) -> None:
        pass

    def load_checkpoint(self) -> object:
        return None

    def save_checkpoint(self, value: dict[str, Any]) -> None:
        pass

    def awaited(self) -> bool:
        return self._awaited

    def canceled(self) -> threading.Event:
        return self._canceled


@pytest.mark.parametrize(("awaited", "patient"), [(False, True), (True, False)])
def test_a_pregen_taken_over_before_it_starts_gets_the_usual_time_limit(
    monkeypatch: pytest.MonkeyPatch, awaited: bool, patient: bool
) -> None:
    # 이어받은 채 시작하면 사용자가 기다리므로 보통 상한: 사용자 작업 반복을 오래 막지 않게(#138)
    seen: list[bool] = []

    def fake_run(llm: Any, inp: Any, report: Any, *, patient: bool = False) -> dict[str, Any]:
        seen.append(patient)
        return {}

    monkeypatch.setattr(handlers, "_llm", lambda: FakeLlm())
    monkeypatch.setattr(handlers.generate, "run", fake_run)
    handlers.quiz_pregen({}, StubReport(awaited))
    assert seen == [patient]


def test_lanes_starting_together_share_one_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    # 두 반복이 처음 함께 불러도 SchoolLlm은 하나: 호출 간격 · 사용자 우선을 같이 씀(Codex #149)
    import threading
    import time

    made: list[object] = []

    def slow() -> object:
        time.sleep(0.05)  # 만드는 사이 다른 스레드가 들어옴
        made.append(object())
        return made[-1]

    once = handlers._Once(slow)
    got: list[object] = []
    threads = [threading.Thread(target=lambda: got.append(once())) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert len(made) == 1 and got == [made[0], made[0]]
    once.cache_clear()
    assert once() is not made[0]


def test_note_ask_job_saves_the_avatar_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    llm = FakeLlm({"note_ask": [{"answer": "네 가지 조건이 있어요.", "refs": ["교착 상태"]}]})
    inp = {"title": "운영체제", "context": "교착 상태", "history": [], "question": "뭐예요?"}
    doc = run_job(monkeypatch, llm, inp, kind="note_ask")
    assert doc["status"] == "succeeded"
    assert doc["result"] == {"answer": "네 가지 조건이 있어요.", "refs": ["교착 상태"]}
