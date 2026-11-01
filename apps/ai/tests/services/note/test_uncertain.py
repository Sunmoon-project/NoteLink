import pytest

from app.services.note.models import Line
from app.services.note.uncertain import (
    MARK,
    lowest_token_confidence,
    mark_uncertain,
    tokens,
)
from tests.services.note.helpers import line, word


def syllables(text: str, confs: list[float]) -> Line:
    """글자(띄어쓰기 제외) 하나마다 OCR 단어 하나 — 한국어 OCR이 주는 모양."""
    ws = []
    i = 0
    for pos, ch in enumerate(text):
        if ch != " ":
            ws.append(word(ch, pos, confidence=confs[i]))
            i += 1
    return line(text, 0, 1, 0, words=ws)


def test_tokens_group_syllables_by_spaces() -> None:
    ln = syllables("포낭형 4핵성", [0.9, 0.9, 0.9, 0.2, 0.4, 0.6])
    toks = tokens(ln)
    assert [t.text for t in toks] == ["포낭형", "4핵성"]
    assert toks[1].confidence == pytest.approx(0.4)


def test_mark_uncertain_puts_mark_before_blurry_word_and_shifts_words() -> None:
    ln = syllables("포낭형 4핵성 운동", [0.9, 0.9, 0.9, 0.2, 0.4, 0.6, 0.95, 0.95])
    (out,) = mark_uncertain([ln])
    assert out["text"] == f"포낭형 {MARK}4핵성 운동"
    # 단어 위치가 새 글자 기준으로 맞음
    assert all(out["text"][w["start"] : w["end"]] == w["text"] for w in out["words"])
    assert ln["text"] == "포낭형 4핵성 운동"  # 원래 줄은 그대로


def test_clear_line_is_returned_unchanged() -> None:
    ln = syllables("이질 아메바", [0.9] * 5)
    assert mark_uncertain([ln]) == [ln]


@pytest.mark.parametrize("text", ["I.", "1.", "①", "!!", "×", "20°", "(1)"])
def test_marks_and_heading_numbers_are_never_uncertain(text: str) -> None:
    ln = line(text, 0, 1, 0, words=[word(text, 0, confidence=0.1)])
    assert mark_uncertain([ln])[0]["text"] == text


def test_known_terms_are_not_marked() -> None:
    ln = syllables("요오드아메바", [0.3] * 6)
    assert mark_uncertain([ln], known=frozenset({"요오드아메바"}))[0]["text"] == "요오드아메바"
    assert mark_uncertain([ln])[0]["text"].startswith(MARK)


def test_threshold_is_adjustable() -> None:
    ln = syllables("초음파", [0.55] * 3)
    assert mark_uncertain([ln])[0]["text"] == "초음파"  # 기본 0.5
    assert mark_uncertain([ln], threshold=0.6)[0]["text"] == f"{MARK}초음파"


def test_lowest_token_confidence_uses_word_groups_not_syllables() -> None:
    ln = syllables("섭취 가능", [0.7, 0.9, 0.9, 0.9])  # 음절 최솟값 0.7, 낱말 평균 0.8
    assert lowest_token_confidence(ln) == pytest.approx(0.8)
    assert lowest_token_confidence(line("", 0, 1, 0)) == 1.0
