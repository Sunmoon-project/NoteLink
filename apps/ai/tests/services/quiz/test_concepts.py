import pytest

from app.clients.llm import JsonObject, LlmError, repair
from app.services.quiz import concepts as c
from app.services.quiz.models import Question
from tests.fakes import FakeLlm

SUBJECT = c.subject_words("뇌파 (1학기 기말)")


def question(qid: str, answer: str, tag: str | None = None) -> Question:
    q: Question = {
        "id": qid,
        "order": 1,
        "prompt": "알맞은 것을 고르시오.",
        "choices": [answer, "x1", "x2", "x3", "x4"],
        "answer": answer,
    }
    if tag:
        q["conceptTags"] = [tag]
    return q


# ---------- 이름 정리 · 검사 (코드) ----------


def test_subject_words() -> None:
    assert SUBJECT == {"뇌파"}
    assert c.subject_words("토익 1일차 LC+RC") == {"토익", "1일차", "lc", "rc"}
    assert c.subject_name("미생 (1학기 기말)") == "미생"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("광자극 반응(Photic driving response", "광자극 반응"),  # 닫히지 않은 괄호
        ("AFB 염색법 (Kinyoun, Auramine, ZN", "AFB 염색법"),  # 예시 목록 괄호
        ("D-test (유도 내성)", "D-test (유도 내성)"),  # 닫힌 괄호는 둠
        ("  enough의   수식 위치 ", "enough의 수식 위치"),
    ],
)
def test_tidy(name: str, expected: str) -> None:
    assert c.tidy(name) == expected


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Corynebacterium diphtheriae의 특", "잘림"),
        ("특성 및질", "잘림"),
        ("표현(be동사)과", "잘림"),
        ("A" * 41, "너무 김"),
        ("p.12 정리", "쪽·문제 번호"),
        ("Q.3 오답 분석", "쪽·문제 번호"),
        ("Part 2 빈출 어휘", "시험 영역·풀이 전략"),
        ("문맥상 적절한 어휘 선택", "시험 영역·풀이 전략"),
        ("뇌파", "노트 제목 그대로"),
        ("형용사 어휘", "넓음(구체 용어 없음)"),
        ("유의어", "넓음(구체 용어 없음)"),
        ("be being V-ed 상태 표현", None),
        ("assemble의 의미", None),
        ("상태 vs 동작 동사 구분", None),  # 일부러 견주는 이름
        ("위상역전", None),
        ("12쪽 정리", "쪽·문제 번호"),
        ("12p 요약", "쪽·문제 번호"),
        # 쪽 번호 · 시험 영역 규칙이 잘못 걸던 정상 이름
        ("Mitosis 4 phases", None),
        ("CoQ10 결핍", None),
        ("간문맥 고혈압", None),
        ("문맥에 맞는 어휘", "시험 영역·풀이 전략"),
        ("문맥 고혈압", None),  # 의학 용어
        ("문맥압 항진증", None),
        ("q3 효소", None),
        ("pp.12 어휘", "쪽·문제 번호"),
        ("12page 표현", "쪽·문제 번호"),
    ],
)
def test_issue(name: str, expected: str | None) -> None:
    assert c.issue(name, SUBJECT) == expected


def test_same_name() -> None:
    assert c.same_name("advice 불가산 명사", "advice의 불가산 명사 성질")
    assert c.same_name("Clindamycin D-test", "Clindamycin D-test를 통한 유도 내성 확인")
    assert not c.same_name("divide, separate, arrange의 의미", "wipe, mop, sweep, clear의 의미")


def test_dedupe_keeps_first_of_same_names() -> None:
    names = ["advice 불가산 명사", "Clindamycin D-test", "advice의 불가산 명사 성질"]
    assert c.dedupe(names) == ["advice 불가산 명사", "Clindamycin D-test"]


def test_names_numbered_differently_are_different() -> None:
    names = ["Type I hypersensitivity", "Type II hypersensitivity", "Stage I 수면", "Stage IV 수면"]
    assert c.dedupe(names) == names
    assert not c.same_name("Phase 1 대사", "Phase 2 대사")
    # 번호가 같거나 한쪽에만 있으면 전처럼 비교
    assert c.same_name("Type I hypersensitivity", "Type I 과민반응 hypersensitivity")
    assert c.same_name("be being V-ed 상태 표현", "be being V-ed 상태 표현의 쓰임")


def test_retag_keeps_differently_numbered_new_name() -> None:
    llm = FakeLlm(
        {
            "Concept": [{"concept": c.NONE}, {"concept": "Type II hypersensitivity"}],
            "Names": [verdicts()],
        }
    )
    q = question("q1", "IgE 매개")
    assert c.retag(llm, q, ["Type I hypersensitivity"], "면역학") == (
        "Type II hypersensitivity",
        "Type II hypersensitivity",
    )


def test_for_text_finds_names_of_a_page_or_falls_back_to_all() -> None:
    names = ["be being V-ed 상태 표현", "enough의 수식 위치", "Clindamycin D-test"]
    page = "be being p.p. 상태 표현\nenough는 형용사 뒤에서 수식"
    assert c.for_text(names, page) == ["be being V-ed 상태 표현", "enough의 수식 위치"]
    assert c.for_text(names, "관계없는 글") == names


def test_score_ignores_function_words() -> None:
    # 'the'는 빼고 'appeal'만 셈
    assert c.score("appeal to the 고객", "appeal to customers") == pytest.approx(0.5)
    assert c.score("형용사 어휘", "아무 글") == 0.0  # 구체 낱말이 없음


# ---------- 쪽마다 이름 뽑기 (LLM) ----------


def names_answer(*names: str) -> dict[str, list[str]]:
    return {"concepts": list(names)}


def verdicts(*pairs: tuple[str, str]) -> dict[str, list[dict[str, str]]]:
    return {"items": [{"name": n, "verdict": v} for n, v in pairs]}


def test_for_page_screens_and_asks_again_only_for_rejected() -> None:
    llm = FakeLlm(
        {
            "Concepts": [
                names_answer("be being V-ed 상태 표현", "형용사 어휘", "위성역전"),
                names_answer("be being V-ed 상태 표현의 쓰임", "enough의 수식 위치"),
            ],
            "Names": [verdicts(("위성역전", "오타")), verdicts()],
        }
    )
    good, bad = c.for_page(llm, "노트 글", "토익 1일차 LC+RC")
    assert good == ["be being V-ed 상태 표현", "enough의 수식 위치"]
    assert bad == [("형용사 어휘", "넓음(구체 용어 없음)"), ("위성역전", "오타(검수)")]
    again = llm.named("Concepts")[1].user
    assert "이미 정한 이름: be being V-ed 상태 표현" in again
    assert '"형용사 어휘"(넓음(구체 용어 없음))' in again
    assert "새 이름만 2개 이하" in again


def test_for_page_without_rejects_makes_one_extraction() -> None:
    llm = FakeLlm({"Concepts": [names_answer("enough의 수식 위치")], "Names": [verdicts()]})
    assert c.for_page(llm, "노트 글", "토익") == (["enough의 수식 위치"], [])
    assert len(llm.named("Concepts")) == 1


def test_for_page_first_call_failure_is_raised() -> None:
    llm = FakeLlm({"Concepts": [LlmError("HTTP 503")]})
    with pytest.raises(LlmError):
        c.for_page(llm, "노트 글", "토익")


@pytest.mark.parametrize(
    "answer",
    [
        repair('{"concepts":['),  # 잘린 답을 닫으면 빈 목록
        {"concepts": []},
        {"concepts": "enough의 수식 위치"},  # 글자 하나씩 읽히던 문자열
        {"concepts": ["", "  ", 3]},
        {},
    ],
)
def test_for_page_first_answer_without_names_is_raised(answer: JsonObject) -> None:
    llm = FakeLlm({"Concepts": [answer]})
    with pytest.raises(LlmError):
        c.for_page(llm, "노트 글", "토익")
    assert llm.named("Names") == []


def test_for_page_second_answer_without_names_keeps_first_names() -> None:
    llm = FakeLlm(
        {
            "Concepts": [
                names_answer("enough의 수식 위치", "형용사 어휘"),
                {"concepts": "새 이름"},
            ],
            "Names": [verdicts()],
        }
    )
    good, bad = c.for_page(llm, "노트 글", "토익")
    assert good == ["enough의 수식 위치"]
    assert bad == [("형용사 어휘", "넓음(구체 용어 없음)")]


def test_failed_check_passes_names_unflagged() -> None:
    llm = FakeLlm({"Names": [LlmError("HTTP 503")]})
    assert c.llm_check(llm, ["위상역전"], "뇌파") == {}


# ---------- 저장된 문제에 이름 붙이기 ----------


def test_retag_picks_listed_name() -> None:
    llm = FakeLlm({"Concept": [{"concept": "stack의 의미"}]})
    q = question("q1", "stack")
    assert c.retag(llm, q, ["stack의 의미", "appeal to의 용법"], "토익") == ("stack의 의미", None)
    # 문제와 낱말이 겹치는 이름이 앞에 옴
    assert "개념 목록: stack의 의미, appeal to의 용법" in llm.calls[0].user


def test_malformed_check_items_are_skipped() -> None:
    # 쓰다 만 JSON을 닫은 답: 글자 항목 · 이름 없는 항목은 넘기고 읽을 수 있는 것만 씀
    items = ["a", {"verdict": "오타"}, {"name": "위성역전", "verdict": "오타"}]
    llm = FakeLlm({"Names": [{"items": items}]})
    assert c.llm_check(llm, ["위성역전"], "뇌파") == {"위성역전": "오타"}
    assert c.llm_check(FakeLlm({"Names": [{"items": "문자열"}]}), ["x"], "뇌파") == {}


def test_pick_lists_names_matching_the_answer_first() -> None:
    llm = FakeLlm({"Concept": [{"concept": "stack의 의미"}]})
    q = question("q1", "stack")
    q["prompt"] = "install 문제와 같은 쪽의 문제"  # 문제 글은 install과 겹침
    c.pick(llm, q, ["install의 의미", "stack의 의미"], set())
    assert "개념 목록: stack의 의미, install의 의미" in llm.calls[0].user


def test_pick_ranks_by_whole_question_for_sentence_answers() -> None:
    llm = FakeLlm({"Concept": [{"concept": "무산소성 세균의 특징"}]})
    q = question("q1", "산소 없이 증식한다")
    q["passage"] = "무산소성 세균"
    c.pick(llm, q, ["산소 요구성 분류", "증식 곡선", "무산소성 세균의 특징"], set())
    assert "개념 목록: 무산소성 세균의 특징," in llm.calls[0].user


def test_retag_does_not_make_names_when_check_fails() -> None:
    llm = FakeLlm({"Concept": [LlmError("HTTP 503")]})
    assert c.retag(llm, question("q1", "stack"), ["stack의 의미"], "토익") == (None, None)
    assert len(llm.calls) == 1  # 새 이름 짓기를 부르지 않음


def test_retag_makes_new_name_when_none_fits() -> None:
    llm = FakeLlm(
        {"Concept": [{"concept": c.NONE}, {"concept": "install의 의미"}], "Names": [verdicts()]}
    )
    assert c.retag(llm, question("q1", "install"), ["stack의 의미"], "토익") == (
        "install의 의미",
        "install의 의미",
    )


def test_retag_reuses_listed_name_equal_to_new_one() -> None:
    llm = FakeLlm(
        {
            "Concept": [{"concept": c.NONE}, {"concept": "advice의 불가산 명사 성질"}],
            "Names": [verdicts()],
        }
    )
    assert c.retag(llm, question("q1", "advice"), ["advice 불가산 명사"], "토익") == (
        "advice 불가산 명사",
        None,
    )


@pytest.mark.parametrize("first, second", [("Type I", "Type II"), ("type i", "type ii")])
def test_unify_keeps_answers_numbered_differently_apart(first: str, second: str) -> None:
    sets = [
        [question("a1", f"{first} hypersensitivity", "Type I 과민반응")],
        [question("b1", f"{second} hypersensitivity", "Type II 과민반응")],
    ]
    concepts = ["Type I 과민반응", "Type II 과민반응"]
    changes, names = c.unify(sets, concepts, created=["Type II 과민반응"])
    assert changes == {}
    assert names == concepts


def test_unify_gives_same_short_answer_the_first_sets_name() -> None:
    sets = [
        [question("a1", "budget", "budget의 의미"), question("a2", "산소 없이 증식한다", "무산소")],
        [question("b1", "budget", "예산 어휘"), question("b2", "budget", "budget 쓰임")],
    ]
    concepts = ["budget의 의미", "예산 어휘", "budget 쓰임", "무산소", "새 이름"]
    changes, names = c.unify(sets, concepts, created=["예산 어휘", "새 이름"])
    assert changes == {"b1": "budget의 의미", "b2": "budget의 의미"}
    # 문제 하나를 위해 만들었다가 안 쓰인 이름만 빠짐 ('budget 쓰임'은 원래 목록이라 남음)
    assert names == ["budget의 의미", "budget 쓰임", "무산소"]
