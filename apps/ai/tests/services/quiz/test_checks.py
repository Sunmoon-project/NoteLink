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
from app.services.quiz.text import tidy

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


@pytest.mark.parametrize(
    ("original", "concept"),
    [
        ("stack", "stack의 뜻"),  # 굴절형(stacked)도 다른 답: 새 문제가 이 낱말의 복습을 이어 감
        ("tacked", "tack의 뜻"),  # 한쪽이 다른 쪽 안에 있음(port ~ report)
        ("organizing", "divide, separate, stacked의 유의어"),  # 개념 이름의 다른 낱말도 안 됨
    ],
)
def test_keep_answer_asks_the_very_same_answer(original: str, concept: str) -> None:
    t = Target("right", answer=original, concept=concept, keep_answer=True)
    assert f"원래 낱말('{original}')을 다시 묻지 않음" in why(draft(), t=t)


def test_keep_answer_takes_the_same_answer() -> None:
    t = Target("right", answer="stacked", concept="stack의 뜻", keep_answer=True)
    assert not any("원래 낱말" in r for r in why(draft(), t=t))
    t = Target("right", answer="stacked", concept="stack의 뜻")  # 오답 복습: 맞힌 문제는 보지 않음
    assert not any("낱말(" in r for r in why(draft(answer="folded"), t=t))


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


def test_a_bare_blank_is_no_term() -> None:
    assert "물을 용어 없음" in why(draft(passage="____"), "특징")  # 미생 초안 9개(10/29)


def test_one_answer_fills_one_blank() -> None:
    d = draft(passage="The boxes are ____ and ____ in the corner.")
    assert "빈칸이 여러 개" in why(d)
    assert "빈칸이 여러 개" not in why(draft())


def test_code_parentheses_are_not_several_blanks() -> None:
    d = draft(passage="useState()와 useEffect()를 함께 쓴다", answer="stacked")
    assert "빈칸이 여러 개" not in why(tidy(d), "규칙")


def test_class_questions_are_not_judged_by_the_last_syllable() -> None:
    # 끝 글자로 분류 이름을 가리던 검사는 기생충에 맞춘 규칙이라 뺌(Codex 재리뷰 #94)
    for passage, answer, wrong in [
        ("표고버섯", "균류", ["동물", "식물", "원생생물", "원핵생물"]),
        ("포도당", "탄수화물", ["지방", "단백질", "비타민", "무기질"]),
    ]:
        d = draft(
            stem="다음 용어가 속하는 분류는?",
            passage=passage,
            answer=answer,
            options=[answer, *wrong],
        )
        assert not any("분류 이름" in w for w in why(d, "분류"))


def test_code_calls_and_indexes_are_not_blanks() -> None:
    # 코드의 ()·[]를 빈칸으로 바꾸면 정의 · 빈칸 문제가 '빈칸이 여러 개'로 버려짐(/code-review #94)
    for code in [
        "useState()로 만든 값을 useEffect()에서 읽고 arr[]와 f(x)[]도 쓴다",
        "useEffect(() => {}, [])는 마운트할 때 한 번 실행되고 useState([])는 빈 목록",
        "const list = []로 시작해 () => list.length를 넘긴다",
    ]:
        d = tidy(draft(passage=code, answer="stacked"))
        assert d["passage"] == code
        for ty in ("정의", "빈칸", "어휘"):
            assert "빈칸이 여러 개" not in why(d, ty)


def test_spaced_brackets_are_blanks_wherever_they_are() -> None:
    # 숫자 · 로마자 바로 뒤의 '( )'도 빈칸이고, 이어 쓴 빈칸 둘은 둘로 셈
    assert tidy(draft(passage="정상 혈당은 70~100( )이다, Na[ ] 이온"))["passage"] == (
        "정상 혈당은 70~100____이다, Na____ 이온"
    )
    # 붙어 있던 빈칸 둘은 tidy 뒤에도 둘(검사는 tidy 뒤에 돎)
    d = tidy(draft(passage="( )( )는 짝을 이룬다"))
    assert d["passage"] == "____ ____는 짝을 이룬다"
    assert "빈칸이 여러 개" in why(d, "정의")
    # 빈 ()·[]는 어디서든 코드로 봄(생성 안내는 빈칸을 ____로 쓰게 함)
    for code in ["함수는 ()를 붙여 부르고 return ()로 끝낸다", "x = []와 f ()"]:
        assert tidy(draft(passage=code))["passage"] == code


def test_a_rule_question_with_two_blanks_is_caught() -> None:
    # 규칙 유형을 빼고 보던 것은 코드의 ()가 빈칸으로 바뀌던 때문이라 이제는 모든 유형
    # (/code-review #94)
    assert "빈칸이 여러 개" in why(draft(passage="The boxes are ____ and ____"), "규칙")


def test_an_option_joining_other_options_fails() -> None:
    joined = draft(
        stem="다음 설명이 나타내는 용어는 무엇입니까?",
        passage="일정 압력 조건에서 온도의 변화에 따른 binary system을 나타내는 그래프입니다.",
        options=[
            "TXY 다이어그램",
            "에탄올 상태 변화",
            "압력과 끓는점 관계",
            "물과 에탄올 예시",
            "TXY 다이어그램, 에탄올 상태 변화, 압력과 끓는점 관계, 물과 에탄올 예시, 기체 분율",
        ],
        answer="TXY 다이어그램",
    )
    assert "다른 보기를 이어 붙인 보기" in why(joined, "정의")
    english = draft(
        options=["stacked", "extended", "fastened", "docked", "stacked, fastened, extended, docked"]
    )
    assert "다른 보기를 이어 붙인 보기" in why(english)
    numbers = draft(options=["1,000", "2,000", "3,000", "4,000", "1,000, 2,000, 3,000"])
    assert "다른 보기를 이어 붙인 보기" in why(numbers)  # 천 단위 쉼표는 나누지 않음


@pytest.mark.parametrize(
    "options",
    [
        ["분율", "몰 분율", "질량 분율", "부피 분율", "기상 조성"],
        ["deliver", "delivering", "delivered", "delivery", "deliverable"],
        ["H2O", "H2O2 (과산화수소)", "CO2 (이산화탄소)", "NH3", "CH4"],
        ["15", "1.5 (반감기)", "150", "10", "1,000"],
        ["ㄱ", "ㄱ, ㄴ", "ㄱ, ㄷ", "ㄴ, ㄷ", "ㄱ, ㄴ, ㄷ"],
        ["ㄱ", "ㄴ", "ㄷ", "ㄱ, ㄴ", "ㄱ, ㄴ, ㄷ"],
        ["ㄱ", "ㄴ", "ㄷ", "ㄱ, ㄴ", "ㄱ, ㄴ, ㄷ."],  # 문장부호가 붙어도 조합 (Codex #136)
        ["ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㄱ, ㄴ, ㄷ"],  # 조합 보기가 하나뿐 (Codex #136 3차)
        ["ㄱ", "ㄴ", "ㄷ", "ㄹ", "ㄱ, ㄴ, ㄷ."],
        ["I", "II", "III", "I, II", "I, II, III"],  # 여러 글자 조합 (/code-review #136)
        ["산소", "질소", "수소", "산소, 질소", "산소, 질소, 수소"],
        ["물", "물질의 상태 변화를 나타낸다", "기체", "액체", "고체"],
        ["map", "flatMap()", "filter", "reduce", "forEach"],
        ["의사의 지시사항을 확인한다", "혈압을 잰다", "체온을 잰다", "맥박을 잰다", "호흡을 센다"],
    ],
)
def test_options_that_only_contain_other_options_pass(options: list[str]) -> None:
    d = draft(options=options, answer=options[0])
    assert "다른 보기를 이어 붙인 보기" not in why(d, "특징")


# ---------- 부정설명 · 조합 (#268) ----------

KO_PAGE = "1. 이질 아메바\n- 영양형: 위족으로 운동하고 적혈구를 먹는다\n- 포낭형: 4핵, 인체 감염형"


def negative(**extra: object) -> Draft:
    d: Draft = {
        "stem": "다음 중 이질 아메바에 대한 설명으로 옳지 않은 것은?",
        "passage": "이질 아메바",
        "options": [
            "포낭형은 8핵이다",
            "위족으로 운동한다",
            "적혈구를 먹는다",
            "포낭형이 인체 감염형이다",
            "영양형과 포낭형이 있다",
        ],
        "answer": "포낭형은 8핵이다",
    }
    d.update(extra)  # type: ignore[typeddict-item]
    return d


def ko_why(d: Draft, ty: str, t: Target = NEW) -> list[str]:
    return code_check(d, t, KO_PAGE, ty, [])[0]


def test_a_negative_question_is_asked_only_as_its_own_type() -> None:
    assert ko_why(negative(), "부정설명") == []
    assert "부정 질문" in ko_why(negative(), "특징")
    positive = negative(stem="다음 중 이질 아메바에 대한 설명으로 옳은 것은?")
    assert "부정 질문이 아님" in ko_why(positive, "부정설명")


def test_a_negative_question_needs_the_term() -> None:
    assert "물을 용어 없음" in ko_why(negative(passage=""), "부정설명")


def test_an_overstated_wrong_statement_is_rejected() -> None:
    d = negative(answer="모든 원충은 포낭형이 8핵이다")
    d["options"][0] = d["answer"]
    assert any(w.startswith("과장으로 틀린 티") for w in ko_why(d, "부정설명"))
    # 옳은 보기에도 같은 말이 있으면 티가 나지 않음
    d["options"][1] = "모든 영양형은 위족으로 운동한다"
    assert not any(w.startswith("과장으로 틀린 티") for w in ko_why(d, "부정설명"))


def combo_draft(**extra: object) -> Draft:
    d: Draft = {
        "stem": "다음 중 이질 아메바에 대한 설명으로 옳은 것을 모두 고른 것은?",
        "passage": "ㄱ. 위족으로 운동한다.\nㄴ. 포낭형은 8핵이다.\nㄷ. 적혈구를 먹는다.",
        "options": ["ㄱ", "ㄷ", "ㄱ, ㄴ", "ㄱ, ㄷ", "ㄱ, ㄴ, ㄷ"],
        "answer": "ㄱ, ㄷ",
    }
    d.update(extra)  # type: ignore[typeddict-item]
    return d


def test_a_combination_answer_may_repeat_in_the_set_and_is_not_a_note_word() -> None:
    t = Target("new", used_answers=["ㄱ, ㄷ", "ㄱ"])
    assert code_check(combo_draft(), t, KO_PAGE, "조합", []) == ([], 3)


def test_a_combination_needs_its_options_and_three_lines() -> None:
    bad = combo_draft(options=["ㄱ", "ㄷ", "ㄱ, ㄴ", "ㄱ, ㄷ", "이질 아메바"])
    assert "조합 보기 모양이 아님" in ko_why(bad, "조합")
    one_line = combo_draft(passage="ㄱ. 위족으로 운동한다. ㄴ. 8핵이다. ㄷ. 적혈구를 먹는다.")
    assert "ㄱ · ㄴ · ㄷ 문장 없음" in ko_why(one_line, "조합")


def test_a_combination_answer_is_not_compared_as_a_reversed_question() -> None:
    assert seen_draft(combo_draft())["answer"] == ""
    assert seen_draft(draft())["answer"] == "stacked"
