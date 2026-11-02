import pytest

from app.clients.llm import JsonObject, LlmError
from app.core.config import settings
from app.services.quiz import similar
from app.services.quiz.checks import Seen, Target, seen_question
from app.services.quiz.models import Draft, Question
from tests.fakes import FakeLlm

PAGE = """요청 동사 뒤에는 동사원형을 쓴다
request that he be informed
쌓다 = stack
# stock"""


def question(
    answer: str = "be",
    qtype: str | None = "규칙",
    qid: str = "q1",
    prompt: str = "요청 동사 뒤에 알맞은 형태는?",
) -> Question:
    return {
        "id": qid,
        "order": 1,
        "type": qtype,
        "prompt": prompt,
        "choices": [answer, "is", "are", "was", "been"],
        "answer": answer,
        "conceptTags": ["요청 동사 뒤 동사원형"],
    }


def target(answer: str = "be") -> Target:
    return Target("wrong", answer, "요청 동사 뒤 동사원형")


def gen(
    options: list[str], answer: str = "be", stem: str = "알맞은 형태를 고르시오."
) -> JsonObject:
    return {
        "question": {
            "stem": stem,
            "passage": "그는 정보를 받도록 요청했다",
            "options": options,
            "answer": answer,
            "explanation": "요청 동사 뒤에는 동사원형을 쓴다.",
            "difficulty": "쉬움",
        }
    }


GOOD = ["be", "is", "are", "was", "been"]
FOUR = ["be", "is", "are", "was"]


def check(letter: str) -> JsonObject:
    return {"answer": letter, "only_one": True, "supported": True}


def test_a_draft_that_passes_every_check_is_placed_by_slot() -> None:
    seen: list[Seen] = []
    llm = FakeLlm({"Review": [gen(GOOD)], "Check": [check("C")]})
    m = similar.make_similar(llm, question(), target(), 1, PAGE, 2, seen)
    assert m.question is not None
    assert (m.answer_pos, m.question["options"][2], m.type, m.tries) == ("C", "be", "규칙", 1)
    assert m.why == [] and not m.llm_down
    assert len(seen) == 1  # 같은 세트의 다음 문제가 겹침 검사에 씀
    gen_call, check_call = llm.calls
    assert gen_call.model == settings.quiz_gen_model
    assert '<노트 쪽="1">' in gen_call.user and "원래 정답: be" in gen_call.user
    assert "정답은 원래 정답과 같은 'be'로" in gen_call.user
    assert check_call.model == settings.quiz_check_model
    assert "C. be" in check_call.user


def test_failed_tries_switch_type_and_carry_the_reasons() -> None:
    llm = FakeLlm({"Review": [gen(FOUR), gen(FOUR), gen(FOUR)]})
    m = similar.make_similar(llm, question(qtype="어휘"), target(), 1, PAGE, 0, [])
    assert m.question is None and m.tries == 3 and not m.llm_down
    assert m.why == ["보기 5개가 아니거나 겹침"]
    first, second, third = (c.user for c in llm.named("Review"))
    assert "문제 유형: 어휘" in first and "문제점" not in first
    assert "문제 유형: 빈칸" in second  # 두 번째는 다른 유형
    assert "앞서 만든 문제의 문제점: 보기 5개가 아니거나 겹침" in second
    assert similar.RETRY_TIP in second  # 빈칸 문장에는 단서 절 안내
    assert "문제 유형: 어휘" in third and similar.LAST_TIP in third


def test_retry_tip_is_for_blank_sentences_only() -> None:
    llm = FakeLlm({"Review": [gen(FOUR), gen(FOUR), gen(FOUR)]})
    similar.make_similar(llm, question(qtype="묘사"), target(), 1, PAGE, 0, [])
    first, second, third = (c.user for c in llm.named("Review"))
    assert similar.RETRY_TIP in second  # 묘사 → 어휘
    assert similar.RETRY_TIP not in third and similar.LAST_TIP not in third


def test_unknown_type_is_asked_as_a_rule_question() -> None:
    llm = FakeLlm({"Review": [gen(FOUR), gen(FOUR), gen(FOUR)]})
    similar.make_similar(llm, question(qtype="단답형"), target(), 1, PAGE, 0, [])
    assert "문제 유형: 규칙" in llm.calls[0].user


def test_a_wrong_answer_from_the_checker_fails_the_try() -> None:
    llm = FakeLlm({"Review": [gen(GOOD), gen(FOUR), gen(GOOD)], "Check": [check("B"), check("A")]})
    m = similar.make_similar(llm, question(), target(), 1, PAGE, 0, [])
    assert m.question is not None and m.tries == 3
    assert "검사 탈락(검수자 답 B)" in llm.named("Review")[1].user


def test_checker_must_say_only_one_and_supported() -> None:
    weak = {"answer": "A", "only_one": False, "supported": True}
    llm = FakeLlm({"Review": [gen(GOOD), gen(FOUR), gen(FOUR)], "Check": [weak]})
    assert similar.make_similar(llm, question(), target(), 1, PAGE, 0, []).question is None


def test_llm_down_on_every_try_is_reported() -> None:
    llm = FakeLlm({"Review": [LlmError("HTTP 503")] * 3})
    m = similar.make_similar(llm, question(), target(), 1, PAGE, 0, [])
    assert m.question is None and m.llm_down and m.why == ["HTTP 503"]


def test_a_malformed_answer_is_a_failed_try_not_a_crash() -> None:
    llm = FakeLlm({"Review": [{"question": {"stem": 1}}, {}, gen(FOUR)]})
    m = similar.make_similar(llm, question(), target(), 1, PAGE, 0, [])
    assert m.question is None and not m.llm_down and m.why == ["보기 5개가 아니거나 겹침"]


def test_drafts_too_close_to_an_existing_question_are_kept_for_reuse() -> None:
    q = question()
    seen = [seen_question(q)]
    same = gen(GOOD, stem=q["prompt"])
    same["question"]["passage"] = ""
    llm = FakeLlm({"Review": [same, same, same]})
    m = similar.make_similar(llm, q, target(), 1, PAGE, 0, seen)
    assert m.question is None and len(m.drafts) == 3
    assert similar.TOO_CLOSE in m.why


def test_flagged_options_are_avoided_in_the_next_try() -> None:
    q = question("stack")
    q["prompt"] = "쌓다의 뜻을 가진 낱말은?"
    bad = gen(["stack", "stock", "fasten", "order", "move"], answer="stack")
    llm = FakeLlm({"Review": [bad, gen(FOUR, "stack"), gen(FOUR, "stack")], "Repair": [{}]})
    similar.make_similar(llm, q, target("stack"), 1, PAGE, 0, [])
    assert "오답 보기로 stock와 그 변형" in llm.named("Review")[1].user


# ---------- 기존 문제 다시 내기 ----------


def draft(stem: str) -> Draft:
    return {"stem": stem, "passage": "", "options": GOOD, "answer": "be"}


def test_reuse_picks_the_existing_question_closest_to_the_drafts() -> None:
    q = question(qid="q1")
    near = question(qid="q2", prompt="요청 뒤 동사의 알맞은 형태를 고르시오")
    other = question("stack", qid="q3", prompt="요청 뒤 동사의 알맞은 형태를 고르시오")
    seen = [seen_question(x) for x in (q, near, other)]
    got = similar.reuse_existing(q, [draft("요청 뒤 동사의 알맞은 형태를 고르시오")], seen, [])
    assert got is not None and got["id"] == "q2"


def test_reuse_needs_the_very_same_answer_not_one_inside_another() -> None:
    # same_item은 port ~ report도 같게 봄: 그 기존 문제를 넘기면 오답과 무관한 문제가 moved가 됨
    q = question("port", qid="q1")
    near = question("report", qid="q2", prompt="요청 뒤 동사의 알맞은 형태를 고르시오")
    seen = [seen_question(q), seen_question(near)]
    got = similar.reuse_existing(q, [draft("요청 뒤 동사의 알맞은 형태를 고르시오")], seen, [])
    assert got is not None and got["id"] == "q1"
    # 대소문자 · 공백만 다른 같은 답은 그대로 같은 답
    same = question(" Port ", qid="q3", prompt="요청 뒤 동사의 알맞은 형태를 고르시오")
    got = similar.reuse_existing(
        q, [draft("요청 뒤 동사의 알맞은 형태를 고르시오")], [*seen, seen_question(same)], []
    )
    assert got is not None and got["id"] == "q3"


@pytest.mark.parametrize(("missed", "other"), [("1.5", "15"), ("-3", "3"), ("3-5", "35")])
def test_reuse_does_not_merge_different_numbers(missed: str, other: str) -> None:
    # norm은 1.5 ~ 15, -3 ~ 3, 3-5 ~ 35를 같게 봄: 다른 수의 기존 문제는 넘기지 않음
    q = question(missed, qid="q1")
    near = question(other, qid="q2", prompt="요청 뒤 동사의 알맞은 형태를 고르시오")
    got = similar.reuse_existing(
        q,
        [draft("요청 뒤 동사의 알맞은 형태를 고르시오")],
        [seen_question(q), seen_question(near)],
        [],
    )
    assert got is not None and got["id"] == "q1"


def test_reuse_skips_answers_norm_empties() -> None:
    # '/' · '-'는 norm하면 빈 글이라 서로 같아짐: 같은 답으로 보지 않음
    q = question("/", qid="q1")
    other = question("-", qid="q2")
    assert similar.reuse_existing(q, [], [seen_question(q), seen_question(other)], []) is None


def test_reuse_falls_back_to_the_question_just_missed() -> None:
    q = question(qid="q1")
    far = question(qid="q2", prompt="전혀 다른 문장")
    seen = [seen_question(far), seen_question(q)]
    got = similar.reuse_existing(q, [draft("완전히 새로운 상황의 문제")], seen, [])
    assert got is not None and got["id"] == "q1"


def test_reuse_skips_answers_used_in_the_set_and_sentence_answers() -> None:
    q = question(qid="q1")
    assert similar.reuse_existing(q, [], [seen_question(q)], ["be"]) is None
    long = question("요청 동사 뒤에는 동사원형을 쓴다", qid="q9")
    assert similar.reuse_existing(long, [], [seen_question(long)], []) is None


def test_reuse_skips_questions_no_longer_in_review() -> None:
    q = question(qid="q1")
    for state in ("moved", "mastered", "stopped", "flawed"):
        old = question(qid="q2", prompt="요청 뒤 동사의 알맞은 형태를 고르시오")
        old["srs"] = {
            "step": 0, "dueAt": None, "lastResult": "wrong", "streak": 0, "reviews": 2,
            "state": state,
        }  # fmt: skip
        got = similar.reuse_existing(
            q, [draft("요청 뒤 동사의 알맞은 형태를 고르시오")], [seen_question(old)], []
        )
        assert got is None, state


def test_reuse_takes_a_question_whose_srs_has_no_state() -> None:
    q = question(qid="q1")
    old = question(qid="q2", prompt="요청 뒤 동사의 알맞은 형태를 고르시오")
    old["srs"] = {"step": 0, "dueAt": None, "lastResult": "wrong", "streak": 0, "reviews": 1}  # type: ignore[typeddict-item]
    got = similar.reuse_existing(
        q, [draft("요청 뒤 동사의 알맞은 형태를 고르시오")], [seen_question(old)], []
    )
    assert got is not None and got["id"] == "q2"


def test_reuse_leaves_out_what_the_caller_skips() -> None:
    q = question(qid="q1")
    seen = [seen_question(q)]
    assert similar.reuse_existing(q, [draft("새 문제")], seen, [], skip={"q1"}) is None
