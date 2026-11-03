import pytest

from app.services.quiz.checks import (
    Seen,
    Target,
    code_check,
    form_giveaway,
    number_values,
    reversed_of,
    same_value,
    seen_draft,
    seen_question,
    too_close,
)
from app.services.quiz.models import Draft

PAGE = "쌓다 = stack\nfasten - 고정하다\nThe rope was fastened to the post.\norganize = arrange"
NEW = Target("new")


def draft(**extra: object) -> Draft:
    d: Draft = {
        "stem": "다음 빈칸에 들어갈 알맞은 말을 고르시오.",
        "passage": "The boxes are ____ in the corner.",
        "options": ["stacked", "folded", "painted", "cleared", "printed"],
        "answer": "stacked",
    }
    d.update(extra)  # type: ignore[typeddict-item]
    return d


def why(d: Draft, ty: str = "빈칸", t: Target = NEW, seen: list[Seen] | None = None) -> list[str]:
    return code_check(d, t, PAGE, ty, seen or [])[0]


# ---------- 통과 · 정답 위치 ----------


def test_good_draft_passes_and_returns_answer_position() -> None:
    assert code_check(draft(), NEW, PAGE, "빈칸", []) == ([], 0)
    d = draft(options=["folded", "painted", "stacked", "cleared", "printed"])
    assert code_check(d, NEW, PAGE, "빈칸", [])[1] == 2


# ---------- 보기 ----------


def test_options_must_be_five_and_distinct() -> None:
    assert "보기 5개가 아니거나 겹침" in why(draft(options=["stacked", "a", "b", "c"]))
    assert "보기 5개가 아니거나 겹침" in why(
        draft(options=["stacked", "Folded", "folded", "c", "d"])
    )


def test_answer_must_be_exactly_one_option() -> None:
    reasons, k = code_check(draft(answer="stack up"), NEW, PAGE, "빈칸", [])
    assert "정답 글이 보기와 안 맞음" in reasons
    assert k is None


@pytest.mark.parametrize(
    ("text", "value"),
    [("350,000 CFU/mL", 350000.0), ("3.5×10^5", 350000.0), ("3.5x10^5", 350000.0)]
    + [("1.5e3", 1500.0), ("10", 10.0), ("없음", None)],
)
def test_number_values_reads_every_form(text: str, value: float | None) -> None:
    vals = number_values(text)[0]
    assert (float(vals[0]) if vals else None) == value


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("3×10^-7 M", "4×10^-7 M"),  # 반올림하면 둘 다 0이던 작은 수
        ("37℃에서 24시간", "37℃에서 48시간"),  # 첫 수만 같음
        ("10x100", "10x40"),  # 배율
        ("Two men are carrying 2 boxes.", "Two men are opening 2 boxes."),  # 문장 속 같은 수
        ("-5℃", "5℃"),  # 부호
        ("1/2", "1-2"),  # 기호
        ("2×10^3 ~ 5 mL", "5 ~ 2×10^3 mL"),  # 순서
        (".5 mg", "5 mg"),
        ("1e-999", "1e999"),  # 넘침 없이 비교
    ],
)
def test_different_options_are_not_same_value(a: str, b: str) -> None:
    assert not same_value(a, b)


@pytest.mark.parametrize(
    ("a", "b"),
    [
        ("3.5 × 10^5 CFU/mL", "350,000 CFU/mL"),  # 띄어 쓴 지수
        ("350,000 CFU/mL.", "3.5×10^5 CFU/mL"),  # 끝 마침표
        ("약3.5×10^5 CFU", "약350,000 CFU"),  # 한국어에 붙은 수
        ("0.5 mg", ".5 mg"),
        ("1.5E3 cells", "1,500 cells"),  # 대문자 E 지수
        ("1.5E+3 cells", "1,500 cells"),  # + 부호 지수
        ("1.5×10^+3 cells", "1,500 cells"),
    ],
)
def test_same_value_in_different_forms(a: str, b: str) -> None:
    assert same_value(a, b)


@pytest.mark.parametrize("other", ["3.5×10^5 CFU/mL", "3.5E+5 CFU/mL", "3.5×10^+5 CFU/mL"])
def test_same_number_in_two_forms_fails(other: str) -> None:
    opts = ["350,000 CFU/mL", other, "1,000 CFU/mL", "10 CFU/mL", "100 CFU/mL"]
    d = draft(stem="기준 균 수는?", passage="", options=opts, answer="1,000 CFU/mL")
    assert "값이 같은 숫자 보기" in why(d, "규칙")


# ---------- 빈칸 · 형태 ----------


def test_form_giveaway() -> None:
    # 정답만 -ing: 문법만 보고 풀림 (오늘의 복습 10/23)
    assert form_giveaway(
        draft(options=["organizing", "clothing", "adjust", "counter", "shelf"], answer="organizing")
    )
    assert not form_giveaway(
        draft(options=["organizing", "wiping", "mowing", "adjust", "shelf"], answer="organizing")
    )
    assert not form_giveaway(draft(options=["String of pearl", "a", "b", "c", "d"], answer="a"))


def test_blank_type_needs_blank_and_no_korean_gloss() -> None:
    assert "빈칸 문장 없음" in why(draft(passage="The boxes are in the corner."))
    assert "빈칸 문장에 한국어 뜻 노출" in why(draft(passage="상자를 ____ 쌓았다"))
    # 정의 유형은 한국어 빈칸 문장이 정상
    assert "빈칸 문장에 한국어 뜻 노출" not in why(
        draft(passage="____는 산소 없이 증식한다"), "정의"
    )


def test_answer_in_passage_is_a_giveaway() -> None:
    assert "제시문에 정답 노출" in why(draft(passage="stacked boxes ____ here"))
    # 한국어 어미를 떼고 비교 (살아간다 / 살아가는)
    d = draft(
        stem="다음 용어의 특징은?",
        passage="산소가 없는 환경에서 살아가는 세균",
        options=["산소가 없는 환경에서 살아간다", "빛", "열", "물", "흙"],
        answer="산소가 없는 환경에서 살아간다",
    )
    assert "제시문에 정답 노출" in why(d, "특징")


# ---------- 문제 글 · 유형별 ----------


def test_stem_must_be_korean_and_not_negative() -> None:
    assert "부정 질문" in why(draft(stem="다음 중 알맞지 않은 것을 고르시오."))
    assert "문제 글이 한국어가 아님" in why(draft(stem="Choose the best word."))


def test_scene_type_needs_korean_scene() -> None:
    d = draft(passage="The man is walking a dog", options=["A", "B", "C", "D", "E"], answer="A")
    reasons = why(d, "묘사")
    assert "장면 설명 없음" in reasons
    assert "장면 설명에 영어 문장이 섞임" in reasons


def test_term_types() -> None:
    assert "설명 문장 없음" in why(draft(passage="짧음"), "정의")
    assert "물을 용어 없음" in why(draft(passage=""), "특징")
    d = draft(passage="무산소성 세균은 산소 없이 증식하는 세균이다", answer="무산소성 세균")
    d["options"] = ["무산소성 세균", "호기성 세균", "통성 세균", "미호기성 세균", "내생포자"]
    assert "설명에 정답 용어 노출" in why(d, "정의")


def test_answer_must_be_in_the_note() -> None:
    d = draft(options=["wrapped", "folded", "painted", "cleared", "printed"], answer="wrapped")
    assert "정답이 노트에 없음" in why(d)
    assert "정답이 노트에 없음" not in why(draft())


# ---------- 다시 보기 대상 ----------


def test_wrong_target_must_ask_the_same_word_again() -> None:
    t = Target("wrong", answer="fastened", concept="fasten의 의미")
    assert "틀린 낱말('fastened')을 다시 묻지 않음" in why(draft(), t=t)
    # 개념 이름에 적힌 낱말은 같은 개념으로 봄 (organizing 대신 arranging)
    t = Target("wrong", answer="organizing", concept="divide, separate, stacked의 유의어")
    assert not any("틀린 낱말" in r for r in why(draft(), t=t))


def test_wrong_target_without_answer_does_not_reject_every_draft() -> None:
    assert not any("틀린 낱말" in r for r in why(draft(), t=Target("wrong", concept="x")))


def test_answer_with_different_case_is_not_counted_as_wrong_option() -> None:
    opts = ["Organizing", "clothing", "adjust", "counter", "shelf"]
    assert form_giveaway(draft(options=opts, answer="organizing"))


def test_answer_used_in_the_set_fails() -> None:
    assert "세트 안에서 정답이 겹침" in why(draft(), t=Target("new", used_answers=["stack"]))


# ---------- 겹침 ----------


def test_too_close_to_existing_question() -> None:
    seen = [seen_draft(draft())]
    assert too_close(draft(stem="다음 빈칸에 들어갈 알맞은 말을 고르시오!"), seen)
    assert not too_close(
        draft(stem="완전히 다른 문제 글", passage="Different sentence ____."), seen
    )


def test_same_stem_with_different_short_passage_is_not_too_close() -> None:
    # 로컬 DB에서 같은 문제로 보던 '쌓다' / '계약을 성공하다' (10/27 측정)
    stem = "다음 한국어 뜻에 해당하는 영어 표현으로 가장 알맞은 것을 고르시오."
    seen = [seen_draft(draft(stem=stem, passage="쌓다"))]
    assert not too_close(draft(stem=stem, passage="계약을 성공하다"), seen)
    assert too_close(draft(stem="다른 문제 글", passage="쌓다"), seen)


def test_reversed_question_in_this_run_fails() -> None:
    made = draft(passage="무산소성 세균", answer="산소 없이 증식한다")
    reverse = draft(passage="산소 없이 증식하는 세균", answer="무산소성 세균")
    assert reversed_of(reverse, [seen_draft(made)])
    # 저장된 문제는 보지 않음
    stored = seen_question(
        {"id": "q", "order": 1, "prompt": "", "choices": None, "answer": "산소 없이 증식한다"}
    )
    stored["passage"] = "무산소성세균"
    assert not reversed_of(reverse, [stored])


def test_decimal_options_are_distinct() -> None:
    opts = ["1.5 mL", "15 mL", "0.15 mL", "150 mL", "3 mL"]
    d = draft(stem="알맞은 양은?", passage="", options=opts, answer="1.5 mL")
    assert code_check(d, NEW, "1.5 mL", "규칙", [])[1] == 0
    reasons = why(d, "규칙")
    assert "보기 5개가 아니거나 겹침" not in reasons
    assert "정답 글이 보기와 안 맞음" not in reasons


def test_unreadable_exponent_is_kept_as_text() -> None:
    long_exp = "1e" + "9" * 30
    assert number_values(long_exp)[0] == []
    assert not same_value(long_exp, "1e9")


def test_option_key_keeps_sign_and_decimal_but_ignores_spacing() -> None:
    opts = ["-20℃", "20℃", "4℃", "37℃", "-70℃"]
    d = draft(stem="보관 온도는?", passage="", options=opts, answer="-20℃")
    assert code_check(d, NEW, "-20℃", "규칙", [])[1] == 0
    assert "보기 5개가 아니거나 겹침" not in why(d, "규칙")
    opts = ["No.5", "No.6", "No.7", "No.8", "No.9"]
    assert (
        code_check(
            draft(stem="번호는?", passage="", options=opts, answer="No. 5"), NEW, "No.5", "규칙", []
        )[1]
        == 0
    )
