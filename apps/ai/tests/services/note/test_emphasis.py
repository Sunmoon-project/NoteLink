import cv2
import numpy as np
import pytest

from app.services.note.emphasis import (
    annotate_colors,
    color_name,
    marks_for_rows,
    merge_marks,
    text_marks,
)
from app.services.note.models import Mark
from tests.services.note.helpers import line, row, word

# ---------- color_name ----------


@pytest.mark.parametrize(
    ("bgr", "name"),
    [
        ((0, 0, 220), "red"),
        ((200, 40, 30), "blue"),
        ((30, 30, 30), "black"),
        ((0, 150, 0), "green"),
    ],
)
def test_color_name(bgr: tuple[int, int, int], name: str) -> None:
    px = np.array([[bgr]], dtype=np.uint8)
    lab = cv2.cvtColor(px, cv2.COLOR_BGR2LAB).astype(np.float32)[0, 0]
    assert color_name(float(lab[1]) - 128, float(lab[2]) - 128) == name


# ---------- text_marks ----------


@pytest.mark.parametrize(
    ("text", "found"),
    [
        ("★ 포낭형", ["★"]),
        ("※ 주의", ["※"]),
        ("각도!!는 20° 아래", ["!!"]),
        ("국시 중요", ["국시", "중요"]),
        ("(중요) 핵분열", ["중요"]),
        ("시험에 나옴", ["시험에 나"]),
        ("꼭 외우기", ["꼭 외우"]),
        ("객 33 · 주 9", ["객 33 · 주 9"]),
        ("시험관에 넣는다", []),  # 낱말 안의 '시험'
        ("기출문제 풀이", []),
        ("중요성이 크다", []),
        ("감염!", []),  # 느낌표 하나는 강조로 보지 않음
    ],
)
def test_text_marks(text: str, found: list[str]) -> None:
    assert [m.get("text") for m in text_marks(text)] == found


# ---------- merge_marks · marks_for_rows ----------


def test_merge_marks_joins_neighbours_of_the_same_color() -> None:
    marks: list[Mark] = [
        {"kind": "color", "start": 0, "end": 2, "color": "red"},
        {"kind": "color", "start": 3, "end": 5, "color": "red"},  # 띄어쓰기 하나 사이
        {"kind": "color", "start": 6, "end": 7, "color": "blue"},
        {"kind": "symbol", "start": 8, "end": 9, "text": "★"},
        {"kind": "symbol", "start": 9, "end": 10, "text": "★"},
    ]
    out = merge_marks(marks)
    assert [(m["kind"], m["start"], m["end"]) for m in out] == [
        ("color", 0, 5),
        ("color", 6, 7),
        ("symbol", 8, 9),
        ("symbol", 9, 10),
    ]


def test_marks_for_rows_uses_offsets_in_the_joined_text() -> None:
    r1 = row(
        "★ 1540 m/sec", words=[word("1540", 2, colorDiff=True, color="red", baseColor="black")]
    )
    r2 = row(
        "형광펜 칠함",
        words=[word("형광펜", 0, highlight="yellow"), word("칠함", 4, highlight="yellow")],
    )
    text = f"{r1['text']}\n{r2['text']}"
    marks = marks_for_rows([r1, r2])
    got = {(m["kind"], text[m["start"] : m["end"]]) for m in marks}
    assert got == {("symbol", "★"), ("color", "1540"), ("highlight", "형광펜 칠함")}
    color = next(m for m in marks if m["kind"] == "color")
    assert color.get("baseColor") == "black"


# ---------- annotate_colors (그린 그림으로 시험) ----------

WHITE, BLACK, RED = (255, 255, 255), (20, 20, 20), (30, 30, 220)
LIGHT_YELLOW = (150, 245, 255)


def stroke(img: np.ndarray, box: tuple[int, int, int, int], color: tuple[int, int, int]) -> None:  # type: ignore[type-arg]
    x0, y0, x1, y1 = box
    cv2.rectangle(img, (x0 + 4, y0 + 8), (x1 - 4, y1 - 8), color, -1)  # 글씨 대신 굵은 획


def test_annotate_colors_finds_minor_handwriting_color_and_highlight() -> None:
    img = np.full((300, 600, 3), WHITE, np.uint8)
    boxes = [(20, 20, 80, 50), (100, 20, 160, 50), (180, 20, 240, 50), (260, 20, 320, 50)]
    for box, color in zip(boxes, [BLACK, BLACK, BLACK, RED], strict=True):
        stroke(img, box, color)
    printed = (20, 120, 120, 150)
    cv2.rectangle(img, (printed[0], printed[1] + 5), (printed[2], printed[3] - 5), LIGHT_YELLOW, -1)
    stroke(img, printed, BLACK)

    hand = line(
        "가나 다라 마바 사아",
        0,
        1,
        0,
        words=[
            word(t, i * 3, b)
            for i, (t, b) in enumerate(zip(["가나", "다라", "마바", "사아"], boxes, strict=True))
        ],
    )
    prn = line("인쇄", 0, 1, 0.4, lid=2, hand=False, words=[word("인쇄", 0, printed)])
    out = annotate_colors(img, [hand, prn])

    flags = [(w.get("color"), w.get("colorDiff")) for w in out[0]["words"]]
    assert flags == [("black", False)] * 3 + [("red", True)]
    assert out[0]["words"][3].get("baseColor") == "black"
    p = out[1]["words"][0]
    assert p.get("highlight") == "yellow"
    assert "colorDiff" not in p  # 인쇄 글자의 색은 강조로 보지 않음 (10/28)


def test_blue_pen_page_uses_blue_as_the_base_color() -> None:
    img = np.full((100, 600, 3), WHITE, np.uint8)
    blue = (200, 40, 30)
    boxes = [(20 + i * 70, 20, 80 + i * 70, 50) for i in range(5)]
    for b in boxes:
        stroke(img, b, blue)
    hand = line("파란 펜", 0, 1, 0, words=[word("가나", i * 3, b) for i, b in enumerate(boxes)])
    (out,) = annotate_colors(img, [hand])
    assert all(w.get("color") == "blue" and w.get("colorDiff") is False for w in out["words"])


def test_word_without_enough_ink_is_left_as_is() -> None:
    img = np.full((100, 100, 3), WHITE, np.uint8)
    w = word("빈칸", 0, (10, 10, 60, 40))
    (out,) = annotate_colors(img, [line("빈칸", 0, 1, 0, words=[w])])
    assert out["words"][0] == w


def test_handwriting_after_a_printed_number_is_checked_by_word() -> None:
    # 고치기 전: 줄 첫 글자(인쇄 '1.')로 줄 전체를 인쇄로 보아 빨간 손글씨를 놓침
    img = np.full((200, 600, 3), WHITE, np.uint8)
    boxes = [(20 + i * 70, 20, 80 + i * 70, 50) for i in range(4)]
    for b in boxes:
        stroke(img, b, BLACK)
    num, red = (20, 100, 60, 130), (80, 100, 200, 130)
    stroke(img, num, BLACK)
    stroke(img, red, RED)
    hand = line(
        "가나 다라 마바 사아", 0, 1, 0, words=[word("가나", i * 3, b) for i, b in enumerate(boxes)]
    )
    mixed = line(
        "1. 빨강",
        0,
        1,
        0.5,
        lid=2,
        hand=False,
        words=[word("1.", 0, num, hand=False), word("빨강", 3, red, hand=True)],
    )
    out = annotate_colors(img, [hand, mixed])
    n, r = out[1]["words"]
    assert r.get("colorDiff") is True
    assert "colorDiff" not in n  # 인쇄 번호는 그대로
