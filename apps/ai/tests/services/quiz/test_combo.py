import re

import pytest

from app.clients.llm import JsonObject, LlmError, LlmRejectedError
from app.core.config import settings
from app.services.quiz import combo
from app.services.quiz.text import COMBOS, is_combo
from tests.fakes import FakeLlm

PAGE = """1. 이질 아메바
- 영양형: 위족으로 운동하고 적혈구를 먹는다
- 포낭형: 4핵, 인체 감염형"""
NAMES = ["이질 아메바", "대장 아메바"]


def statements(*texts: str, concept: str = "이질 아메바") -> JsonObject:
    return {
        "question": {
            "concept": concept,
            "statements": list(texts),
            "reasons": ["노트에 적힌 운동 방법이다", "포낭형은 4핵이다", "노트에 적힌 먹이다"],
        }
    }


GOOD = statements("위족으로 운동한다.", "포낭형은 8핵이다.", "영양형은 적혈구를 먹는다.")


@pytest.fixture(autouse=True)
def keep_order(monkeypatch: pytest.MonkeyPatch) -> None:
    """문장 순서를 섞지 않음(섞기는 test_statements_are_shuffled_and_the_answer_follows가 봄)."""
    monkeypatch.setattr(combo, "order_for", lambda: [0, 1, 2])


def verdict(*values: bool) -> JsonObject:
    return {"correct": list(values)}


def build(llm: FakeLlm, truth: str = "ㄱ, ㄷ") -> combo.Built:
    return combo.build(llm, 1, PAGE, NAMES, "", "", truth)


# ---------- 조립 (코드) ----------


@pytest.mark.parametrize(
    ("raw", "bare"),
    [
        ("ㄱ. 위족으로 운동한다.", "위족으로 운동한다."),
        ("ㄴ) 위족으로 운동한다.", "위족으로 운동한다."),
        ("(ㄷ) 위족으로 운동한다.", "위족으로 운동한다."),
        ("ㄱ: 위족으로 운동한다.", "위족으로 운동한다."),
        ("1. 위족으로 운동한다.", "위족으로 운동한다."),
        ("① 위족으로 운동한다.", "위족으로 운동한다."),
        # 실험 3에서 'ㄱ. ㄱ 액티브…'가 된 문제: 기호 없이 띄어 쓴 ㄱ도 뗌
        ("ㄱ 액티브 탭은 굵게 보인다.", "액티브 탭은 굵게 보인다."),
        ("위족으로\n운동한다.", "위족으로 운동한다."),  # 제시문은 한 줄에 한 문장
        ("3 가지 운동 방법이 있다.", "3 가지 운동 방법이 있다."),  # 기호 없는 숫자는 문장
        ("ㄱㄴ 순서가 아니다.", "ㄱㄴ 순서가 아니다."),
    ],
)
def test_marks_before_a_statement_are_stripped(raw: str, bare: str) -> None:
    assert combo.strip_mark(raw) == bare


@pytest.mark.parametrize("truth", COMBOS)
def test_options_hold_the_answer_and_the_near_misses_in_the_fixed_order(truth: str) -> None:
    opts = combo.options_for(truth, ["가", "나", "다"])
    assert is_combo(opts)
    assert truth in opts
    assert opts == sorted(opts, key=COMBOS.index)
    marks = {c: set(c.replace(", ", "")) for c in COMBOS}
    near = [c for c in COMBOS if len(marks[c] ^ marks[truth]) == 1]
    # 한 문장만 다른 묶음이 먼저(넷이 넘지 않으면 모두)
    assert all(c in opts for c in near[:4])


def test_the_same_statements_give_the_same_options() -> None:
    a = combo.options_for("ㄱ", ["가", "나", "다"])
    assert a == combo.options_for("ㄱ", ["가", "나", "다"])


def test_the_truth_is_picked_from_every_combination(monkeypatch: pytest.MonkeyPatch) -> None:
    import random

    monkeypatch.setattr(combo, "_rng", random.Random(1))
    seen = {combo.truth_for() for _ in range(200)}
    assert seen == set(COMBOS)


# ---------- 만들기 (LLM) ----------


def test_the_model_writes_statements_and_the_code_builds_the_question() -> None:
    llm = FakeLlm({"Combo": [GOOD], "Verify": [verdict(True, False, True)]})
    b = build(llm)
    assert b.draft is not None and b.concept == "이질 아메바"
    assert b.draft["stem"] == "다음 중 이질 아메바에 대한 설명으로 옳은 것을 모두 고른 것은?"
    assert b.draft["passage"] == (
        "ㄱ. 위족으로 운동한다.\nㄴ. 포낭형은 8핵이다.\nㄷ. 영양형은 적혈구를 먹는다."
    )
    assert b.draft["answer"] == "ㄱ, ㄷ" and b.draft["answer"] in b.draft["options"]
    assert is_combo(b.draft["options"])
    assert b.draft.get("explanation") == (
        "ㄱ: 옳음. 노트에 적힌 운동 방법이다 ㄴ: 틀림. 포낭형은 4핵이다 "
        "ㄷ: 옳음. 노트에 적힌 먹이다"
    )
    gen, check = llm.named("Combo")[0], llm.named("Verify")[0]
    assert gen.model == settings.quiz_gen_model and check.model == settings.quiz_check_model
    assert "문장 3개를 이 순서로 만든다: ㄱ 옳음, ㄴ 틀림, ㄷ 옳음" in gen.user
    # 검사 모델은 노트와 기호를 붙인 문장으로 판정
    assert PAGE in check.user and "ㄴ. 포낭형은 8핵이다." in check.user


def test_marks_the_model_added_are_stripped_before_the_check() -> None:
    llm = FakeLlm(
        {
            "Combo": [
                statements("ㄱ. 위족으로 운동한다.", "ㄴ) 8핵이다.", "(ㄷ) 적혈구를 먹는다.")
            ],
            "Verify": [verdict(True, False, True)],
        }
    )
    b = build(llm)
    assert b.draft is not None
    assert b.draft["passage"] == "ㄱ. 위족으로 운동한다.\nㄴ. 8핵이다.\nㄷ. 적혈구를 먹는다."


def test_a_statement_judged_otherwise_drops_the_draft_with_the_reason() -> None:
    # '틀림'으로 요청한 ㄴ이 노트로 보면 옳음: 다음 시도에 문제점으로 알림(fault)
    llm = FakeLlm({"Combo": [GOOD], "Verify": [verdict(True, True, True)]})
    b = build(llm)
    assert b.draft is None and b.fault
    assert b.why == ["문장 판정이 요청과 다름(ㄴ은 틀린 문장이어야 하는데 노트로 보면 옳음)"]


def test_a_concept_outside_the_list_is_the_drafts_fault() -> None:
    llm = FakeLlm({"Combo": [statements("가.", "나.", "다.", concept="말라리아")]})
    b = build(llm)
    assert b.draft is None and b.fault and b.why == ["개념 이름 없음"]
    assert llm.named("Verify") == []


@pytest.mark.parametrize(
    "bad",
    [
        {"question": {"concept": "이질 아메바", "statements": ["가", "나"], "reasons": []}},
        {"question": {"concept": "이질 아메바", "statements": ["가", "나", "다"]}},  # 근거 없음
        statements("가", "", "다"),
        statements("가", "ㄴ.", "다"),  # 기호만 있던 문장
        {},
    ],
)
def test_a_malformed_answer_is_not_the_drafts_fault(bad: JsonObject) -> None:
    b = build(FakeLlm({"Combo": [bad]}))
    assert b.draft is None and not b.fault and b.answered and b.down == 0
    assert b.why == ["답 모양이 맞지 않음"]


def test_a_malformed_check_is_not_the_drafts_fault() -> None:
    b = build(FakeLlm({"Combo": [GOOD], "Verify": [{"correct": [True, False]}]}))
    assert b.draft is None and not b.fault and b.down == 0


@pytest.mark.parametrize(
    ("combo_answer", "verify_answer", "rejected", "answered"),
    [
        (LlmError("시간 초과"), None, 0, False),
        (LlmRejectedError("거절"), None, 1, False),
        (GOOD, LlmError("시간 초과"), 0, True),
    ],
)
def test_a_failed_call_is_counted_as_down(
    combo_answer: JsonObject | LlmError,
    verify_answer: LlmError | None,
    rejected: int,
    answered: bool,
) -> None:
    answers: dict[str, list[JsonObject | LlmError]] = {"Combo": [combo_answer]}
    if verify_answer is not None:
        answers["Verify"] = [verify_answer]
    b = build(FakeLlm(dict(answers)))
    assert b.draft is None and not b.fault
    assert (b.down, b.rejected, b.answered) == (1, rejected, answered)


def test_the_prompt_carries_the_hint_and_the_previous_problem() -> None:
    llm = FakeLlm({"Combo": [GOOD], "Verify": [verdict(True, False, True)]})
    combo.build(
        llm, 1, PAGE, NAMES, "\n이미 익힌 개념(피한다): 대장 아메바", "\n앞서 만든 문제", "ㄱ"
    )
    user = llm.named("Combo")[0].user
    assert "이미 익힌 개념(피한다): 대장 아메바" in user and "앞서 만든 문제" in user
    assert re.search(r"ㄱ 옳음, ㄴ 틀림, ㄷ 틀림$", user)


def test_statements_are_shuffled_and_the_answer_follows(monkeypatch: pytest.MonkeyPatch) -> None:
    # 생성 모델은 첫 문장을 옳게 · 마지막 문장을 틀리게 쓰는 버릇이 있어 판정을 통과한 뒤 섞음
    monkeypatch.setattr(combo, "order_for", lambda: [2, 0, 1])
    llm = FakeLlm({"Combo": [GOOD], "Verify": [verdict(True, False, True)]})
    b = build(llm, truth="ㄱ, ㄷ")
    assert b.draft is not None
    assert b.draft["passage"] == (
        "ㄱ. 영양형은 적혈구를 먹는다.\nㄴ. 위족으로 운동한다.\nㄷ. 포낭형은 8핵이다."
    )
    assert b.draft["answer"] == "ㄱ, ㄴ" and "ㄱ, ㄴ" in b.draft["options"]
    assert b.draft.get("explanation", "").startswith("ㄱ: 옳음. 노트에 적힌 먹이다 ㄴ: 옳음.")
    # 검사 모델은 요청한 순서로 판정(섞기 전)
    assert "ㄴ. 포낭형은 8핵이다." in llm.named("Verify")[0].user


def test_every_order_is_used(monkeypatch: pytest.MonkeyPatch) -> None:
    import random

    monkeypatch.undo()  # keep_order를 풀고 진짜 섞기로
    monkeypatch.setattr(combo, "_rng", random.Random(3))
    assert len({tuple(combo.order_for()) for _ in range(100)}) == 6
