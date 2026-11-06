import copy
import re
from datetime import datetime, timedelta
from typing import Any

import pytest

from app.clients.llm import JsonObject, LlmError
from app.services.quiz import today
from app.services.quiz.review import InputError, seoul_midnight
from tests.fakes import FakeLlm, fits

DAY = "2026-10-30"  # 서울 날짜
TOMORROW = datetime(2026, 10, 30, 15)  # 서울 10/31 0시를 UTC로
PAGE = """요청 동사 뒤에는 동사원형을 쓴다
request that he be informed
쌓다 = stack
fasten - 고정하다
The rope was fastened to the post."""


def st(due: datetime | None, last: str | None = "right", **more: Any) -> JsonObject:
    return {
        "step": 1,
        "dueAt": due,
        "lastResult": last,
        "streak": 1 if last == "right" else 0,
        "reviews": 2,
        "state": "active",
        "checked": True,
        **more,
    }


def q(qid: str, answer: str, concept: str, srs: JsonObject | None, **more: Any) -> JsonObject:
    return {
        "id": qid,
        "order": 1,
        "type": "규칙",
        "prompt": f"{concept}에 알맞은 것은?",
        "choices": [answer, "w1", "w2", "w3", "w4"],
        "answer": answer,
        "conceptTags": [concept],
        "srs": srs,
        **more,
    }


def wrong(qid: str, set_id: str = "s1", answer: str = "w1", **more: Any) -> JsonObject:
    return {
        "id": f"a-{qid}-{len(more)}",
        "quizSetId": set_id,
        "finishedAt": "2026-10-20T06:00:00Z",
        "answers": [{"questionId": qid, "answer": answer, "correct": False, **more}],
    }


def job(*sets: JsonObject, attempts: list[JsonObject] | None = None, **more: Any) -> JsonObject:
    return {
        "day": DAY,
        "sets": list(sets),
        "attempts": attempts or [],
        "notes": {"m1": [{"pageNo": 1, "ocrText": PAGE}]},
        **more,
    }


def run(llm: FakeLlm, inp: JsonObject) -> JsonObject:
    return today.run(llm, inp, lambda v, step=None: None)


def updates(result: JsonObject) -> dict[str, JsonObject]:
    return {u["questionId"]: u["srs"] for u in result["srsUpdates"]}


# ---------- 고르기 · 넘겨주기 (코드) ----------


def ordering_input() -> JsonObject:
    """bravo는 지난번에 틀림. alpha · charlie는 약한 개념 C1(틀린 2번), echo는 C3(0번)."""
    s1 = {
        "id": "s1",
        "materialId": "m1",
        "questions": [
            q("qa", "alpha", "C1", st(TOMORROW - timedelta(days=3))),
            q("qb", "bravo", "C2", st(TOMORROW - timedelta(days=1), "wrong")),
            q("qc", "charlie", "C1", st(TOMORROW - timedelta(days=6))),
            q("qd", "delta", "C1", st(TOMORROW)),  # 내일 0시: 아직 아님
            q("qx", "xray", "C1", {**st(None), "state": "mastered"}),
        ],
    }
    s2 = {
        "id": "s2",
        "materialId": "m1",
        "questions": [
            q("qe", "echo", "C3", st(TOMORROW - timedelta(days=9))),
            q("qa2", "alpha", "C1", st(TOMORROW - timedelta(days=2))),  # 같은 낱말
        ],
    }
    return job(s1, s2, attempts=[wrong("qa"), wrong("qc"), wrong("qb")])


def test_due_questions_come_wrong_first_then_weak_concept_then_oldest_date() -> None:
    result = run(FakeLlm(), ordering_input())
    assert [x["answer"] for x in result["questions"]] == ["bravo", "charlie", "alpha", "echo"]
    assert [x["order"] for x in result["questions"]] == [1, 2, 3, 4]
    assert result["due"] == 5  # qa2는 날짜가 됐지만 alpha가 이미 있어 고르지 않음
    assert (result["title"], result["baseSetId"]) == ("오늘의 복습 · 10-30", "s1")
    assert result["dropped"] == [] and result["voidAnswers"] == []


def test_copies_carry_the_review_on_and_the_same_word_joins() -> None:
    inp = ordering_input()
    result = run(FakeLlm(), inp)
    copies = {x["answer"]: x for x in result["questions"]}
    assert all(re.fullmatch(r"[0-9a-f]{24}", x["id"]) for x in result["questions"])
    assert copies["alpha"]["srs"] == {**st(TOMORROW - timedelta(days=3))}  # 상태는 사본이 이어 감
    up = updates(result)
    assert set(up) == {"qa", "qb", "qc", "qe", "qa2"}  # qd(아직) · qx(다 익힘)는 그대로
    for qid, answer in [("qa", "alpha"), ("qa2", "alpha"), ("qb", "bravo")]:
        assert up[qid]["state"] == "moved" and up[qid]["dueAt"] is None
        assert up[qid]["movedTo"] == copies[answer]["id"]
    assert up["qa2"]["dueBefore"] == TOMORROW - timedelta(days=2)  # 되돌리기용 옛 날짜
    assert result["merged"] == 1


def test_null_size_uses_the_default_size() -> None:
    result = run(FakeLlm(), {**ordering_input(), "size": None})
    assert len(result["questions"]) == 4


def test_set_size_limits_the_picked_questions() -> None:
    result = run(FakeLlm(), {**ordering_input(), "size": 2})
    assert [x["answer"] for x in result["questions"]] == ["bravo", "charlie"]
    assert set(updates(result)) == {"qb", "qc"}


def test_due_until_the_next_seoul_midnight() -> None:
    s1 = {
        "id": "s1",
        "materialId": "m1",
        "questions": [
            q("q1", "alpha", "C1", st(TOMORROW - timedelta(minutes=1))),  # 서울 10/30 23:59
            q("q2", "bravo", "C1", st(TOMORROW)),  # 서울 10/31 0시
        ],
    }
    result = run(FakeLlm(), job(s1))
    assert [x["answer"] for x in result["questions"]] == ["alpha"]
    assert seoul_midnight(datetime(2026, 10, 31).date()) == TOMORROW


def test_nothing_due_gives_the_next_review_day() -> None:
    s1 = {
        "id": "s1",
        "materialId": "m1",
        "questions": [
            q("q1", "alpha", "C1", st(TOMORROW + timedelta(days=2))),  # 서울 11/2 0시
            q("q2", "bravo", "C1", {**st(None), "state": "mastered"}),
        ],
    }
    result = run(FakeLlm(), job(s1))
    assert (result["questions"], result["srsUpdates"], result["title"]) == ([], [], None)
    assert result["nextReview"] == "2026-11-02"
    assert result["progress"] == [
        {"concept": "C1", "mastered": 1, "stopped": 0, "active": 1, "wrong": 0}
    ]


def test_no_review_left_gives_no_next_day() -> None:
    s1 = {"id": "s1", "materialId": "m1", "questions": [q("q1", "a", "C1", None)]}
    assert run(FakeLlm(), job(s1))["nextReview"] is None


def test_progress_is_listed_by_wrong_answers() -> None:
    result = run(FakeLlm(), ordering_input())
    assert [(p["concept"], p["wrong"]) for p in result["progress"]] == [
        ("C1", 2),
        ("C2", 1),
        ("C3", 0),
    ]


def test_deleted_sets_give_no_questions_but_their_answers_count() -> None:
    inp = ordering_input()
    gone = {
        "id": "s9",
        "materialId": "m1",
        "deletedAt": "2026-10-25T00:00:00Z",
        "questions": [q("qz", "zulu", "C3", st(TOMORROW - timedelta(days=9)))],
    }
    inp["sets"].append(gone)
    inp["attempts"] += [{**wrong("qz", "s9"), "id": f"z{i}"} for i in range(3)]
    result = run(FakeLlm(), inp)
    assert "zulu" not in [x["answer"] for x in result["questions"]]
    assert "qz" not in updates(result)
    # C3이 틀린 3번으로 가장 약한 개념이 되어 echo가 C1 문제보다 앞에 옴
    assert [x["answer"] for x in result["questions"]] == ["bravo", "echo", "charlie", "alpha"]


def test_old_review_state_without_last_result_is_read() -> None:
    old = st(TOMORROW - timedelta(days=1))
    del old["lastResult"]
    result = run(
        FakeLlm(), job({"id": "s1", "materialId": "m1", "questions": [q("q1", "a", "C1", old)]})
    )
    assert [x["answer"] for x in result["questions"]] == ["a"]


def test_numbers_and_inner_words_are_different_answers() -> None:
    due = TOMORROW - timedelta(days=1)
    s1 = {
        "id": "s1",
        "materialId": "m1",
        "questions": [
            q("q1", "1.5 mL", "C1", st(due - timedelta(days=5))),
            q("q2", "15 mL", "C2", st(due - timedelta(days=4))),
            q("q3", "port", "C3", st(due - timedelta(days=3))),
            q("q4", "report", "C4", st(due - timedelta(days=2))),
            q("q5", "fasten", "C5", st(due)),
            q("q6", "fasten", "C5", st(TOMORROW + timedelta(days=3))),  # 아직 아님
            q("q7", "Type I", "C6", st(due)),
            q("q8", "Type II", "C7", st(due)),
        ],
    }
    result = run(FakeLlm(), {**job(s1), "size": 7})
    copies = {x["answer"]: x["id"] for x in result["questions"]}
    # 각자 나옴
    assert list(copies) == ["1.5 mL", "15 mL", "port", "report", "fasten", "Type I", "Type II"]
    up = updates(result)
    assert up["q6"]["state"] == "moved" and up["q6"]["movedTo"] == copies["fasten"]  # 같은 낱말
    assert result["merged"] == 1


def test_words_that_only_look_alike_are_each_reviewed() -> None:
    due = TOMORROW - timedelta(days=1)
    s1 = {
        "id": "s1",
        "materialId": "m1",
        "questions": [
            q("q1", "act", "C1", st(due - timedelta(days=2))),
            q("q2", "active", "C2", st(due - timedelta(days=1))),
            q("q3", "세포", "C3", st(due)),
            q("q4", "세포막", "C4", st(TOMORROW + timedelta(days=3))),  # 아직 아님
            q("q5", "전립선암", "C5", st(due)),
            q("q6", "전립선염", "C6", st(TOMORROW + timedelta(days=3))),
            q("q7", "fasten", "C7", st(due)),
            q("q8", "fastened", "C7", st(TOMORROW + timedelta(days=3))),
        ],
    }
    result = run(FakeLlm(), {**job(s1), "size": 7})
    answers = [x["answer"] for x in result["questions"]]
    assert answers == ["act", "active", "세포", "전립선암", "fasten"]
    up = updates(result)
    # 다른 낱말이라 사본으로 넘기지 않음: 각자의 날짜에 복습
    assert "q4" not in up and "q6" not in up and "q8" not in up and result["merged"] == 0


def test_void_answers_do_not_count_as_wrong() -> None:
    inp = ordering_input()
    inp["attempts"] = [wrong("qa", void="문제 오류"), wrong("qc", void=True)]
    result = run(FakeLlm(), inp)
    assert all(p["wrong"] == 0 for p in result["progress"] if p["concept"] == "C1")


# ---------- 결함 문제 (LLM) ----------

BLANK = "The rope was ____ to the post."


def blank_q(srs: JsonObject, **more: Any) -> JsonObject:
    return q(
        "q1",
        "fastened",
        "fasten의 뜻",
        srs,
        type="빈칸",
        passage=BLANK,
        choices=["fastened", "secured", "extended", "displayed", "stacked"],
        **more,
    )


SECURED = fits("secured", "fastened")  # 정답 둘 검사: secured도 빈칸에 맞음(정답도 맞음)


def flawed_input(srs: JsonObject) -> JsonObject:
    """검사한 적 없는 빈칸 문제. 지난번 secured를 골라 틀렸고, 그 전에는 맞혔음."""
    s1 = {"id": "s1", "materialId": "m1", "questions": [blank_q(srs)]}
    right = {
        "id": "a0",
        "quizSetId": "s1",
        "finishedAt": "2026-10-10T06:00:00Z",
        "answers": [{"questionId": "q1", "answer": "fastened", "correct": True}],
    }
    return job(s1, attempts=[right, wrong("q1", answer="secured")])


def unchecked(**more: Any) -> JsonObject:
    s = st(TOMORROW - timedelta(days=1), "wrong", **more)
    del s["checked"]
    return s


def test_unchecked_question_that_passes_is_marked_checked() -> None:
    # 보기를 한꺼번에(검사 모델 · 생성 모델 2차 판정): 걸린 오답 없음 · 정답은 빈칸에 맞음
    llm = FakeLlm({"Naturals": fits("fastened")})
    result = run(llm, flawed_input(unchecked()))
    assert [x["answer"] for x in result["questions"]] == ["fastened"]
    assert result["questions"][0]["srs"]["checked"] is True
    assert result["dropped"] == []


def test_question_put_off_that_passes_the_next_day_loses_its_flaw_mark() -> None:
    llm = FakeLlm({"Naturals": fits("fastened")})
    result = run(llm, flawed_input(unchecked(flaw="정답 둘", flawTries=1)))
    [x] = result["questions"]
    assert x["srs"]["checked"] is True
    assert "flaw" not in x["srs"] and "flawTries" not in x["srs"]
    s = updates(result)["q1"]
    assert "flaw" not in s and "flawTries" not in s
    assert result["dropped"] == [] and result["voidAnswers"] == []


def test_second_right_answer_voids_those_answers_and_waits_a_day_for_a_new_question() -> None:
    # secured도 빈칸에 맞음 → 무효. 새 문제는 세 번 다 모양이 틀려 못 만듦
    llm = FakeLlm({"Naturals": SECURED, "Review": [{}, {}, {}]})
    result = run(llm, flawed_input(unchecked()))
    assert result["questions"] == []
    assert result["voidAnswers"] == [
        {"attemptId": "a-q1-0", "questionId": "q1", "void": "문제 오류: 정답 둘(secured도 맞음)"}
    ]
    s = updates(result)["q1"]
    assert (s["state"], s["dueAt"], s["flawTries"]) == ("active", TOMORROW, 1)
    assert (s["reviews"], s["lastResult"]) == (1, "right")  # 무효 풀이를 빼고 마지막 풀이로
    # 이어받은 풀이가 없어 남은 풀이(맞힘 1번)로 처음부터 다시 셈: 처음 맞힌 문제는 step 0
    assert (s["streak"], s["step"]) == (1, 0)
    assert "secured" in s["flaw"]
    assert result["dropped"] == [
        {
            "quizSetId": "s1",
            "questionId": "q1",
            "flaw": s["flaw"],
            "replacedBy": None,
            "state": "active",
        }
    ]
    assert result["nextReview"] == "2026-10-31"


def test_voided_wrong_answer_is_taken_off_the_wrong_count() -> None:
    llm = FakeLlm({"Naturals": SECURED, "Review": [{}, {}, {}]})
    result = run(llm, flawed_input(unchecked()))
    [p] = result["progress"]
    assert (p["concept"], p["wrong"]) == ("fasten의 뜻", 0)


def test_right_then_voided_wrong_then_right_is_mastered() -> None:
    inp = flawed_input(unchecked())
    inp["attempts"].append(
        {
            "id": "a2",
            "quizSetId": "s1",
            "finishedAt": "2026-10-25T06:00:00Z",
            "answers": [{"questionId": "q1", "answer": "fastened", "correct": True}],
        }
    )
    llm = FakeLlm({"Naturals": SECURED})  # 새 문제는 만들지 않음
    result = run(llm, inp)
    assert result["questions"] == [] and len(result["voidAnswers"]) == 1
    s = updates(result)["q1"]
    # reviews는 남은 이 문제 풀이 수(2)보다 작아지지 않음(저장된 2 - 무효 1 = 1)
    assert (s["state"], s["dueAt"], s["streak"], s["reviews"]) == ("mastered", None, 2, 2)
    assert "secured" in s["flaw"] and "flawTries" not in s
    assert result["dropped"][0]["state"] == "mastered"
    assert result["dropped"][0]["replacedBy"] is None


def test_voiding_the_first_wrong_answer_counts_the_step_again() -> None:
    # [오답(secured, 무효), 정답]: 저장된 step 1은 오답 뒤 정답으로 오른 값.
    # 오답을 빼면 처음 맞힌 것(step 0)
    inp = flawed_input(unchecked())
    right, wrong_one = inp["attempts"]
    right["finishedAt"], wrong_one["finishedAt"] = "2026-10-20T06:00:00Z", "2026-10-10T06:00:00Z"
    inp["attempts"] = [wrong_one, right]
    llm = FakeLlm({"Naturals": SECURED, "Review": [{}, {}, {}]})
    s = updates(run(llm, inp))["q1"]
    assert (s["reviews"], s["lastResult"], s["streak"], s["step"]) == (1, "right", 1, 0)


def test_all_answers_voided_start_the_streak_and_step_from_zero() -> None:
    # 맞힘은 오답 복습이 무효로(void: true), secured 오답은 이번에 무효로: 남은 풀이가 없음
    inp = flawed_input(unchecked(streak=1, step=1))
    inp["attempts"][0]["answers"][0]["void"] = True
    llm = FakeLlm({"Naturals": SECURED, "Review": [{}, {}, {}]})
    s = updates(run(llm, inp))["q1"]
    assert (s["reviews"], s["lastResult"], s["streak"], s["step"]) == (0, None, 0, 0)


def test_answers_on_another_question_of_the_same_word_do_not_restore_the_streak() -> None:
    inp = flawed_input(unchecked())
    other = q(
        "qz",
        "fastened",
        "fasten의 뜻",
        {**st(None), "state": "mastered"},
        prompt="다른 세트에서 따로 만든 문제",
    )
    inp["sets"].append({"id": "s2", "materialId": "m1", "questions": [other]})
    for i, day in enumerate(["2026-10-12", "2026-10-15"]):
        right = {"questionId": "qz", "answer": "fastened", "correct": True}
        inp["attempts"].append(
            {"id": f"z{i}", "quizSetId": "s2", "finishedAt": f"{day}T06:00:00Z", "answers": [right]}
        )
    llm = FakeLlm({"Naturals": SECURED, "Review": [{}, {}, {}]})
    s = updates(run(llm, inp))["q1"]
    # q1은 맞힘 1번 · 무효 오답 1번뿐: qz의 맞힘 2번으로 다 익힘이 되지 않음
    assert (s["state"], s["streak"], s["reviews"], s["flawTries"]) == ("active", 1, 1, 1)


def test_restoring_starts_from_the_carried_reviews() -> None:
    # 다시 보기 새 문제: 옛 문제의 2번을 이어받고 이 문제를 맞힘 1번 · secured 오답 1번
    inp = flawed_input(unchecked(reviews=4, step=2))
    llm = FakeLlm({"Naturals": SECURED, "Review": [{}, {}, {}]})
    s = updates(run(llm, inp))["q1"]
    # 이어받은 2번 + 남은 1번, step은 저장값 2(다시 세면 1)보다 낮아지지 않음
    assert (s["reviews"], s["streak"], s["step"], s["lastResult"]) == (3, 1, 2, "right")


def test_answers_voided_before_still_restore_the_review_state() -> None:
    # 예전에 무효로 한 secured 오답: 그때 되살리지 않아 연속 정답이 0으로 남은 상태
    inp = flawed_input(unchecked())
    inp["attempts"][1]["answers"][0]["void"] = "문제 오류: 정답 둘(secured도 맞음)"
    llm = FakeLlm({"Naturals": SECURED, "Review": [{}, {}, {}]})
    result = run(llm, inp)
    assert result["voidAnswers"] == []  # 새로 무효로 한 것은 없음
    s = updates(result)["q1"]
    assert (s["streak"], s["lastResult"]) == (1, "right")
    # 옛 무효 풀이는 저장된 reviews(2)에서 아직 빠지지 않음: 남은 맞힘 1번만(이어받은 풀이 없음).
    # step도 남은 맞힘 1번으로 다시 셈
    assert (s["reviews"], s["step"], s["voidedReviews"]) == (1, 0, 1)


def test_restoring_twice_gives_the_same_state() -> None:
    inp = flawed_input(unchecked(reviews=4))
    parsed = today.parse(inp)
    qmaps = {x.id: {y["id"]: y for y in x.questions} for x in parsed.sets}
    q1 = parsed.sets[0].questions[0]
    first, voids = today.void_flawed(parsed.attempts, qmaps, q1, ["secured"])
    assert len(voids) == 1 and (first["reviews"], first["voidedReviews"]) == (3, 1)
    q1["srs"] = first  # 되살린 상태를 저장한 뒤 다시(무효 풀이는 이제 예전 것)
    again, voids = today.void_flawed(parsed.attempts, qmaps, q1, ["secured"])
    assert voids == [] and again == first


def test_flawed_question_is_dropped_after_three_days() -> None:
    llm = FakeLlm({"Naturals": SECURED, "Review": [{}, {}, {}]})
    result = run(llm, flawed_input(unchecked(flawTries=2)))
    s = updates(result)["q1"]
    assert (s["state"], s["dueAt"]) == ("flawed", None)
    assert result["dropped"][0]["state"] == "flawed"


FASTENED = {
    "question": {
        "stem": "빈칸에 알맞은 것은?",
        "passage": "The box was ____ to the shelf so that it would not fall.",
        "options": ["fastened", "extended", "displayed", "stacked", "requested"],
        "answer": "fastened",
        "explanation": "노트 설명",
        "difficulty": "쉬움",
    }
}
CHECK_A = {"answer": "A", "only_one": True, "supported": True}
# SECURED: 저장된 문제는 secured도 빈칸에 맞음. 새 문제(FASTENED)의 보기에는 secured가 없어
# 걸린 보기가 없고 정답은 빈칸에 맞음


def test_flawed_question_is_replaced_by_a_new_one() -> None:
    llm = FakeLlm({"Naturals": SECURED, "Review": [FASTENED], "Check": [CHECK_A]})
    result = run(llm, flawed_input(unchecked()))
    [new] = result["questions"]
    assert (new["answer"], new["choices"][0], len(new["choices"])) == ("fastened", "fastened", 5)
    old = updates(result)["q1"]
    assert (old["state"], old["dueAt"], old["movedTo"]) == ("flawed", None, new["id"])
    assert "secured" in old["flaw"]
    assert result["dropped"][0]["replacedBy"] == new["id"]
    # 새 문제가 복습을 이어 감: 날짜는 그대로, 횟수는 무효 풀이를 뺀 값, 결함 표시는 없음
    assert new["srs"]["dueAt"] == TOMORROW - timedelta(days=1)
    assert new["srs"]["reviews"] == 1 and new["srs"]["state"] == "active"
    assert new["srs"]["checked"] is True
    assert "flaw" not in new["srs"] and "movedTo" not in new["srs"]


def test_question_answered_right_is_replaced_on_the_same_word() -> None:
    # 지난번 맞힌 결함 문제도 원래 정답을 다시 물음: 다른 낱말(request)의 초안은 버림
    request = {
        "question": {
            **FASTENED["question"],
            "passage": "She made a ____ for more time so that she could finish.",
            "options": ["request", "extended", "displayed", "stacked", "fastened"],
            "answer": "request",
        }
    }
    srs = st(TOMORROW - timedelta(days=1), "right")
    del srs["checked"]
    llm = FakeLlm({"Naturals": SECURED, "Review": [request, FASTENED], "Check": [CHECK_A]})
    [new] = run(llm, flawed_input(srs))["questions"]
    assert new["answer"] == "fastened"
    assert "정답은 원래 정답과 같은 'fastened'" in llm.named("Review")[0].user


def test_two_new_questions_made_in_one_run_do_not_overlap() -> None:
    # q1을 바꾼 새 문제(FASTENED)와 거의 같은 q3의 초안은 버림:
    # 같은 실행에서 만든 새 문제와도 겹침 검사
    inp = flawed_input(unchecked())
    q3 = q(
        "q3",
        "request",
        "request의 뜻",
        unchecked(),
        type="빈칸",
        passage="He made a ____ for help.",
        choices=["request", "inform", "order", "stack", "fasten"],
    )
    inp["sets"].append({"id": "s3", "materialId": "m1", "questions": [q3]})
    same = {
        "question": {
            **FASTENED["question"],
            "options": ["request", "extend", "display", "stack", "fasten"],
            "answer": "request",
        }
    }
    check_b = {**CHECK_A, "answer": "B"}  # 세트의 두 번째 문제
    review = [FASTENED, same, {}, {}]  # q3의 2 · 3번째 시도는 모양이 틀려 못 만듦
    # q3는 inform도 맞음(결함). 새 문제들은 걸린 보기 없음
    judge = fits("secured", "fastened", "inform", "request")
    llm = FakeLlm({"Naturals": judge, "Review": review, "Check": [CHECK_A, check_b]})
    result = run(llm, inp)
    assert [x["answer"] for x in result["questions"]] == ["fastened"]
    assert [(d["questionId"], d["replacedBy"] is None) for d in result["dropped"]] == [
        ("q1", False),
        ("q3", True),
    ]


def test_sentence_answer_does_not_avoid_note_group_words() -> None:
    # 짧은 답만 노트 묶음의 유의어를 오답 보기에서 피함(review._similar_for와 같음)
    answer = "요청 동사 뒤에는 동사원형을 쓴다"
    notes = {"m1": [{"pageNo": 1, "ocrText": f"{answer}: insist, demand"}]}
    one = q("q1", answer, "요청", st(TOMORROW))
    inp = today.parse(job({"id": "s1", "materialId": "m1", "questions": [one]}, notes=notes))
    llm = FakeLlm({"Review": [{}, {}, {}]})
    s = inp.sets[0]
    assert today.replace_flawed(llm, [], s, s.questions[0], [], inp.notes, 0) == (None, False)
    assert "오답 보기로" not in llm.named("Review")[0].user


def test_new_question_counts_its_own_flaw_tries() -> None:
    llm = FakeLlm({"Naturals": SECURED, "Review": [FASTENED], "Check": [CHECK_A]})
    [new] = run(llm, flawed_input(unchecked(flawTries=1)))["questions"]
    assert "flawTries" not in new["srs"]


def test_llm_down_while_replacing_puts_only_that_question_off_a_day() -> None:
    inp = flawed_input(unchecked())
    other = q("q2", "stack", "stack의 뜻", st(TOMORROW - timedelta(days=1)))
    inp["sets"][0]["questions"].append(other)
    llm = FakeLlm({"Naturals": SECURED, "Review": [LlmError("HTTP 503")] * 3})
    result = run(llm, inp)
    assert [x["answer"] for x in result["questions"]] == ["stack"]  # 다른 문제는 그대로 냄
    s = updates(result)["q1"]
    assert (s["state"], s["dueAt"], s.get("flawTries")) == ("active", TOMORROW, None)


def test_checker_down_while_replacing_does_not_use_up_a_day() -> None:
    # 1 · 3번째 시도는 검사 모델 호출 실패, 2번째는 생성 호출 실패
    review = [FASTENED, LlmError("HTTP 503"), FASTENED]
    llm = FakeLlm({"Naturals": SECURED, "Review": review, "Check": [LlmError("HTTP 503")] * 2})
    result = run(llm, flawed_input(unchecked()))
    assert result["questions"] == []
    s = updates(result)["q1"]
    assert (s["state"], s["dueAt"], s.get("flawTries")) == ("active", TOMORROW, None)


def test_question_put_off_to_tomorrow_is_not_handed_to_a_same_word_copy() -> None:
    # q1(지난번 틀림)이 먼저: 새 문제 만들기가 LLM 장애로 내일로 미뤄짐
    inp = flawed_input(unchecked())
    other = q("q2", "fastened", "fasten의 뜻", st(TOMORROW - timedelta(days=1)))
    inp["sets"].append({"id": "s2", "materialId": "m1", "questions": [other]})
    llm = FakeLlm({"Naturals": SECURED, "Review": [LlmError("HTTP 503")] * 3})
    result = run(llm, inp)
    assert [x["answer"] for x in result["questions"]] == ["fastened"]  # q2의 사본
    up = updates(result)
    assert (up["q1"]["state"], up["q1"]["dueAt"]) == ("active", TOMORROW)  # 사본으로 넘기지 않음
    assert up["q2"]["state"] == "moved" and result["merged"] == 0
    assert [d["state"] for d in result["dropped"]] == ["active"]


def test_question_put_off_is_not_asked_when_the_check_call_fails() -> None:
    llm = FakeLlm({"Naturals": [LlmError("HTTP 503")] * 2})
    result = run(
        llm, flawed_input(unchecked(flaw="빈칸에 넣어도 말이 되는 오답 보기: secured", flawTries=1))
    )
    assert result["questions"] == []
    s = updates(result)["q1"]
    assert (s["state"], s["dueAt"], s["flawTries"]) == ("active", TOMORROW, 1)
    assert [d["state"] for d in result["dropped"]] == ["active"]


def test_question_put_off_is_not_handed_to_a_copy_when_the_check_call_fails() -> None:
    flaw = "빈칸에 넣어도 말이 되는 오답 보기: secured"
    inp = flawed_input(unchecked(flaw=flaw, flawTries=1))
    other = q("q2", "fastened", "fasten의 뜻", st(TOMORROW - timedelta(days=1)))
    inp["sets"].append({"id": "s2", "materialId": "m1", "questions": [other]})
    result = run(FakeLlm({"Naturals": [LlmError("HTTP 503")] * 2}), inp)
    assert [x["answer"] for x in result["questions"]] == ["fastened"]  # q2의 사본
    up = updates(result)
    assert (up["q1"]["state"], up["q1"]["dueAt"]) == ("active", TOMORROW)
    assert up["q2"]["state"] == "moved" and result["merged"] == 0


def test_question_put_off_the_day_before_is_not_handed_to_a_same_word_copy() -> None:
    # 전날 미룬 q1과 같은 답의 q2(더 오래됨)가 함께 날짜가 됨: q2를 고르고 q1은 같은 낱말이라
    # 건너뜀(검사도 하지 않음). q1은 q2의 사본으로 넘기지 않고 내일 다시 만들어 봄
    inp = flawed_input(unchecked(flaw="빈칸에 넣어도 말이 되는 오답 보기: secured", flawTries=1))
    other = q("q2", "fastened", "fasten의 뜻", st(TOMORROW - timedelta(days=5), "wrong"))
    inp["sets"].append({"id": "s2", "materialId": "m1", "questions": [other]})
    llm = FakeLlm()
    result = run(llm, inp)
    assert [x["answer"] for x in result["questions"]] == ["fastened"]  # q2의 사본
    up = updates(result)
    assert "q1" not in up and up["q2"]["state"] == "moved" and result["merged"] == 0
    assert not llm.calls


def test_check_call_failing_leaves_the_question_unchecked() -> None:
    llm = FakeLlm({"Naturals": [LlmError("HTTP 503")] * 2})
    result = run(llm, flawed_input(unchecked()))
    [x] = result["questions"]
    assert x["answer"] == "fastened" and "checked" not in x["srs"]  # 다음에 다시 검사
    assert result["dropped"] == [] and result["voidAnswers"] == []


def test_without_note_text_unchecked_questions_are_asked_as_they_are() -> None:
    inp = {**flawed_input(unchecked()), "notes": {}}
    llm = FakeLlm()
    result = run(llm, inp)
    assert [x["answer"] for x in result["questions"]] == ["fastened"]
    assert result["dropped"] == [] and not llm.calls


def test_short_answer_question_is_not_checked() -> None:
    old = q("q1", "stack", "stack의 뜻", unchecked(), choices=None)
    result = run(FakeLlm(), job({"id": "s1", "materialId": "m1", "questions": [old]}))
    assert [x["answer"] for x in result["questions"]] == ["stack"]


# ---------- input 확인 ----------


def broken(change: str) -> JsonObject:
    inp = copy.deepcopy(ordering_input())
    if change == "day":
        inp["day"] = "오늘"
    elif change == "week day":
        inp["day"] = "2026-W44-5"  # date.fromisoformat은 받음
    elif change == "compact day":
        inp["day"] = "20261030"
    elif change == "size":
        inp["size"] = 0
    elif change == "bool size":
        inp["size"] = True
    elif change == "answer":
        inp["attempts"][0]["answers"][0]["answer"] = 3
    elif change == "finishedAt":
        inp["attempts"][0]["finishedAt"] = "어제"
    elif change == "set id":
        del inp["sets"][0]["id"]
    elif change == "notes":
        inp["notes"] = []
    elif change == "null flawTries":
        inp["sets"][0]["questions"][0]["srs"]["flawTries"] = None
    elif change == "text voidedReviews":
        inp["sets"][0]["questions"][0]["srs"]["voidedReviews"] = "1"
    return inp


@pytest.mark.parametrize(
    "change",
    [
        "day",
        "week day",
        "compact day",
        "size",
        "bool size",
        "answer",
        "finishedAt",
        "set id",
        "notes",
        "null flawTries",
        "text voidedReviews",
    ],
)
def test_bad_input_fails_at_once(change: str) -> None:
    with pytest.raises(InputError):
        run(FakeLlm(), broken(change))
