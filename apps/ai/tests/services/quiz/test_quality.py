import pytest

from app.clients.llm import JsonObject, LlmError, LlmRejectedError
from app.core.config import settings
from app.services.quiz import quality as qa
from app.services.quiz.models import Draft
from tests.fakes import FakeLlm, fits

PAGE = """쌓다 = stack
# stock
installation - 설치
instalment - 할부
be being V+ed 사람 없는 사진
organize = arrange"""


def reasons(
    llm: FakeLlm, d: Draft, page: str, qtype: str | None = None, hits: list[str] | None = None
) -> list[str]:
    """screen의 탈락 이유만."""
    return qa.screen(llm, d, page, qtype, hits)[0]


def draft(passage: str, options: list[str], answer: str) -> Draft:
    return {
        "stem": "알맞은 것을 고르시오.",
        "passage": passage,
        "options": options,
        "answer": answer,
    }


def natural(*values: bool | LlmError) -> list[JsonObject | LlmError]:
    """보기 하나씩 묻는 판정(Natural, 묶은 판정의 답 모양이 틀렸을 때)."""
    return [v if isinstance(v, LlmError) else {"natural": v} for v in values]


def verdicts(*values: bool) -> JsonObject:
    """묶은 판정(Naturals) 한 번의 답: 보기 순서대로."""
    return {"natural": list(values)}


# ---------- 노트 묶음 (코드) ----------


def test_groups_join_lines_continued_by_equals_or_hash() -> None:
    assert qa.groups(PAGE)[0] == ["쌓다 = stack", "# stock"]
    # '-'는 대비라 묶음을 잇지 않음
    assert ["installation - 설치"] in qa.groups(PAGE)


def test_group_words_are_the_answers_synonyms() -> None:
    assert qa.group_words("stacked", PAGE) == ["stock"]
    assert qa.group_words("installation", PAGE) == []


def test_short_word_does_not_match_inside_be_being() -> None:
    assert qa.group_words("be", PAGE) == []


@pytest.mark.parametrize(
    ("word", "line", "found"),
    [
        ("stack", "stacked boxes", True),
        ("stacked", "쌓다 = stack", True),
        ("organizing", "organize = arrange", True),
        ("stop", "stopped", True),
        ("stack up", "stack-up", True),
        ("shipyard", "ship yard: 조선소", True),
        ("세포", "세포막", True),  # 한국어는 그대로
        ("cell", "cellulose - 셀룰로스", False),
        ("form", "format - 형식", False),
        ("fast", "fastened", False),
        ("range", "arrange", False),
    ],
)
def test_long_word_matches_only_whole_word_with_inflection(
    word: str, line: str, found: bool
) -> None:
    assert qa._has(line, word) is found


def test_word_inside_a_longer_word_is_not_its_group() -> None:
    page = "cell - 세포\ncellulose - 셀룰로스"
    opts = ["cell", "cellulose", "enzyme", "protein", "lipid"]
    assert qa.group_conflict("cell", opts, page) == []
    assert qa.group_words("form", "form - 형태\nformat = layout") == []


def test_word_with_apostrophe_finds_its_group() -> None:
    assert qa._has("one's own = personal", "one's own")
    opts = ["one's own", "personal", "public", "shared", "common"]
    assert qa.group_conflict("one's own", opts, "one's own = personal") == ["personal"]


def test_contrasts_are_gloss_pairs_near_the_answer() -> None:
    assert qa.contrasts("installation", PAGE) == ["instalment"]


def test_same_gloss_is_a_synonym_not_a_contrast() -> None:
    assert qa.contrasts("begin", "begin - 시작하다\nstart - 시작하다") == []
    d = draft("The meeting will ____ at noon.", ["begin", "start", "a", "b", "c"], "begin")
    llm = FakeLlm({"Naturals": fits("start", "begin")})
    assert reasons(llm, d, "begin - 시작하다\nstart - 시작하다", "빈칸") == [
        "빈칸에 넣어도 말이 되는 오답 보기: start"
    ]


def test_group_conflict_flags_wrong_option_in_answers_group() -> None:
    opts = ["stacked", "stock", "folded", "painted", "cleared"]
    assert qa.group_conflict("stacked", opts, PAGE) == ["stock"]
    assert qa.group_conflict("산소 없이 증식한다", opts, PAGE) == []  # 문장 답은 보지 않음


# ---------- 정답 둘 검사 (LLM) ----------


def test_blank_option_that_also_fits_is_rejected_and_collected() -> None:
    d = draft("The rope was ____ to the post.", ["fastened", "secured", "a", "b", "c"], "fastened")
    llm = FakeLlm({"Naturals": fits("secured", "fastened")})
    hits: list[str] = []
    assert reasons(llm, d, PAGE, "빈칸", hits) == ["빈칸에 넣어도 말이 되는 오답 보기: secured"]
    assert hits == ["secured"]
    assert {c.model for c in llm.calls} == {settings.quiz_check_model}


def test_all_options_and_the_answer_are_judged_in_one_call_per_model() -> None:
    d = draft("The rope was ____ to the post.", ROPE_OPTIONS, "fastened")
    llm = FakeLlm({"Naturals": fits("fastened")})
    assert qa.screen(llm, d, PAGE, "빈칸") == ([], "")
    # 검사 모델 한 번 · 생성 모델(2차 판정) 한 번. 정답 판정은 검사 모델의 호출에서
    assert [(c.name, c.model) for c in llm.calls] == [
        ("Naturals", settings.quiz_check_model),
        ("Naturals", settings.quiz_gen_model),
    ]
    assert llm.calls[0].user == (
        "문장: The rope was ____ to the post.\n빈칸에 넣을 표현 후보:\n"
        "1. fastened\n2. secured\n3. extended\n4. displayed\n5. stacked"
    )
    assert llm.calls[0].schema["properties"]["natural"]["minItems"] == 5
    assert "후보마다 따로 판단한다" in llm.calls[0].system


def test_second_judge_runs_when_check_model_finds_nothing() -> None:
    d = draft("The rope was ____ to the post.", ["fastened", "extended", "a", "b", "c"], "fastened")
    # 검사 모델은 모두 false → 생성 모델이 extended를 잡음
    llm = FakeLlm(
        {
            "Naturals": [
                verdicts(True, False, False, False, False),
                verdicts(False, True, *[False] * 3),
            ]
        }
    )
    assert reasons(llm, d, PAGE, "빈칸") == ["빈칸에 넣어도 말이 되는 오답 보기: extended"]
    assert llm.calls[1].model == settings.quiz_gen_model


def test_answer_itself_must_fit_the_blank() -> None:
    d = draft("The team will ____ the road.", ["resurfacing", "a", "b", "c", "d"], "resurfacing")
    llm = FakeLlm({"Naturals": fits()})  # 정답도 빈칸에 맞지 않음
    assert reasons(llm, d, PAGE, "빈칸") == ["정답을 빈칸에 넣으면 문장이 틀림"]
    assert len(llm.calls) == 2  # 정답을 따로 묻지 않음


def test_note_contrast_pair_is_not_checked() -> None:
    d = draft("We paid the ____.", ["installation", "instalment", "a", "b", "c"], "installation")
    llm = FakeLlm({"Naturals": fits("installation")})
    assert reasons(llm, d, PAGE, "빈칸") == []
    assert all("instalment" not in c.user for c in llm.calls)


def test_note_group_conflict_is_reported_with_llm_result() -> None:
    d = draft("The boxes are ____.", ["stacked", "stock", "a", "b", "c"], "stacked")
    llm = FakeLlm({"Naturals": fits()})
    assert reasons(llm, d, PAGE, "빈칸") == ["노트에서 정답과 같은 묶음인 보기: stock"]


def test_answer_option_with_different_case_is_not_a_wrong_option() -> None:
    opts = ["Stacked", "stock", "folded", "painted", "cleared"]
    assert qa.group_conflict("stacked", opts, PAGE) == ["stock"]
    d = draft("The rope was ____ to the post.", ["Fastened", "tied", "a", "b", "c"], "fastened")
    # 'Fastened'가 자연스럽다는 판정은 정답 판정: 걸린 오답 보기가 아님
    llm = FakeLlm({"Naturals": fits("Fastened")})
    hits: list[str] = []
    assert reasons(llm, d, PAGE, "빈칸", hits) == []
    assert hits == []


def test_a_malformed_batch_verdict_asks_each_option() -> None:
    d = draft("The rope was ____ to the post.", ROPE_OPTIONS, "fastened")
    # 검사 모델의 묶은 답이 보기 수와 다름 → 보기마다(정답 포함) 따로 물어 secured를 잡음
    llm = FakeLlm(
        {"Naturals": [verdicts(False, True)], "Natural": natural(True, True, False, False, False)}
    )
    assert reasons(llm, d, PAGE, "빈칸") == ["빈칸에 넣어도 말이 되는 오답 보기: secured"]
    assert [c.user.rsplit(": ", 1)[-1] for c in llm.named("Natural")] == ROPE_OPTIONS


def test_reason_matches_the_check_type() -> None:
    # 빈칸이 없는 정의 문제에 '빈칸에 넣어도…'라고 쓰면 재시도 지시가 엉뚱해짐
    d = draft(
        "산소 없이 증식하는 세균", ["무산소성 세균", "통성 세균", "a", "b", "c"], "무산소성 세균"
    )
    llm = FakeLlm({"Naturals": fits("통성 세균")})
    assert reasons(llm, d, PAGE, "정의") == ["설명에 함께 해당하는 오답 보기: 통성 세균"]
    d = draft("쌓다", ["stack", "pile", "a", "b", "c"], "stack")
    llm = FakeLlm({"Naturals": fits("pile")})
    assert reasons(llm, d, "", "어휘") == ["같은 뜻으로 쓰이는 오답 보기: pile"]
    d = draft("황색포도알균", ["그람양성균", "구균", "a", "b", "c"], "그람양성균")
    llm = FakeLlm({"Naturals": fits("구균")})
    assert reasons(llm, d, "", "분류") == ["용어가 함께 속하는 오답 분류: 구균"]


def test_term_subject_checks_the_right_answer_too() -> None:
    d = draft(
        "항산성균",
        ["보통 염색으로 쉽게 염색된다", "a", "b", "c", "d"],
        "보통 염색으로 쉽게 염색된다",
    )
    llm = FakeLlm({"Naturals": fits()})
    assert reasons(llm, d, PAGE, "특징") == [
        "정답이 일반 전공 지식과 맞지 않음(노트 OCR 오류 가능)"
    ]
    assert len(llm.calls) == 1  # 용어 과목은 2차 판정이 없고, 정답도 같은 호출에서
    assert llm.calls[0].user.startswith("용어: 항산성균\n문장 후보:\n1. 보통 염색으로")


def test_scene_questions_skip_the_llm_check() -> None:
    d = draft(
        "고객이 병을 닫고 있다.", ["A customer is closing a bottle.", "a", "b", "c", "d"], "a"
    )
    llm = FakeLlm()
    assert reasons(llm, d, PAGE, "묘사") == []
    assert llm.calls == []


def test_failed_llm_calls_do_not_flag_options() -> None:
    d = draft("The rope was ____ to the post.", ["fastened", "secured", "a", "b", "c"], "fastened")
    llm = FakeLlm({"Naturals": [LlmError("HTTP 503")] * 2})
    assert reasons(llm, d, PAGE, "빈칸") == []
    assert len(llm.calls) == 2  # 장애에 보기마다 다시 보내지 않음


# ---------- 걸린 오답 보기만 바꾸기 (repair · checked) ----------

# 장면 · 규칙 문제(빈칸 아님)는 LLM 검사 없이 노트 묶음만 봄: 호출 순서를 정하기 쉬움
SCENE = "상자를 쌓는 상황"


def no_conflict(d: Draft) -> tuple[list[str], int | None]:
    return [], d["options"].index(d["answer"])


def test_repair_swaps_only_the_flagged_options() -> None:
    d = draft(SCENE, ["stack", "stock", "fasten", "order", "move"], "stack")
    llm = FakeLlm({"Repair": [{"options": ["lift"]}]})
    fixed = qa.repair(llm, d, {"stock"}, ["노트 묶음"], PAGE, avoid=["pile"])
    assert fixed is not None
    assert fixed["options"] == ["stack", "lift", "fasten", "order", "move"]
    assert (fixed["stem"], fixed["passage"], fixed["answer"]) == (d["stem"], SCENE, "stack")
    user = llm.calls[0].user
    assert "바꿀 오답 보기: stock" in user and "쓰지 않을 말: pile, stock" in user
    assert llm.calls[0].model == settings.quiz_gen_model


@pytest.mark.parametrize(
    ("hits", "new"),
    [
        (set(), None),  # 걸린 보기 없음
        ({"stock", "fasten", "order"}, None),  # 3개 이상: 문장 자체를 새로 만들어야 함
        ({"stack"}, None),  # 정답은 바꾸지 않음
    ],
)
def test_repair_gives_up_without_a_call(hits: set[str], new: None) -> None:
    d = draft(SCENE, ["stack", "stock", "fasten", "order", "move"], "stack")
    llm = FakeLlm()
    assert qa.repair(llm, d, hits, ["x"], PAGE) is new
    assert llm.calls == []


@pytest.mark.parametrize(
    "answer",
    [
        [{"options": ["stocks"]}],  # 피할 말의 변형
        [{"options": ["a", "b"]}],  # 개수가 다름
        [{"options": [3]}],  # 모양이 틀림
        [LlmError("HTTP 503")],
    ],
)
def test_repair_returns_none_when_the_new_option_is_unusable(
    answer: list[JsonObject | LlmError],
) -> None:
    d = draft(SCENE, ["stack", "stock", "fasten", "order", "move"], "stack")
    assert qa.repair(FakeLlm({"Repair": answer}), d, {"stock"}, ["x"], PAGE) is None


def test_checked_passes_a_clean_draft_without_repair() -> None:
    d = draft(SCENE, ["stack", "fasten", "order", "move", "lift"], "stack")
    llm = FakeLlm()
    assert qa.checked(llm, d, no_conflict, PAGE, "규칙") == (d, [], None, False, "")
    assert llm.calls == []


def test_checked_repairs_and_rechecks() -> None:
    d = draft(SCENE, ["fasten", "stock", "stack", "order", "move"], "stack")
    hits: list[str] = []
    llm = FakeLlm({"Repair": [{"options": ["lift"]}]})
    fixed, why, k, repaired, unchecked = qa.checked(llm, d, no_conflict, PAGE, "규칙", hits=hits)
    assert (fixed["options"], why, k, repaired, unchecked) == (
        ["fasten", "lift", "stack", "order", "move"],
        [],
        2,
        True,
        "",
    )
    assert hits == ["stock"]  # 다음 시도에서 피할 낱말


def test_checked_keeps_the_first_reasons_when_the_repair_fails_again() -> None:
    d = draft(SCENE, ["stack", "stock", "fasten", "order", "move"], "stack")
    llm = FakeLlm({"Repair": [{"options": ["lift"]}]})

    def code_fails(x: Draft) -> tuple[list[str], int | None]:
        return ["보기 5개가 아니거나 겹침"], None

    out = qa.checked(llm, d, code_fails, PAGE, "규칙")
    assert out == (d, ["노트에서 정답과 같은 묶음인 보기: stock"], None, False, "")


@pytest.mark.parametrize(
    "new",
    [
        "stock (그대로 둠: 지시사항에 따라 기존 보기에 포함됨)",  # 요청의 말 (화공양론, 11/06)
        "lift (그대로 둠: 지시사항에 따라 바꿈)",  # 새 낱말에 요청의 말 (/code-review #136)
        "lift (그대로둘 보기와 겹치지 않음)",
        "lift (오답보기)",
        "fasten: 노트에 있는 낱말이라 오답이 맞음",  # 남은 보기 뒤에 설명
        "stack (정답)",
        "Fasten: 노트에 있는 낱말이라 오답이 맞음",  # 대소문자만 다름 (Codex #136)
    ],
)
def test_repair_drops_a_new_option_with_notes(new: str) -> None:
    d = draft(SCENE, ["stack", "stock", "fasten", "order", "move"], "stack")
    llm = FakeLlm({"Repair": [{"options": [new]}]})
    assert qa.repair(llm, d, {"order"}, ["x"], PAGE) is None


@pytest.mark.parametrize(
    "new",
    ["fasten(ed)", "stack[2]", "상처를 그대로 둘 경우 감염 위험이 줄어든다"],
)
def test_repair_keeps_a_new_option_that_only_looks_like_a_note(new: str) -> None:
    # 붙여 쓴 괄호(Fe(OH)3 · map())와 이름표가 아닌 '그대로 둘'은 좋은 보기 (/code-review #136)
    d = draft(SCENE, ["stack", "stock", "fasten", "order", "move"], "stack")
    fixed = qa.repair(FakeLlm({"Repair": [{"options": [new]}]}), d, {"order"}, ["x"], PAGE)
    assert fixed is not None and fixed["options"][3] == new


def test_repair_keeps_a_new_option_that_only_contains_the_answer() -> None:
    # same_item은 안에 들어 있으면 같다고 봄: 정답 'be'와 비교하면 'became'까지 버리게 됨
    d = draft(SCENE, ["be", "is", "are", "was", "been"], "be")
    fixed = qa.repair(FakeLlm({"Repair": [{"options": ["became"]}]}), d, {"been"}, ["x"], PAGE)
    assert fixed is not None and fixed["options"][-1] == "became"


ROPE = "The rope was ____ to the post."
ROPE_OPTIONS = ["fastened", "secured", "extended", "displayed", "stacked"]


def test_screen_reports_an_unchecked_draft_when_calls_fail() -> None:
    d = draft(ROPE, ROPE_OPTIONS, "fastened")
    llm = FakeLlm({"Naturals": [LlmError("HTTP 503")] * 2})
    assert qa.screen(llm, d, PAGE, "빈칸") == ([], "down")


def test_screen_with_a_flagged_option_is_a_real_rejection_even_with_a_failed_call() -> None:
    d = draft(ROPE, ROPE_OPTIONS, "fastened")
    # 검사 모델 호출은 실패, 생성 모델이 secured를 잡음
    llm = FakeLlm({"Naturals": [LlmError("HTTP 503"), verdicts(True, True, False, False, False)]})
    assert qa.screen(llm, d, PAGE, "빈칸") == (
        ["빈칸에 넣어도 말이 되는 오답 보기: secured"],
        "",
    )


def test_checked_uses_the_recheck_after_a_first_check_with_a_failed_call() -> None:
    # 처음 검사에서 판정을 못 받은 호출이 있어도 secured만 고치고 → 재검사가 모두 통과
    d = draft(ROPE, ROPE_OPTIONS, "fastened")
    # 처음 검사: 검사 모델 호출 실패 · 생성 모델이 secured를 잡음. 재검사: 정답만 맞음(두 모델)
    first = [LlmError("HTTP 503"), verdicts(True, True, False, False, False)]
    clean = verdicts(True, False, False, False, False)
    llm = FakeLlm({"Naturals": [*first, clean, clean], "Repair": [{"options": ["lifted"]}]})
    fixed, why, _, repaired, unchecked = qa.checked(llm, d, no_conflict, PAGE, "빈칸")
    assert (why, repaired, unchecked) == ([], True, "")
    assert "lifted" in fixed["options"]


def test_checked_reports_unchecked_when_the_recheck_fails() -> None:
    d = draft(ROPE, ROPE_OPTIONS, "fastened")
    first = [verdicts(True, True, False, False, False)]
    llm = FakeLlm(
        {"Naturals": first + [LlmError("HTTP 503")] * 2, "Repair": [{"options": ["lifted"]}]}
    )
    _, why, _, repaired, unchecked = qa.checked(llm, d, no_conflict, PAGE, "빈칸")
    assert (why, repaired, unchecked) == ([], True, "down")


def test_screen_does_not_count_malformed_verdicts_as_unchecked() -> None:
    d = draft(ROPE, ROPE_OPTIONS, "fastened")
    # 모양이 틀린 판정: 묶은 판정 → 보기마다 → 정답 한 번 더도 모두 모양이 틀려 걸리지 않음
    llm = FakeLlm({"Naturals": [{"natural": "yes"}] * 2, "Natural": [{"natural": "yes"}] * 11})
    assert qa.screen(llm, d, PAGE, "빈칸") == ([], "")


# ---------- 부정설명 (#268) ----------

NEG_OPTIONS = [
    "포낭형은 8핵이다",
    "위족으로 운동한다",
    "적혈구를 먹는다",
    "4핵 포낭이 있다",
    "원충이다",
]


def test_a_negative_question_flags_wrong_options_that_are_false_too() -> None:
    # 정답이 틀린 설명이라 특징과 거꾸로: 틀린 설명인 오답 보기가 있으면 정답이 둘
    d = draft("이질 아메바", NEG_OPTIONS, "포낭형은 8핵이다")
    llm = FakeLlm({"Naturals": fits("포낭형은 8핵이다", "원충이다")})
    assert reasons(llm, d, PAGE, "부정설명") == [
        "그 용어에 대해 틀린 오답 보기(옳은 설명이어야 함): 원충이다"
    ]
    assert "틀린 내용이면 natural=true" in llm.calls[0].system


def test_a_negative_question_whose_answer_is_actually_true_is_rejected() -> None:
    d = draft("이질 아메바", NEG_OPTIONS, "포낭형은 8핵이다")
    llm = FakeLlm({"Naturals": fits()})  # 정답(틀린 설명)도 사실이라고 봄
    assert reasons(llm, d, PAGE, "부정설명") == [
        "정답으로 낸 틀린 설명이 일반 전공 지식으로는 맞음"
    ]


def test_a_repair_for_a_negative_question_asks_for_true_statements() -> None:
    assert qa.R_WRONG in qa.R_SYS  # 바꿔 끼울 문장이 그대로 있음
    assert qa.R_SYS_NEGATIVE != qa.R_SYS and "옳은 설명이어야 한다" in qa.R_SYS_NEGATIVE
    d = draft("이질 아메바", NEG_OPTIONS, "포낭형은 8핵이다")
    for qtype, system in (("부정설명", qa.R_SYS_NEGATIVE), ("특징", qa.R_SYS)):
        llm = FakeLlm({"Repair": [{"options": ["영양형이 있다"]}]})
        assert qa.repair(llm, d, {"원충이다"}, ["틀린 오답"], PAGE, qtype=qtype) is not None
        assert llm.calls[0].system == system


def test_screen_reports_refused_when_every_failed_call_was_rejected() -> None:
    # 서버가 판정 호출을 모두 거절(413): 다시 보내도 같아 부른 쪽이 따로 셈(#272)
    d = draft(ROPE, ROPE_OPTIONS, "fastened")
    llm = FakeLlm({"Naturals": [LlmRejectedError("HTTP 413")] * 2})
    assert qa.screen(llm, d, PAGE, "빈칸") == ([], "refused")


def test_screen_reports_down_when_a_rejection_is_mixed_with_an_outage() -> None:
    d = draft(ROPE, ROPE_OPTIONS, "fastened")
    llm = FakeLlm({"Naturals": [LlmRejectedError("HTTP 413"), LlmError("HTTP 503")]})
    assert qa.screen(llm, d, PAGE, "빈칸") == ([], "down")
