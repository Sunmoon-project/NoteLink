import copy
import logging
import re
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any

import mongomock
import pytest
from pymongo.errors import AutoReconnect

from app.clients.llm import JsonObject, LlmError, LlmRejectedError
from app.services.quiz import review
from app.worker.jobs import JobStore
from app.worker.runner import run_once
from tests.fakes import FakeLlm

PAGE = """요청 동사 뒤에는 동사원형을 쓴다
request that he be informed
쌓다 = stack
# stock
fasten - 고정하다"""
DONE = datetime(2026, 10, 29, 6, 30)  # UTC = 서울 10/29 15:30
TODAY = datetime(2026, 10, 28, 15)  # 서울 10/29 0시를 UTC로


def q(qid: str, order: int, answer: str, concept: str, **more: Any) -> JsonObject:
    return {
        "id": qid,
        "order": order,
        "type": "규칙",
        "prompt": f"{concept}에 알맞은 것은?",
        "choices": [answer, "w1", "w2", "w3", "w4"],
        "answer": answer,
        "conceptTags": [concept],
        **more,
    }


def job_input() -> JsonObject:
    """q1(be) · q2(stack)을 틀리고 q3(fasten)을 맞힘. 지난 풀이에서 stack을 한 번 더 틀림."""
    return {
        "attemptId": "a1",
        "quizSetId": "s1",
        "finishedAt": "2026-10-29T06:30:00Z",
        "answers": [
            {"questionId": "q1", "answer": "is", "correct": False},
            {"questionId": "q2", "answer": "stock", "correct": False},
            {"questionId": "q3", "answer": "fasten", "correct": True},
        ],
        "sets": [
            {
                "id": "s1",
                "materialId": "m1",
                "questions": [
                    q("q1", 1, "be", "요청 동사 뒤 동사원형"),
                    q("q2", 2, "stack", "stack의 뜻"),
                    q("q3", 3, "fasten", "fasten의 뜻", srs={}),
                ],
            }
        ],
        "history": [
            {
                "id": "a0",
                "quizSetId": "s1",
                "finishedAt": DONE - timedelta(days=3),
                "answers": [
                    {"questionId": "q2", "correct": False},
                    {"questionId": "q1", "correct": False, "void": True},  # 무효: 세지 않음
                ],
            },
            {  # 30일보다 오래됨
                "id": "old",
                "quizSetId": "s1",
                "finishedAt": DONE - timedelta(days=31),
                "answers": [{"questionId": "q1", "correct": False}],
            },
            {  # 이번 풀이가 같이 와도 한 번만 셈
                "id": "a1",
                "quizSetId": "s1",
                "finishedAt": DONE,
                "answers": [{"questionId": "q1", "correct": False}],
            },
        ],
        "notes": {"m1": [{"pageNo": 1, "ocrText": PAGE}, {"pageNo": 2, "ocrText": "[?] 흐린 줄"}]},
    }


def gen(
    answer: str, options: list[str], passage: str = "상자를 창고에 차곡차곡 두는 장면"
) -> JsonObject:
    return {
        "question": {
            "stem": "알맞은 것을 고르시오.",
            "passage": passage,
            "options": options,
            "answer": answer,
            "explanation": "노트 설명",
            "difficulty": "쉬움",
        }
    }


def ok(letter: str) -> JsonObject:
    return {"answer": letter, "only_one": True, "supported": True}


STACK = gen("stack", ["stack", "fasten", "request", "inform", "order"])
# 제시문이 앞 문제와 같으면 '이미 있는 문제와 거의 같음'으로 떨어짐
BE = gen("be", ["be", "is", "are", "was", "been"], "고객이 정보를 받게 해 달라고 부탁하는 상황")


def happy_llm() -> FakeLlm:
    return FakeLlm(
        {
            # stack이 먼저(지난 풀이까지 2번), 정답 자리는 slot 0 → A, slot 1 → B
            "Review": [STACK, BE],
            "Check": [ok("A"), ok("B")],
            "Line": [{"line": "쌓다 = stack / 노트에 없는 말"}, {"line": "노트에 없는 줄"}],
        }
    )


def run(llm: FakeLlm, inp: JsonObject) -> tuple[JsonObject, list[tuple[int, str | None]]]:
    steps: list[tuple[int, str | None]] = []
    result = review.run(llm, inp, lambda v, step=None: steps.append((v, step)))
    return result, steps


def test_wrong_answers_become_similar_questions() -> None:
    result, steps = run(happy_llm(), job_input())
    assert [a["reason"] for a in result["answers"]] == ["wrong", "wrong", None]
    assert [(w["concept"], w["total"], w["thisAttempt"]) for w in result["weakConcepts"]] == [
        ("stack의 뜻", 2, 1),
        ("요청 동사 뒤 동사원형", 1, 1),
    ]
    assert result["weakConcepts"][0]["attempts"] == 2  # 이번 + 30일 안의 지난 풀이 1번
    assert [t["questionId"] for t in result["targets"]] == ["q2", "q1"]
    assert all(t["made"] and t["tries"] == 1 for t in result["targets"])
    assert (result["targets"][0]["materialId"], result["targets"][0]["pageNo"]) == ("m1", 1)
    new = result["reviewQuestions"]
    assert [(x["order"], x["answer"], x["choices"].index(x["answer"])) for x in new] == [
        (1, "stack", 0),
        (2, "be", 1),
    ]
    assert new[0]["conceptTags"] == ["stack의 뜻"] and new[0]["type"] == "규칙"
    assert new[0]["difficulty"] == "상"  # 유형으로 정한 처음 난이도(#268)
    assert all(re.fullmatch(r"[0-9a-f]{24}", x["id"]) for x in new)
    assert result["nextReview"] == "2026-10-30"
    assert [v for v, _ in steps] == [15, 25, 52, 80, 90]


def test_review_dates_hand_over_to_the_new_questions() -> None:
    result, _ = run(happy_llm(), job_input())
    srs = {u["questionId"]: u["srs"] for u in result["srsUpdates"]}
    assert {u["quizSetId"] for u in result["srsUpdates"]} == {"s1"}
    # 맞힌 문제: 처음 푼 문제({}도 처음으로 셈) → 1일 뒤
    assert (srs["q3"]["dueAt"], srs["q3"]["lastResult"], srs["q3"]["state"]) == (
        TODAY + timedelta(days=1),
        "right",
        "active",
    )
    # 틀린 문제는 새 문제로 넘어감: 되돌릴 수 있게 원래 날짜를 dueBefore에
    new = {x["answer"]: x for x in result["reviewQuestions"]}
    assert srs["q2"]["state"] == "moved" and srs["q2"]["movedTo"] == new["stack"]["id"]
    assert (srs["q2"]["dueAt"], srs["q2"]["dueBefore"]) == (None, TODAY + timedelta(days=1))
    fresh = new["stack"]["srs"]
    assert (fresh["state"], fresh["checked"], fresh["reviews"], fresh["dueAt"]) == (
        "active",
        True,
        1,
        TODAY + timedelta(days=1),
    )
    assert fresh["carriedReviews"] == 1  # 처음 이어받은 푼 횟수(#113)


def test_note_lines_keep_only_what_is_really_in_the_note() -> None:
    result, _ = run(happy_llm(), job_input())
    found, missing = result["noteLines"]
    assert (found["line"], found["pageNo"], found["kept"]) == ("쌓다 = stack", 1, "1/2")
    assert (missing["line"], missing["raw"]) == (None, "노트에 없는 줄")


def test_note_line_pieces_from_another_page_are_dropped() -> None:
    # 출처는 쪽 하나라, 다른 쪽에서만 확인된 조각을 붙이면 학생에게 틀린 쪽을 안내하게 됨
    llm = FakeLlm({"Line": [{"line": "쌓다 = stack / 고정하다 = fasten"}]})
    notes = {"m1": {1: "쌓다 = stack"}, "m2": {4: "고정하다 = fasten"}}
    got = review.note_line(llm, "뜻", [("m1", 1), ("m2", 4)], notes)
    assert (got["line"], got["materialId"], got["pageNo"], got["kept"]) == (
        "쌓다 = stack",
        "m1",
        1,
        "1/2",
    )


@pytest.mark.parametrize(
    ("note", "said", "kept"),
    [
        ("투여 용량 1.5 mL", "투여 용량 1.5 mL", True),
        ("투여 용량 1.5 mL", "투여 용량 15 mL", False),  # 소수점이 빠진 수치
        ("어는점 -3 도", "어는점 3 도", False),  # 부호가 빠진 수치
        ("어는점 -3 도", "어는점 −3 도", True),  # 유니코드 빼기 기호는 같은 부호
        ("어는점 –3 도", "어는점 -3 도", True),  # en dash도 같은 부호
        ("어는점 —3 도", "어는점 -3 도", True),  # em dash도
        ("투여 용량 -1.5 mL", "1.5 mL", False),  # 부호 붙은 수의 뒷부분
        ("투여 용량 11.5 mL", "1.5 mL", False),  # 더 긴 수의 뒷부분
        ("투여 용량 1.5 mL", "투여 용량 1", False),  # 더 긴 수의 앞부분
        ("투여량 3-5 mL", "투여량 35 mL", False),  # 범위를 붙여 쓴 다른 수
        ("수면 7 - 9 시간", "수면 7-9 시간", True),  # 범위는 띄어 써도 같음
        ("비타민 D 600 800 IU", "800 IU", True),  # 띄어 쓴 다른 수 바로 뒤
        ("IL-6 증가가 핵심", "IL6 증가", True),  # 이름 속 붙임표는 부호가 아님
        ("- 1차 면역반응: IgM 증가", "1차 면역반응: IgM 증가", True),  # 줄 앞 글머리
        ("-1차 면역반응: IgM 증가", "-1차 면역반응: IgM 증가", True),  # 붙인 글머리는 그대로
        ("응고 조건\n-3 도에서 응고", "3 도에서 응고", False),  # 줄 앞 부호가 빠진 수치
        ("투여 용량 1.5 mL\n보관 온도 15 도", "투여 용량 15 mL", False),  # 다른 줄에 있는 수
        ("투여량 1.5 mL, 최대 15 mL", "투여량 15 mL, 최대 1.5 mL", False),  # 수의 차례가 바뀜
        ("어는점 -3 도에서 3 도", "어는점 3 도에서 -3 도", False),  # 부호의 차례가 바뀜
        ("1차 15 mL, 2차 15 mL", "1차 15 mL, 2차 15 mL", True),  # 같은 수가 두 번
        ("투여 용량 15 mL\n투여 용량 1.5 mL", "투여 용량 1.5 mL", True),  # 두 곳 다 봄
        ("균 3.5×10^5 CFU/mL", "균 3.5 × 10^5 CFU/mL", True),  # 지수 꼴도 한 수
        ("용량 3 mL", "———", False),  # 대시만: 비교 키가 빈 글
        ("Vitamin D3 보충", "D—3", False),  # 비교 키 'd3'은 3글자가 안 됨
    ],
)
def test_note_line_keeps_numbers_as_written(note: str, said: str, kept: bool) -> None:
    llm = FakeLlm({"Line": [{"line": said}]})
    got = review.note_line(llm, "용량", [("m1", 1)], {"m1": {1: note}})
    assert (got["line"] == said) is kept, got


def test_failed_note_line_call_is_recorded_not_raised() -> None:
    llm = happy_llm()
    llm.answers["Line"] = [LlmError("HTTP 503"), {"line": ""}]
    result, _ = run(llm, job_input())
    assert [n["raw"] for n in result["noteLines"]] == ["HTTP 503", None]


def test_question_the_model_keeps_copying_is_asked_again_and_handed_over_once() -> None:
    inp = job_input()
    inp["answers"] = inp["answers"][:1]  # q1만 틀림
    inp["history"] = []
    copy_of_q1 = gen("be", ["be", "is", "are", "was", "been"])
    copy_of_q1["question"].update(stem="요청 동사 뒤 동사원형에 알맞은 것은?", passage="")
    llm = FakeLlm({"Review": [copy_of_q1] * 3, "Line": [{"line": "x"}]})
    result, _ = run(llm, inp)
    t = result["targets"][0]
    assert t["made"] and t["reusedFrom"] == "q1"
    assert "이미 있는 문제와 거의 같음" in t["why"]
    srs = result["srsUpdates"][0]["srs"]
    # 두 번 넘기면 dueBefore가 None으로 지워짐(로컬 agent.py)
    assert srs["state"] == "moved" and srs["dueBefore"] == TODAY + timedelta(days=1)
    assert result["reviewQuestions"][0]["prompt"] == "요청 동사 뒤 동사원형에 알맞은 것은?"
    # 방금 틀린 q1을 다시 냄: 글이 같아 q1의 풀이도 이 문제 것으로 셈. 그래서 이어받은 횟수는
    # q1이 이어받은 0(q1의 풀이 1번은 오늘의 복습이 다시 셈, #113)
    assert result["reviewQuestions"][0]["srs"]["carriedReviews"] == 0
    # 이어받은 횟수가 없는 예전 기록이면 남기지 않음(예전처럼 저장값으로 거꾸로 셈)
    old = {"step": 0, "streak": 0, "reviews": 2, "state": "active", "lastResult": "wrong",
           "dueAt": "2026-10-31T00:00:00Z"}  # fmt: skip
    inp["sets"][0]["questions"][0]["srs"] = old
    result, _ = run(FakeLlm({"Review": [copy_of_q1] * 3, "Line": [{"line": "x"}]}), inp)
    assert result["targets"][0]["reusedFrom"] == "q1"
    assert "carriedReviews" not in result["reviewQuestions"][0]["srs"]


def test_reused_question_in_another_set_is_handed_over_there() -> None:
    inp = job_input()
    inp["answers"] = inp["answers"][:1]
    inp["history"] = []
    before = {"step": 1, "streak": 1, "reviews": 2, "state": "active", "checked": True,
              "lastResult": "right", "dueAt": "2026-10-31T00:00:00Z"}  # fmt: skip
    other = q("q7", 1, "be", "요청 동사 뒤 동사원형", srs=before)
    other["prompt"] = "알맞은 것을 고르시오."
    inp["sets"].append({"id": "s2", "materialId": "m1", "questions": [other]})
    near = gen("be", ["be", "is", "are", "was", "been"])
    near["question"]["passage"] = ""
    llm = FakeLlm({"Review": [near] * 3, "Line": [{"line": "x"}]})
    result, _ = run(llm, inp)
    assert result["targets"][0]["reusedFrom"] == "q7"
    moved = {(u["quizSetId"], u["questionId"]): u["srs"] for u in result["srsUpdates"]}
    assert moved[("s2", "q7")]["state"] == "moved"
    assert moved[("s2", "q7")]["dueBefore"] == datetime(2026, 10, 31)


def test_reused_question_that_could_not_be_checked_is_asked_without_checked() -> None:
    inp = job_input()
    inp["answers"] = inp["answers"][:1]
    inp["history"] = []
    blank = "He requested that she ____ informed."
    before = {"step": 1, "streak": 1, "reviews": 2, "state": "active",
              "lastResult": "right", "dueAt": "2026-10-31T00:00:00Z"}  # fmt: skip
    other = q("q7", 1, "be", "요청 동사 뒤 동사원형", srs=before, passage=blank)
    other["prompt"] = "알맞은 것을 고르시오."
    inp["sets"].append({"id": "s2", "materialId": "m1", "questions": [other]})
    near = gen("be", ["be", "is", "are", "was", "been"])
    near["question"]["passage"] = blank
    llm = FakeLlm(
        {"Review": [near] * 3, "Naturals": [LlmError("HTTP 503")] * 2, "Line": [{"line": "x"}]}
    )
    result, _ = run(llm, inp)
    assert result["targets"][0]["reusedFrom"] == "q7"
    assert llm.named("Naturals")  # 검사 안 한 옛 문제라 '정답 둘' 검사를 함
    [new] = result["reviewQuestions"]
    assert "checked" not in new["srs"]  # 검사 못 함: 오늘의 복습이 나중에 다시 검사


def test_existing_question_with_another_answer_keeps_its_review_state() -> None:
    # 'be'를 틀렸는데 'became' 문제를 넘기면 오답과 무관한 문제가 moved가 됨(Codex 재리뷰 10/29)
    inp = job_input()
    inp["answers"] = inp["answers"][:1]
    inp["history"] = []
    before = {"step": 1, "streak": 1, "reviews": 2, "state": "active", "checked": True,
              "lastResult": "right", "dueAt": "2026-10-31T00:00:00Z"}  # fmt: skip
    other = q("q7", 1, "became", "요청 동사 뒤 동사원형", srs=before)
    other["prompt"] = "알맞은 것을 고르시오."
    inp["sets"].append({"id": "s2", "materialId": "m1", "questions": [other]})
    near = gen("be", ["be", "is", "are", "was", "been"])
    near["question"]["passage"] = ""
    llm = FakeLlm({"Review": [near] * 3, "Line": [{"line": "x"}]})
    result, _ = run(llm, inp)
    assert result["targets"][0]["reusedFrom"] != "q7"
    assert "q7" not in [u["questionId"] for u in result["srsUpdates"]]


def test_all_right_answers_make_nothing() -> None:
    inp = job_input()
    for a in inp["answers"]:
        a["correct"] = True
    inp["history"] = []
    result, _ = run(FakeLlm(), inp)
    assert result["targets"] == [] and result["reviewQuestions"] == []
    assert result["weakConcepts"] == [] and result["noteLines"] == []


def test_all_right_answers_still_move_review_dates_without_llm_calls() -> None:
    # 오늘의 복습을 모두 맞혀도 복습 날짜는 넘어가야 함(같은 문제가 다음 날 다시 나오지 않게)
    inp = job_input()
    for a in inp["answers"]:
        a["correct"] = True
    llm = FakeLlm()
    result, _ = run(llm, inp)  # history의 틀린 풀이로 약한 개념은 있음
    assert result["weakConcepts"] and result["noteLines"] == [] and llm.calls == []
    assert result["srsUpdates"]
    assert all(u["srs"]["lastResult"] == "right" for u in result["srsUpdates"])


def test_llm_down_for_every_question_raises_so_the_job_is_retried() -> None:
    llm = FakeLlm({"Review": [LlmError("HTTP 503")] * 6})
    with pytest.raises(LlmError):
        run(llm, job_input())


def test_one_question_failing_does_not_fail_the_job() -> None:
    llm = happy_llm()
    llm.answers["Review"] = [LlmError("HTTP 503")] * 3 + [BE]
    llm.answers["Check"] = [ok("B")]
    result, _ = run(llm, job_input())
    assert [t["made"] for t in result["targets"]] == [False, True]
    assert result["targets"][0]["why"] == ["HTTP 503"]
    assert [x["order"] for x in result["reviewQuestions"]] == [1]  # 못 만든 문제 번호는 비우지 않음


def any_line(_: str) -> JsonObject:
    return {"line": "노트에 없는 줄"}


@pytest.mark.parametrize(
    ("review", "checks"),
    [
        # q2(stack)는 생성 호출이 모두 실패, q1(be)은 검사 모델에서 정상 탈락(#553 배포 11/19)
        ([LlmError("HTTP 503")] * 3 + [BE] * 3, [ok("E")] * 3),
        # 생성 모델의 답 모양 오류만: 장애로 세지 않던 경우
        ([{}] * 6, []),
        # 검사 모델 · 생성 모델의 답 모양 오류만(둘째 시도는 빈칸 유형이라 생성 답 모양 오류로)
        ([STACK, {}, STACK, BE, {}, BE], [{"answer": "Z"}] * 4),
    ],
)
def test_nothing_made_for_a_passing_reason_is_retried(
    review: list[JsonObject | LlmError], checks: list[JsonObject | LlmError]
) -> None:
    # 일시적인 원인으로 한 문제도 못 만들면 다시 해 볼 만함: 작업 처리기가 다시 시도하게
    llm = FakeLlm({"Review": review, "Check": checks, "Line": any_line})
    with pytest.raises(LlmError) as e:
        run(llm, job_input())
    assert not isinstance(e.value, LlmRejectedError)


def test_nothing_made_because_drafts_were_rejected_ends_with_the_reason(
    caplog: pytest.LogCaptureFixture,
) -> None:
    # 모든 초안이 검사 모델에서 정상 탈락: 다시 해도 같기 쉬워 작업은 성공(복습 상태는 옮김)
    llm = FakeLlm({"Review": [STACK] * 3 + [BE] * 3, "Check": [ok("E")] * 6, "Line": any_line})
    with caplog.at_level(logging.INFO, logger="app.services.quiz.review"):
        result, _ = run(llm, job_input())
    assert result["reviewQuestions"] == [] and result["srsUpdates"]
    assert result["emptyReason"] == "rejected"
    logged = [r.getMessage() for r in caplog.records if r.name == "app.services.quiz.review"]
    assert len(logged) == 1
    assert "0/2문제" in logged[0] and "초안 6" in logged[0] and "rejected" in logged[0]
    assert "검사 모델 탈락" in logged[0]
    # 사용자 내용(답 · 개념 이름 · 노트)은 남기지 않음
    assert not any(w in logged[0] for w in ("stack", "동사원형", "쌓다"))


def test_a_refused_target_next_to_a_rejected_one_is_not_retried() -> None:
    # 거절은 다시 보내도 같음(#272): 나머지가 정상 탈락이면 다시 시도하지 않음
    review = [LlmRejectedError("HTTP 413")] * 3 + [BE] * 3
    llm = FakeLlm({"Review": review, "Check": [ok("E")] * 3, "Line": any_line})
    result, _ = run(llm, job_input())
    assert result["reviewQuestions"] == [] and result["emptyReason"] == "rejected"


class CheckpointReport:
    """작업 처리기 report처럼 진행률 · checkpoint · 마지막 시도인지를 받음."""

    def __init__(self, saved: object = None, *, last: bool = False) -> None:
        self.saved, self.last = saved, last

    def last_attempt(self) -> bool:
        return self.last

    def __call__(self, value: int, step: str | None = None) -> None:
        pass

    def load_checkpoint(self) -> object:
        return self.saved

    def save_checkpoint(self, value: JsonObject) -> None:
        self.saved = value


def outage_llm() -> FakeLlm:
    # q2(stack)는 생성 호출이 모두 실패, q1(be)은 검사 모델에서 정상 탈락
    review_ = [LlmError("HTTP 503")] * 3 + [BE] * 3
    return FakeLlm({"Review": review_, "Check": [ok("E")] * 3, "Line": any_line})


def test_nothing_made_for_a_passing_reason_is_retried_only_once() -> None:
    # 시도 한도를 넘겨 실패하면 복습 상태가 옮겨지지 않으므로 한 번만 다시 시도(/code-review)
    report = CheckpointReport()
    with pytest.raises(LlmError):
        review.run(outage_llm(), job_input(), report)
    assert report.saved == {"emptyRetries": 1}
    result = review.run(outage_llm(), job_input(), report)
    assert result["reviewQuestions"] == [] and result["emptyReason"] == "transient"
    assert result["srsUpdates"]


@pytest.mark.parametrize(
    "saved", [None, {}, {"emptyRetries": "x"}, {"emptyRetries": True}, {"emptyRetries": -1}, []]
)
def test_a_missing_or_odd_checkpoint_counts_as_no_retry_yet(saved: object) -> None:
    report = CheckpointReport(saved)
    with pytest.raises(LlmError):
        review.run(outage_llm(), job_input(), report)
    assert report.saved == {"emptyRetries": 1}


class BrokenCheckpoint(CheckpointReport):
    def save_checkpoint(self, value: JsonObject) -> None:
        raise AutoReconnect("DB 끊김")


def test_a_retry_count_that_cannot_be_saved_ends_the_job_instead() -> None:
    # 횟수가 남지 않으면 한도까지 되풀이할 수 있어 성공으로 끝내 복습 상태를 옮김
    result = review.run(outage_llm(), job_input(), BrokenCheckpoint())
    assert result["emptyReason"] == "transient" and result["srsUpdates"]


def test_no_retry_on_the_last_attempt() -> None:
    # 다시 시도를 올려도 한도라 실패로 끝나므로 성공으로 끝냄(Codex 리뷰 #555)
    report = CheckpointReport(last=True)
    result = review.run(outage_llm(), job_input(), report)
    assert result["emptyReason"] == "transient" and result["srsUpdates"]
    assert report.saved is None


def test_a_report_without_attempt_info_is_not_retried_when_the_limit_is_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(review.settings, "ai_job_max_attempts", 1)
    result, _ = run(outage_llm(), job_input())
    assert result["emptyReason"] == "transient"


def all_down() -> FakeLlm:
    return FakeLlm({"Review": [LlmError("HTTP 503")] * 6})


@pytest.mark.parametrize(
    ("used", "first", "last", "limit"),
    [
        # 일시적인 0문제 → 한 번 다시 → 또 0문제면 성공
        (0, [outage_llm], outage_llm, 3),
        # 모두 장애 2번 뒤 마지막 시도의 일시적인 0문제도 성공(/code-review 3차)
        (0, [all_down] * 2, outage_llm, 3),
        # 앞 두 시도를 처리기가 멈춰 씀(잠금이 끝나 다시 가져감, Codex 리뷰 #555)
        (2, [], outage_llm, 3),
        # 시도 한도가 1
        (0, [], outage_llm, 1),
    ],
)
def test_the_worker_saves_review_dates_after_retrying(
    used: int, first: list[Callable[[], FakeLlm]], last: Callable[[], FakeLlm], limit: int
) -> None:
    # 실제 작업 처리기(run_once · JobStore)로: 다시 넣기 · checkpoint 저장 · 성공할 때 지우기
    col = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    col.insert_one(
        {
            "_id": "j1",
            "type": review.TYPE,
            "status": "queued",
            "input": job_input(),
            "progress": 0,
            "attempts": used,
            "result": None,
            "error": None,
            "createdAt": DONE,
        }
    )
    now = [DONE.replace(tzinfo=UTC)]

    def store() -> JobStore:
        return JobStore(
            col, "w1", lock_sec=600, max_attempts=limit, retry_delay_sec=30, now=lambda: now[0]
        )

    llms = [*(f() for f in first), last()]
    handlers = {review.TYPE: lambda inp, report: review.run(llms.pop(0), inp, report)}
    for _ in first:
        assert run_once(store(), handlers)
        assert col.find_one({"_id": "j1"})["status"] == "queued"
        now[0] += timedelta(minutes=5)
    assert run_once(store(), handlers)
    doc = col.find_one({"_id": "j1"})
    assert doc["status"] == "succeeded" and "checkpoint" not in doc
    assert doc["result"]["emptyReason"] == "transient" and doc["result"]["srsUpdates"]


def test_a_target_with_any_refused_try_is_not_retried() -> None:
    # q2: 거절 2번 + 답 모양 오류 1번 → 다시 보내도 거절되기 쉬움. q1은 정상 탈락
    review_ = [LlmRejectedError("HTTP 413"), {}, LlmRejectedError("HTTP 413")] + [BE] * 3
    llm = FakeLlm({"Review": review_, "Check": [ok("E")] * 3, "Line": any_line})
    result, _ = run(llm, job_input())
    assert result["reviewQuestions"] == [] and result["emptyReason"] == "rejected"


def test_refused_without_a_rejected_draft_is_not_called_rejected() -> None:
    # 대상마다 거절 1번 + 답 모양 오류 2번: 장애(llm_down)도 아니고 검사에서 떨어진 초안도 없음
    review_ = [LlmRejectedError("HTTP 413"), {}, {}] * 2
    llm = FakeLlm({"Review": review_, "Line": any_line})
    result, _ = run(llm, job_input())
    assert result["reviewQuestions"] == [] and result["emptyReason"] == "refused"


def test_made_questions_leave_no_empty_reason(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="app.services.quiz.review"):
        result, _ = run(happy_llm(), job_input())
    assert result["emptyReason"] is None
    assert any("2/2문제" in r.getMessage() for r in caplog.records)


def test_no_wrong_answer_is_the_reason_for_an_empty_set() -> None:
    inp = job_input()
    for a in inp["answers"]:
        a["correct"] = True
    result, _ = run(FakeLlm(), inp)
    assert result["emptyReason"] == "no_wrong"


def test_questions_missed_for_the_last_time_are_the_reason_for_an_empty_set() -> None:
    inp = job_input()
    tired = {"step": 0, "streak": 0, "reviews": 4, "state": "active", "lastResult": "wrong"}
    for x in inp["sets"][0]["questions"][:2]:
        x["srs"] = dict(tired)
    result, _ = run(FakeLlm({"Line": any_line}), inp)
    assert result["targets"] == [] and result["emptyReason"] == "all_stopped"


def test_missing_note_text_is_the_reason_for_an_empty_set() -> None:
    inp = job_input()
    inp["notes"] = {}
    result, _ = run(FakeLlm(), inp)
    assert result["emptyReason"] == "no_note"


# ---------- input 확인 ----------


def broken(change: str) -> JsonObject:
    inp = copy.deepcopy(job_input())
    if change == "no sets":
        inp["sets"] = []
    elif change == "question id":
        del inp["sets"][0]["questions"][0]["id"]
    elif change == "bool order":
        inp["sets"][0]["questions"][0]["order"] = True
    elif change == "unknown answer":
        inp["answers"][0]["questionId"] = "zz"
    elif change == "bad date":
        inp["finishedAt"] = "어제"
    elif change == "srs without step":
        inp["sets"][0]["questions"][0]["srs"] = {"state": "active"}
    elif change == "choices":
        inp["sets"][0]["questions"][0]["choices"] = "be"
    elif change == "page":
        inp["notes"]["m1"][0]["pageNo"] = "첫 쪽"
    elif change == "superscript page":
        inp["notes"]["m1"][0]["pageNo"] = "²"  # isdigit()은 참이지만 int()가 못 읽음
    return inp


@pytest.mark.parametrize(
    "change",
    [
        "no sets",
        "question id",
        "bool order",
        "unknown answer",
        "bad date",
        "srs without step",
        "choices",
        "page",
        "superscript page",
    ],
)
def test_bad_input_fails_at_once(change: str) -> None:
    with pytest.raises(review.InputError):
        run(happy_llm(), broken(change))


def test_input_accepts_dates_and_page_numbers_as_written_by_other_tools() -> None:
    inp = job_input()
    inp["finishedAt"] = DONE  # pymongo가 주는 Date
    inp["notes"]["m1"][0]["pageNo"] = "1"  # 녹음 정리 시제품
    result, _ = run(happy_llm(), inp)
    assert result["targets"][0]["pageNo"] == 1


@pytest.mark.parametrize(
    ("finished", "next_review"),
    [
        ("2026-10-29T23:00:00Z", "2026-10-31"),  # 서울 10/30 08:00
        ("2026-10-30T01:00:00+09:00", "2026-10-31"),  # 서울 10/30 새벽 = UTC 10/29
        ("2026-10-29T14:59:00Z", "2026-10-30"),  # 서울 10/29 23:59
    ],
)
def test_review_days_change_at_seoul_midnight(finished: str, next_review: str) -> None:
    inp = job_input()
    inp["finishedAt"] = finished
    inp["history"] = []
    llm = happy_llm()
    llm.answers["Review"] = [BE, STACK]  # 지난 풀이를 빼서 순서가 q1 · q2
    llm.answers["Line"] = [{"line": "x"}, {"line": "x"}]
    result, _ = run(llm, inp)
    assert result["nextReview"] == next_review
    q3 = next(u["srs"] for u in result["srsUpdates"] if u["questionId"] == "q3")
    assert q3["dueAt"] == review.seoul_midnight(date.fromisoformat(next_review))


def test_new_id_looks_like_an_object_id() -> None:
    a, b = review.new_id(), review.new_id()
    assert re.fullmatch(r"[0-9a-f]{24}", a) and a != b


def test_question_missed_for_the_last_time_is_not_asked_again() -> None:
    inp = job_input()
    inp["history"] = []
    tired = {"step": 0, "streak": 0, "reviews": 4, "state": "active", "lastResult": "wrong"}
    inp["sets"][0]["questions"][0]["srs"] = tired  # q1: 이번이 5번째
    llm = FakeLlm({"Review": [STACK], "Check": [ok("A")], "Line": [{"line": "x"}, {"line": "x"}]})
    result, _ = run(llm, inp)
    assert [t["questionId"] for t in result["targets"]] == ["q2"]
    q1 = next(u["srs"] for u in result["srsUpdates"] if u["questionId"] == "q1")
    assert q1["state"] == "stopped"
    # 대신 노트로 안내: 약한 개념 노트 줄에는 남음
    assert "요청 동사 뒤 동사원형" in [n["concept"] for n in result["noteLines"]]


@pytest.mark.parametrize("void", [True, "문제 오류: 정답 둘(is도 맞음)"])  # 오늘의 복습은 이유 글
def test_void_answers_in_this_attempt_are_left_out(void: object) -> None:
    inp = job_input()
    inp["history"] = []
    inp["answers"][0]["void"] = void  # q1은 결함 문제라 무효
    llm = FakeLlm({"Review": [STACK], "Check": [ok("A")], "Line": [{"line": "x"}]})
    result, _ = run(llm, inp)
    assert [a["questionId"] for a in result["answers"]] == ["q2", "q3"]
    assert "q1" not in {u["questionId"] for u in result["srsUpdates"]}
    assert [w["concept"] for w in result["weakConcepts"]] == ["stack의 뜻"]


@pytest.mark.parametrize(
    "notes",
    [
        {"m1": [{"pageNo": 1, "ocrText": "[?] 흐린 줄"}]},  # 남는 줄이 없음
        {},  # 노트를 지움
    ],
)
def test_without_note_text_review_dates_are_still_saved(notes: JsonObject) -> None:
    inp = job_input()
    inp["notes"] = notes
    result, steps = run(FakeLlm(), inp)
    assert [v for v, _ in steps] == [15, 25, 52, 80, 90]
    assert [t["why"] for t in result["targets"]] == [["노트 글이 없음"]] * 2
    assert all(t["materialId"] is None for t in result["targets"])
    assert result["reviewQuestions"] == [] and result["noteLines"] == []
    assert {u["questionId"] for u in result["srsUpdates"]} == {"q1", "q2", "q3"}


def test_short_pieces_do_not_count_as_found_in_the_note() -> None:
    llm = happy_llm()
    llm.answers["Line"] = [{"line": "지어낸 설명 / of / —"}, {"line": "x"}]
    result, _ = run(llm, job_input())
    assert result["noteLines"][0]["line"] is None


def test_weak_concepts_count_thirty_seoul_days() -> None:
    inp = job_input()
    first = {"questionId": "q1", "correct": False}
    inp["history"] = [
        # 서울 9/30 00:30 = UTC 9/29 15:30: 오늘(10/29)을 넣어 30일째라 들어감
        {"id": "in", "quizSetId": "s1", "finishedAt": "2026-09-29T15:30:00Z", "answers": [first]},
        # 서울 9/29 23:30: 31일째라 빠짐
        {"id": "out", "quizSetId": "s1", "finishedAt": "2026-09-29T14:30:00Z", "answers": [first]},
    ]
    llm = happy_llm()
    llm.answers["Review"] = [BE, STACK]
    llm.answers["Line"] = [{"line": "x"}, {"line": "x"}]
    result, _ = run(llm, inp)
    w = {x["concept"]: x["total"] for x in result["weakConcepts"]}
    assert w["요청 동사 뒤 동사원형"] == 2


def test_a_void_question_is_not_asked_again_as_an_existing_question() -> None:
    inp = job_input()
    inp["history"] = []
    # q4는 q1과 답이 같음. q1은 이번 풀이에서 무효(결함 문제)
    inp["sets"][0]["questions"].append(q("q4", 4, "be", "요청 동사 뒤 동사원형"))
    inp["answers"] = [
        {"questionId": "q1", "correct": False, "void": True},
        {"questionId": "q4", "correct": False},
    ]
    copy_of_q1 = gen("be", ["be", "is", "are", "was", "been"])
    copy_of_q1["question"].update(stem="요청 동사 뒤 동사원형에 알맞은 것은?", passage="")
    llm = FakeLlm({"Review": [copy_of_q1] * 3, "Line": [{"line": "x"}]})
    result, _ = run(llm, inp)
    assert result["targets"][0]["reusedFrom"] == "q4"  # 무효인 q1이 아니라 방금 틀린 q4


def test_another_target_of_this_attempt_is_not_reused() -> None:
    # q1 · q4 둘 다 정답 'be'를 틀림. q1의 다시 보기가 q4를 다시 내면 q4는 두 번 넘어감
    inp = job_input()
    inp["history"] = []
    q4 = q("q4", 4, "be", "요청 동사 뒤 동사원형")
    q4["prompt"] = "부탁하는 문장에서 빈칸에 들어갈 동사의 형태는?"
    inp["sets"][0]["questions"].append(q4)
    inp["answers"] = [
        {"questionId": "q1", "correct": False},
        {"questionId": "q4", "correct": False},
    ]
    copy_of_q4 = gen("be", ["be", "is", "are", "was", "been"])  # q1보다 q4와 가까움
    copy_of_q4["question"].update(stem=q4["prompt"], passage="")
    llm = FakeLlm({"Review": [copy_of_q4] * 6, "Line": [{"line": "x"}]})
    result, _ = run(llm, inp)
    assert [t["reusedFrom"] for t in result["targets"]] == ["q1", None]
    moved = [u for u in result["srsUpdates"] if u["srs"]["state"] == "moved"]
    assert [u["questionId"] for u in moved] == ["q1"]
    assert moved[0]["srs"]["dueBefore"] is not None


@pytest.mark.parametrize("value", [1, {}, "", False, None])
def test_only_true_or_a_reason_marks_an_answer_void(value: object) -> None:
    assert not review.is_void(value)
