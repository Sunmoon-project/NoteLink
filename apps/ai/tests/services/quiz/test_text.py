import pytest

from app.services.quiz.models import Draft, Notes, Question
from app.services.quiz.text import (
    clean_pages,
    locate,
    norm,
    place,
    same_item,
    same_word,
    short_answer,
    terms,
    tidy,
)


def question(answer: str, **extra: object) -> Question:
    q: Question = {
        "id": "q1",
        "order": 1,
        "prompt": "알맞은 것을 고르시오.",
        "choices": [answer, "x1", "x2", "x3", "x4"],
        "answer": answer,
    }
    q.update(extra)  # type: ignore[typeddict-item]
    return q


def draft(**extra: object) -> Draft:
    d: Draft = {
        "stem": "고르시오.",
        "passage": "",
        "options": ["a", "b", "c", "d", "e"],
        "answer": "a",
    }
    d.update(extra)  # type: ignore[typeddict-item]
    return d


# ---------- norm · terms ----------


def test_norm_ignores_case_spaces_and_punctuation() -> None:
    assert norm(" Be-being  V+ed! ") == "bebeingv+ed"
    assert norm(None) == ""


def test_terms_cut_words_to_stems() -> None:
    assert terms("arranging the 상품을 진열") == ["arran", "the", "상품", "진열"]


# ---------- clean_pages ----------


def test_clean_pages_drops_uncertain_and_empty_lines() -> None:
    pages = clean_pages(
        [
            {"pageNo": 1, "ocrText": "stack - 쌓다\n\n[?]승모란 판막\nfasten - 고정하다"},
            {"pageNo": 2, "ocrText": None},
        ]
    )
    assert pages == {1: "stack - 쌓다\nfasten - 고정하다"}


def test_clean_pages_leaves_out_pages_with_nothing_left() -> None:
    pages = clean_pages(
        [
            {"pageNo": 1, "ocrText": "[?]a\n[?]b\n  "},  # 모든 줄이 [?]
            {"pageNo": 2, "ocrText": ""},
            {"pageNo": 3, "ocrText": "stack - 쌓다"},
        ]
    )
    assert pages == {3: "stack - 쌓다"}


# ---------- locate ----------

NOTES: Notes = {
    "day1": {
        1: "PART 1 사진 묘사\nstack - 쌓다\nbe being p.p.",
        9: "요청 표현 + 동사원형\nCould you be ...",
    },
    "day2": {3: "install - 설치하다\nspan - 걸쳐 있다"},
}


def test_locate_prefers_page_holding_the_answer() -> None:
    assert locate(question("stacked"), NOTES) == ("day1", 1)  # 어간 stack으로 찾음
    assert locate(question("span"), NOTES, prefer="day1") == ("day2", 3)


def test_locate_uses_concept_and_explanation_for_short_answers() -> None:
    q = question("be", conceptTags=["요청 표현"], explanation="요청 뒤에는 동사원형")
    assert locate(q, NOTES) == ("day1", 9)


def test_locate_breaks_ties_with_preferred_note() -> None:
    notes: Notes = {"a": {1: "같은 글"}, "b": {1: "같은 글"}}
    assert locate(question("없는말"), notes, prefer="b") == ("b", 1)


def test_locate_handles_questions_without_choices() -> None:
    # 단답형 · 서술형은 choices가 null
    assert locate(question("install", choices=None), NOTES) == ("day2", 3)


def test_locate_without_notes_raises() -> None:
    with pytest.raises(ValueError):
        locate(question("stack"), {"a": {}})


# ---------- same_item · short_answer ----------


def test_same_item() -> None:
    assert same_item("organizing", "Organizing products")
    assert same_item("arrange", "arranging")
    assert not same_item("stack", "install")
    assert not same_item("", "stack")


@pytest.mark.parametrize(
    ("answer", "expected"),
    [
        ("fastened", True),
        ("be being p.p.", True),
        ("위상역전", True),
        ("산소 없이 증식한다", False),  # 한국어 문장
        ("She is clearing the table now", False),  # 다섯 낱말 이상
        ("", False),  # 빈 글은 답이 아님
    ],
)
def test_short_answer(answer: str, expected: bool) -> None:
    assert short_answer(answer) is expected


# ---------- tidy · place ----------


def test_tidy_unifies_blanks_and_strips_option_labels() -> None:
    d = tidy(draft(passage="The rope was ( ) to the post.", options=["A. fastened", "(b) put"]))
    assert d["passage"] == "The rope was ____ to the post."
    assert d["options"] == ["fastened", "put"]


def test_tidy_removes_korean_gloss_after_blank_sentence() -> None:
    d = tidy(
        draft(stem="한국어 뜻에 알맞은 표현은?", passage="He ___ the boxes. (그는 상자를 쌓았다)")
    )
    assert d["passage"] == "He ____ the boxes."
    assert d["stem"] == "다음 빈칸에 들어갈 가장 알맞은 표현을 고르시오."


def test_tidy_does_not_change_the_input() -> None:
    d = draft(passage="a ( ) b")
    tidy(d)
    assert d["passage"] == "a ( ) b"


def test_tidy_keeps_species_names_that_look_like_labels() -> None:
    opts = ["B. anthracis", "E. coli", "C. difficile", "S. aureus", "N. gonorrhoeae"]
    assert tidy(draft(options=opts))["options"] == opts
    labelled = ["A. a1", "B. b1", "(C) c1", "D: d1", "e) e1"]
    assert tidy(draft(options=labelled))["options"] == ["a1", "b1", "c1", "d1", "e1"]


def test_place_with_fewer_options_spreads_over_real_positions() -> None:
    opts = ["a", "정답", "c", "d"]
    assert [place(opts, 1, slot)[1] for slot in range(4)] == [0, 1, 2, 3]
    assert place(opts, 1, 4) == (["정답", "a", "c", "d"], 0)  # D에 몰리지 않음


def test_tidy_strips_labels_even_when_one_has_no_space() -> None:
    opts = ["A. stack", "B. stock", "C.stuck", "D. stick", "E. stark"]
    assert tidy(draft(options=opts))["options"] == ["stack", "stock", "stuck", "stick", "stark"]
    # 정답이 기호 붙은 보기를 그대로 옮겼으면 정답의 기호도 뗌
    assert tidy(draft(options=opts, answer="C.stuck"))["answer"] == "stuck"


def test_place_moves_answer_to_slot_position() -> None:
    opts = ["정답", "b", "c", "d", "e"]
    assert place(opts, 0, 2) == (["b", "c", "정답", "d", "e"], 2)
    assert place(opts, 0, 7) == (["b", "c", "정답", "d", "e"], 2)  # 5로 나눈 나머지
    assert place(["b", "정답", "c", "d", "e"], 1, 0) == (["정답", "b", "c", "d", "e"], 0)


@pytest.mark.parametrize(
    ("a", "b", "same"),
    [
        ("fasten", "fastened", True),  # 앞부분
        ("analysis", "analyses", True),  # 유사도 + 앞부분 절반 이상
        ("alpha", "Alpha", True),
        ("1.5 mL", "1.5mL", True),
        ("port", "report", False),  # 안에 있지만 앞부분이 아님
        ("1.5 mL", "15 mL", False),  # norm은 '.'을 지움
        ("IL-6", "IL6", True),  # 수가 있으면 나머지 글은 norm으로
        ("IL 6", "IL6", True),
        ("IL-6", "IL-8", False),
        ("1/2", "1-2", True),  # 알려진 한계: 수 목록이 같고 norm이 기호를 지움
        ("Type I hypersensitivity", "Type II hypersensitivity", False),  # 로마 숫자
        ("Stage I", "Stage IV", False),
        ("affect", "effect", False),  # 유사도만 높고 앞부분이 다름
        ("mitosis", "meiosis", False),
    ],
)
def test_same_word_is_narrower_than_same_item(a: str, b: str, same: bool) -> None:
    assert same_word(a, b) is same and same_word(b, a) is same
