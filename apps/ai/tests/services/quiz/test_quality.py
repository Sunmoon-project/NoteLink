import pytest

from app.clients.llm import JsonObject, LlmError
from app.core.config import settings
from app.services.quiz import quality as qa
from app.services.quiz.models import Draft
from tests.fakes import FakeLlm

PAGE = """쌓다 = stack
# stock
installation - 설치
instalment - 할부
be being V+ed 사람 없는 사진
organize = arrange"""


def draft(passage: str, options: list[str], answer: str) -> Draft:
    return {
        "stem": "알맞은 것을 고르시오.",
        "passage": passage,
        "options": options,
        "answer": answer,
    }


def natural(*values: bool | LlmError) -> list[JsonObject | LlmError]:
    return [v if isinstance(v, LlmError) else {"natural": v} for v in values]


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
    llm = FakeLlm({"Natural": natural(True, False, False, False)})
    assert qa.two_answers(llm, d, "begin - 시작하다\nstart - 시작하다", "빈칸") == [
        "빈칸에 넣어도 말이 되는 오답 보기: start"
    ]


def test_group_conflict_flags_wrong_option_in_answers_group() -> None:
    opts = ["stacked", "stock", "folded", "painted", "cleared"]
    assert qa.group_conflict("stacked", opts, PAGE) == ["stock"]
    assert qa.group_conflict("산소 없이 증식한다", opts, PAGE) == []  # 문장 답은 보지 않음


# ---------- 정답 둘 검사 (LLM) ----------


def test_blank_option_that_also_fits_is_rejected_and_collected() -> None:
    d = draft("The rope was ____ to the post.", ["fastened", "secured", "a", "b", "c"], "fastened")
    llm = FakeLlm({"Natural": natural(True, False, False, False)})
    hits: list[str] = []
    assert qa.two_answers(llm, d, PAGE, "빈칸", hits) == [
        "빈칸에 넣어도 말이 되는 오답 보기: secured"
    ]
    assert hits == ["secured"]
    assert {c.model for c in llm.calls} == {settings.quiz_check_model}


def test_second_judge_runs_when_check_model_finds_nothing() -> None:
    d = draft("The rope was ____ to the post.", ["fastened", "extended", "a", "b", "c"], "fastened")
    # 검사 모델 4번 모두 false → 생성 모델이 extended를 잡음
    llm = FakeLlm({"Natural": natural(*[False] * 4, True, False, False, False)})
    assert qa.two_answers(llm, d, PAGE, "빈칸") == ["빈칸에 넣어도 말이 되는 오답 보기: extended"]
    assert llm.calls[4].model == settings.quiz_gen_model


def test_answer_itself_must_fit_the_blank() -> None:
    d = draft("The team will ____ the road.", ["resurfacing", "a", "b", "c", "d"], "resurfacing")
    llm = FakeLlm({"Natural": natural(*[False] * 8, False)})  # 오답 8번 + 정답 1번
    assert qa.two_answers(llm, d, PAGE, "빈칸") == ["정답을 빈칸에 넣으면 문장이 틀림"]


def test_note_contrast_pair_is_not_checked() -> None:
    d = draft("We paid the ____.", ["installation", "instalment", "a", "b", "c"], "installation")
    llm = FakeLlm({"Natural": natural(*[False] * 6, True)})
    assert qa.two_answers(llm, d, PAGE, "빈칸") == []
    assert all("instalment" not in c.user for c in llm.calls)


def test_note_group_conflict_is_reported_with_llm_result() -> None:
    d = draft("The boxes are ____.", ["stacked", "stock", "a", "b", "c"], "stacked")
    llm = FakeLlm({"Natural": natural(*[False] * 8)})
    assert qa.two_answers(llm, d, PAGE, "빈칸") == ["노트에서 정답과 같은 묶음인 보기: stock"]


def test_answer_option_with_different_case_is_not_a_wrong_option() -> None:
    opts = ["Stacked", "stock", "folded", "painted", "cleared"]
    assert qa.group_conflict("stacked", opts, PAGE) == ["stock"]
    d = draft("The rope was ____ to the post.", ["Fastened", "tied", "a", "b", "c"], "fastened")
    # 오답 4개 × 두 모델 = 8번, 마지막 1번은 정답이 빈칸에 맞는지 확인
    llm = FakeLlm({"Natural": natural(*[False] * 8, True)})
    assert qa.two_answers(llm, d, PAGE, "빈칸") == []
    assert all("Fastened" not in c.user for c in llm.calls[:8])


def test_reason_matches_the_check_type() -> None:
    # 빈칸이 없는 정의 문제에 '빈칸에 넣어도…'라고 쓰면 재시도 지시가 엉뚱해짐
    d = draft(
        "산소 없이 증식하는 세균", ["무산소성 세균", "통성 세균", "a", "b", "c"], "무산소성 세균"
    )
    llm = FakeLlm({"Natural": natural(True, False, False, False)})
    assert qa.two_answers(llm, d, PAGE, "정의") == ["설명에 함께 해당하는 오답 보기: 통성 세균"]
    d = draft("쌓다", ["stack", "pile", "a", "b", "c"], "stack")
    llm = FakeLlm({"Natural": natural(True, False, False, False)})
    assert qa.two_answers(llm, d, "", "어휘") == ["같은 뜻으로 쓰이는 오답 보기: pile"]
    d = draft("황색포도알균", ["그람양성균", "구균", "a", "b", "c"], "그람양성균")
    llm = FakeLlm({"Natural": natural(True, False, False, False)})
    assert qa.two_answers(llm, d, "", "분류") == ["용어가 함께 속하는 오답 분류: 구균"]


def test_term_subject_checks_the_right_answer_too() -> None:
    d = draft(
        "항산성균",
        ["보통 염색으로 쉽게 염색된다", "a", "b", "c", "d"],
        "보통 염색으로 쉽게 염색된다",
    )
    llm = FakeLlm({"Natural": natural(False, False, False, False, False)})
    assert qa.two_answers(llm, d, PAGE, "특징") == [
        "정답이 일반 전공 지식과 맞지 않음(노트 OCR 오류 가능)"
    ]
    assert llm.calls[0].user == "용어: 항산성균\n문장: a"


def test_scene_questions_skip_the_llm_check() -> None:
    d = draft(
        "고객이 병을 닫고 있다.", ["A customer is closing a bottle.", "a", "b", "c", "d"], "a"
    )
    llm = FakeLlm()
    assert qa.two_answers(llm, d, PAGE, "묘사") == []
    assert llm.calls == []


def test_failed_llm_calls_do_not_flag_options() -> None:
    d = draft("The rope was ____ to the post.", ["fastened", "secured", "a", "b", "c"], "fastened")
    llm = FakeLlm({"Natural": natural(*[LlmError("HTTP 503")] * 9)})
    assert qa.two_answers(llm, d, PAGE, "빈칸") == []


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
    assert qa.checked(llm, d, no_conflict, PAGE, "규칙") == (d, [], None, False)
    assert llm.calls == []


def test_checked_repairs_and_rechecks() -> None:
    d = draft(SCENE, ["fasten", "stock", "stack", "order", "move"], "stack")
    hits: list[str] = []
    llm = FakeLlm({"Repair": [{"options": ["lift"]}]})
    fixed, why, k, repaired = qa.checked(llm, d, no_conflict, PAGE, "규칙", hits=hits)
    assert (fixed["options"], why, k, repaired) == (
        ["fasten", "lift", "stack", "order", "move"],
        [],
        2,
        True,
    )
    assert hits == ["stock"]  # 다음 시도에서 피할 낱말


def test_checked_keeps_the_first_reasons_when_the_repair_fails_again() -> None:
    d = draft(SCENE, ["stack", "stock", "fasten", "order", "move"], "stack")
    llm = FakeLlm({"Repair": [{"options": ["lift"]}]})

    def code_fails(x: Draft) -> tuple[list[str], int | None]:
        return ["보기 5개가 아니거나 겹침"], None

    out = qa.checked(llm, d, code_fails, PAGE, "규칙")
    assert out == (d, ["노트에서 정답과 같은 묶음인 보기: stock"], None, False)


def test_repair_keeps_a_new_option_that_only_contains_the_answer() -> None:
    # same_item은 안에 들어 있으면 같다고 봄: 정답 'be'와 비교하면 'became'까지 버리게 됨
    d = draft(SCENE, ["be", "is", "are", "was", "been"], "be")
    fixed = qa.repair(FakeLlm({"Repair": [{"options": ["became"]}]}), d, {"been"}, ["x"], PAGE)
    assert fixed is not None and fixed["options"][-1] == "became"
