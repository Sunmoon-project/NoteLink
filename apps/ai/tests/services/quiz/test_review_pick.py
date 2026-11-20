"""오답 복습 작업(similar_quiz)의 고른 문제 모드(#605).

사용자가 고른 문제 전체를 함께 참고해 유사 퀴즈를 총 3문제 만든다. 복습 상태(srs)는 옮기지 않는다.
"""

import re
from typing import Any

import pytest

from app.clients.llm import JsonObject, LlmError
from app.services.quiz import review
from tests.fakes import FakeLlm

PAGE = """요청 동사 뒤에는 동사원형을 쓴다
request that he be informed
쌓다 = stack
# stock
fasten - 고정하다"""


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


def pick_input(*picks: tuple[str, str, bool]) -> JsonObject:
    """s1(m1)에 q1(be) · q2(stack) · q3(fasten), s2(m1)에 q4(request). picks: (세트, 문제, 틀림)."""
    return {
        "mode": "pick",
        "picks": [{"quizSetId": s, "questionId": qid, "wrong": w} for s, qid, w in picks],
        "sets": [
            {
                "id": "s1",
                "materialId": "m1",
                "questions": [
                    q("q1", 1, "be", "요청 동사 뒤 동사원형", srs={}),
                    q("q2", 2, "stack", "stack의 뜻"),
                    q("q3", 3, "fasten", "fasten의 뜻"),
                ],
            },
            {"id": "s2", "materialId": "m1", "questions": [q("q4", 1, "request", "request의 뜻")]},
        ],
        "notes": {"m1": [{"pageNo": 1, "ocrText": PAGE}]},
    }


PASSAGES = iter(f"장면 {i}: 서로 다른 상황 {i}번" for i in range(100))


def drafts(*answers: str) -> list[JsonObject]:
    """생성 모델의 답을 차례로. 제시문은 모두 달라 겹침 검사에 걸리지 않는다.

    오답 보기는 노트에서 정답과 같은 줄(묶음)의 낱말을 피한다(quality.screen에 걸리지 않게).
    """
    wrongs = {
        "be": ["is", "are", "was", "been"],
        "request": ["stack", "fasten", "order", "allow"],
    }
    out = []
    for a in answers:
        options = [
            a,
            *wrongs.get(
                a, [w for w in ["stack", "fasten", "request", "inform", "order"] if w != a][:4]
            ),
        ]
        out.append(
            {
                "question": {
                    "stem": "알맞은 것을 고르시오.",
                    "passage": next(PASSAGES),
                    "options": options,
                    "answer": a,
                    "explanation": "노트 설명",
                    "difficulty": "쉬움",
                }
            }
        )
    return out


def solver(user: str) -> JsonObject:
    """검사 모델: 보기 중 '[정답 X]'로 알려 준 낱말이 놓인 자리를 고른다."""
    answer = re.search(r"\[정답 (\w+)\]", user)
    lines = re.findall(r"^([A-E])\. (.*)$", user, re.M)
    want = answer.group(1) if answer else None
    for letter, text in lines:
        if text == want:
            return {"answer": letter, "only_one": True, "supported": True}
    return {"answer": "없음", "only_one": False, "supported": False}


def llm_for(*answers: str) -> FakeLlm:
    """만든 문제의 정답을 차례로 내고, 검사 모델은 그 정답 자리를 고른다."""
    made = drafts(*answers)
    queue = list(made)
    current: list[str] = []

    def review_call(_: str) -> JsonObject:
        d = queue.pop(0)
        current.append(d["question"]["answer"])
        return d

    def check_call(user: str) -> JsonObject:
        return solver(user + f"\n[정답 {current[-1]}]")

    return FakeLlm({"Review": review_call, "Check": check_call})


def run(llm: FakeLlm, inp: JsonObject) -> JsonObject:
    return review.run(llm, inp, lambda v, step=None: None)


def test_picked_questions_make_three_questions_in_total() -> None:
    # 틀린 문제(q2 · q1)부터, 고른 순서대로. 고른 문제마다 1개가 아니라 모두 합쳐 3문제
    llm = llm_for("stack", "be", "fasten")
    result = run(llm, pick_input(("s1", "q2", True), ("s1", "q3", False), ("s1", "q1", True)))
    assert [t["questionId"] for t in result["targets"]] == ["q2", "q1", "q3"]
    assert [x["answer"] for x in result["reviewQuestions"]] == ["stack", "be", "fasten"]
    assert [x["order"] for x in result["reviewQuestions"]] == [1, 2, 3]
    assert result["emptyReason"] is None


def test_every_prompt_sees_all_picked_questions() -> None:
    llm = llm_for("stack", "be", "fasten")
    run(llm, pick_input(("s1", "q2", True), ("s1", "q3", False), ("s1", "q1", True)))
    calls = llm.named("Review")
    assert len(calls) == 3
    for c in calls:
        for concept in ("stack의 뜻", "fasten의 뜻", "요청 동사 뒤 동사원형"):
            assert f"{concept}에 알맞은 것은?" in c.user


def test_one_or_two_picks_still_make_three_questions() -> None:
    # 같은 문제를 다시 바탕으로 쓸 때는 다른 답을 물어도 된다(같은 답이면 세트 안에서 겹침)
    llm = llm_for("be", "request", "stack")
    result = run(llm, pick_input(("s1", "q1", True)))
    assert len(result["reviewQuestions"]) == 3
    assert [t["questionId"] for t in result["targets"]] == ["q1", "q1", "q1"]
    assert len({x["answer"] for x in result["reviewQuestions"]}) == 3


def test_more_than_three_picks_use_three_of_them_wrong_first() -> None:
    llm = llm_for("stack", "request", "be")
    result = run(
        llm,
        pick_input(
            ("s1", "q3", False), ("s1", "q2", True), ("s2", "q4", True), ("s1", "q1", False)
        ),
    )
    assert [t["questionId"] for t in result["targets"]] == ["q2", "q4", "q3"]
    assert len(result["reviewQuestions"]) == 3


def test_pick_mode_does_not_move_review_dates() -> None:
    llm = llm_for("be", "request", "stack")
    result = run(llm, pick_input(("s1", "q1", True)))
    assert result["srsUpdates"] == []
    assert all("srs" not in x for x in result["reviewQuestions"])
    assert result["answers"] == [] and result["weakConcepts"] == [] and result["noteLines"] == []


def test_a_pick_that_fails_moves_on_to_the_next_one() -> None:
    # q2가 3번 모두 장애여도 다른 고른 문제로 3문제를 채운다
    made = drafts("be", "fasten", "request")
    answers: list[Any] = [LlmError("HTTP 503")] * 3 + made
    current: list[str] = []

    def review_call(_: str) -> JsonObject:
        a = answers.pop(0)
        if isinstance(a, LlmError):
            raise a
        current.append(a["question"]["answer"])
        return a

    llm = FakeLlm({"Review": review_call, "Check": lambda u: solver(u + f"\n[정답 {current[-1]}]")})
    result = run(llm, pick_input(("s1", "q2", True), ("s1", "q1", True), ("s1", "q3", False)))
    assert len(result["reviewQuestions"]) == 3
    assert [t["made"] for t in result["targets"]][0] is False


def test_llm_down_for_every_pick_raises_so_the_job_is_retried() -> None:
    llm = FakeLlm({"Review": [LlmError("HTTP 503")] * 30})
    with pytest.raises(LlmError):
        run(llm, pick_input(("s1", "q1", True)))
    # 고른 문제가 하나여도 끝없이 부르지 않는다(최대 6번 바탕 × 3번 시도)
    assert len(llm.named("Review")) <= 18


@pytest.mark.parametrize(
    "picks",
    [[], [{"quizSetId": "s1", "questionId": "nope", "wrong": True}], [{"quizSetId": "s1"}]],
)
def test_bad_picks_fail_at_once(picks: list[Any]) -> None:
    inp = pick_input()
    inp["picks"] = picks
    with pytest.raises(review.InputError):
        run(FakeLlm(), inp)


def test_a_reused_seed_is_not_said_to_be_answered_right() -> None:
    # 틀린 문제를 다시 바탕으로 쓸 때 「학생은 지난번에 맞혔다」고 하지 않는다(code-review)
    llm = llm_for("be", "request", "stack")
    run(llm, pick_input(("s1", "q1", True)))
    first, *again = [c.user for c in llm.named("Review")]
    assert "학생은 이 문제를 틀렸다" in first
    for user in again:
        assert "복습하려고 고른 문제다" in user and "맞혔다" not in user


def test_the_picked_question_itself_is_never_handed_back() -> None:
    # 모델이 원래 문제만 다시 써서(겹침 검사 탈락) 새로 못 만들어도
    # 고른 그 문제를 그대로 내지 않는다(code-review)
    copy = {
        "question": {
            "stem": "요청 동사 뒤 동사원형에 알맞은 것은?",
            "passage": "",
            "options": ["be", "is", "are", "was", "been"],
            "answer": "be",
            "explanation": "노트 설명",
            "difficulty": "쉬움",
        }
    }
    llm = FakeLlm({"Review": lambda _: copy})
    result = run(llm, pick_input(("s1", "q1", True)))
    assert result["reviewQuestions"] == []
    assert all(t["reusedFrom"] is None for t in result["targets"])
    assert result["emptyReason"] == "rejected"
