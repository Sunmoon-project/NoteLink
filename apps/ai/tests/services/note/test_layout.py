import unicodedata

from app.services.note.layout import (
    drop_figure_labels,
    find_gutter,
    lines_from_read,
    merge_rows,
    page_rows,
    reading_order,
)
from tests.services.note.helpers import line, word

# ---------- lines_from_read ----------


def read_result() -> dict[str, object]:
    nfd = unicodedata.normalize("NFD", "포낭형")
    content = f"{nfd} 1~2핵\nprinted"
    return {
        "content": content,
        "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": 9}]}],
        "pages": [
            {
                "pageNumber": 1,
                "width": 1000,
                "height": 2000,
                "lines": [
                    {
                        "content": f"{nfd} 1~2핵",
                        "polygon": [100, 200, 500, 200, 500, 240, 100, 240],
                        "spans": [{"offset": 0, "length": 9}],
                    },
                    {
                        "content": "printed",
                        "polygon": [100, 300, 300, 300, 300, 330, 100, 330],
                        "spans": [{"offset": 10, "length": 7}],
                    },
                ],
                "words": [
                    {
                        "content": "1~2핵",
                        "polygon": [300, 200, 500, 200, 500, 240, 300, 240],
                        "confidence": 0.9,
                        "span": {"offset": 7, "length": 2},
                    },
                    {
                        "content": "printed",
                        "polygon": [100, 300, 300, 300, 300, 330, 100, 330],
                        "confidence": 0.99,
                        "span": {"offset": 10, "length": 7},
                    },
                ],
            }
        ],
    }


def test_lines_from_read_reads_lines_words_and_handwriting() -> None:
    hand, printed = lines_from_read(read_result())
    assert hand["text"] == "포낭형 1~2핵"  # NFD로 와도 NFC로 맞춤
    assert hand["hand"] and not printed["hand"]
    assert (hand["x0"], hand["x1"], hand["y0"]) == (0.1, 0.5, 0.1)
    # NFC로 맞춘 줄 글자 안 위치 (자모가 풀린 OCR offset 7을 그대로 쓰면 어긋남)
    assert hand["words"][0]["start"] == 4
    assert hand["text"][4:9] == "1~2핵"
    assert printed["words"][0]["start"] == 0 and printed["id"] == 2


def test_lines_from_read_marks_handwriting_per_word() -> None:
    # 인쇄 번호 뒤에 손글씨가 이어진 줄: 줄은 인쇄(첫 글자 기준), 단어는 따로
    content = "1. 손글씨"
    res = {
        "content": content,
        "styles": [{"isHandwritten": True, "spans": [{"offset": 3, "length": 3}]}],
        "pages": [
            {
                "pageNumber": 1,
                "width": 100,
                "height": 100,
                "lines": [
                    {
                        "content": content,
                        "polygon": [0, 0, 50, 0, 50, 5, 0, 5],
                        "spans": [{"offset": 0, "length": 6}],
                    }
                ],
                "words": [
                    {
                        "content": "1.",
                        "polygon": [0, 0, 5, 0, 5, 5, 0, 5],
                        "confidence": 0.9,
                        "span": {"offset": 0, "length": 2},
                    },
                    {
                        "content": "손글씨",
                        "polygon": [6, 0, 20, 0, 20, 5, 6, 5],
                        "confidence": 0.9,
                        "span": {"offset": 3, "length": 3},
                    },
                ],
            }
        ],
    }
    (ln,) = lines_from_read(res)
    assert ln["hand"] is False
    assert [w.get("hand") for w in ln["words"]] == [False, True]


def test_lines_from_read_handles_empty_result() -> None:
    assert lines_from_read({}) == []


# ---------- find_gutter ----------


def two_columns(n: int = 10) -> list:  # type: ignore[type-arg]
    left = [line(f"왼쪽 {i}", 0.03, 0.43, 0.05 + i * 0.05, lid=i) for i in range(n)]
    right = [line(f"오른쪽 {i}", 0.53, 0.83, 0.05 + i * 0.05, lid=100 + i) for i in range(n)]
    return left + right


def test_find_gutter_in_two_columns() -> None:
    g = find_gutter(two_columns())
    assert g is not None and 0.43 < g < 0.53


def test_find_gutter_allows_a_line_slightly_crossing() -> None:
    lines = two_columns(15) + [line("긴 줄", 0.03, 0.52, 0.9, lid=999)]  # 30줄 중 1줄은 허용
    assert find_gutter(lines) is not None


def test_one_column_has_no_gutter() -> None:
    lines = [line(f"줄 {i}", 0.05, 0.9, i * 0.05, lid=i) for i in range(10)]
    assert find_gutter(lines) is None
    assert find_gutter([]) is None


def test_two_wide_titles_do_not_hide_the_gutter() -> None:
    # 고치기 전: 가로 제목 2줄이 허용 교차 수(1)를 넘겨 두 단을 못 찾고 L0 R0 L1 R1 …로 읽음
    titles = [line(f"제목 {i}", 0.03, 0.83, 0.02 + i * 0.04, lid=90 + i) for i in range(2)]
    left = [line(f"L{i}", 0.03, 0.43, 0.2 + i * 0.05, lid=i) for i in range(3)]
    right = [line(f"R{i}", 0.53, 0.83, 0.2 + i * 0.05, lid=10 + i) for i in range(3)]
    lines = titles + left + right
    assert find_gutter(lines) is not None
    texts = [r["text"] for r in reading_order(lines)]
    assert texts == ["제목 0", "제목 1", "L0", "L1", "L2", "R0", "R1", "R2"]


def test_short_lines_on_one_side_are_not_two_columns() -> None:
    lines = [line(f"줄 {i}", 0.05, 0.9, i * 0.05, lid=i) for i in range(6)]
    lines += [line(f"짧은 {i}", 0.05, 0.25, 0.5 + i * 0.05, lid=20 + i) for i in range(3)]
    assert find_gutter(lines) is None


# ---------- merge_rows · reading_order ----------


def test_merge_rows_joins_lines_on_the_same_height_left_to_right() -> None:
    a = line("1~2핵", 0.3, 0.4, 0.10, lid=2, words=[word("1~2핵", 0)])
    b = line("- 포낭형 :", 0.05, 0.25, 0.101, lid=1, words=[word("포낭형", 2)])
    (r,) = merge_rows([a, b])
    assert r["text"] == "- 포낭형 : 1~2핵"
    assert r["lineIds"] == [1, 2]
    assert [r["text"][w["start"] : w["end"]] for w in r["words"]] == ["포낭형", "1~2핵"]


def test_lines_that_overlap_sideways_are_never_joined() -> None:
    # 휘어진 사진: 위아래 줄 상자가 높이로 83% 겹쳐도 가로로 겹치면 다른 줄
    end = line("로 구분", 0.255, 0.304, 0.2441, lid=10, height=0.0121)
    nxt = line("• A - mode: 수신된", 0.256, 0.627, 0.2462, lid=11, height=0.026)
    assert [r["text"] for r in merge_rows([end, nxt])] == ["로 구분", "• A - mode: 수신된"]


def test_tilted_choices_side_by_side_are_joined_in_x_order() -> None:
    # 기울어진 사진: ②가 ①보다 조금 위에 있고 높이로 40%만 겹침
    two = line("2 B-mode", 0.47, 0.56, 0.180, lid=2, height=0.02)
    one = line("1 A-mode", 0.28, 0.37, 0.192, lid=1, height=0.02)
    (r,) = merge_rows([two, one])
    assert r["text"] == "1 A-mode 2 B-mode"


def test_reading_order_reads_left_column_then_right() -> None:
    # Read 모델은 오른쪽 위 줄을 먼저 줄 수 있음
    lines = list(reversed(two_columns(3)))
    texts = [r["text"] for r in reading_order(lines)]
    assert texts == ["왼쪽 0", "왼쪽 1", "왼쪽 2", "오른쪽 0", "오른쪽 1", "오른쪽 2"]


def test_line_across_both_columns_splits_top_and_bottom() -> None:
    top = two_columns(2)
    cross = line("가로지르는 제목", 0.03, 0.83, 0.2, lid=50)
    bottom = [
        line("아래 왼쪽", 0.03, 0.43, 0.3, lid=60),
        line("아래 오른쪽", 0.53, 0.83, 0.3, lid=61),
    ]
    filler = [line(f"채움 {i}", 0.03, 0.43, 0.4 + i * 0.05, lid=70 + i) for i in range(6)]
    filler += [line(f"채움 오른쪽 {i}", 0.53, 0.83, 0.4 + i * 0.05, lid=80 + i) for i in range(6)]
    texts = [r["text"] for r in reading_order(top + [cross] + bottom + filler)]
    assert texts.index("오른쪽 1") < texts.index("가로지르는 제목") < texts.index("아래 왼쪽")


# ---------- drop_figure_labels · page_rows ----------


def test_small_printed_lines_on_a_handwritten_page_are_figure_labels() -> None:
    body = [line(f"손글씨 {i}", 0.05, 0.4, i * 0.05, lid=i) for i in range(5)]
    label = line("핵(nucleus)", 0.8, 0.9, 0.1, lid=9, hand=False, height=0.01)
    kept, dropped = drop_figure_labels(body + [label])
    assert dropped == [label] and label not in kept


def test_small_line_with_handwritten_words_is_not_a_figure_label() -> None:
    # 고치기 전: 인쇄 번호로 시작한 줄(hand=False)이 작으면 손글씨까지 통째로 지워짐
    body = [line(f"손글씨 {i}", 0.05, 0.4, i * 0.05, lid=i) for i in range(5)]
    mixed = line(
        "1. 손글씨",
        0.05,
        0.4,
        0.3,
        lid=8,
        hand=False,
        height=0.01,
        words=[word("1.", 0, hand=False), word("손글씨", 3, hand=True)],
    )
    label = line("핵(nucleus)", 0.8, 0.9, 0.1, lid=9, hand=False, height=0.01)
    kept, dropped = drop_figure_labels(body + [mixed, label])
    assert mixed in kept and dropped == [label]


def test_printed_page_keeps_small_lines() -> None:
    lines = [line(f"인쇄 {i}", 0.05, 0.9, i * 0.05, lid=i, hand=False) for i in range(5)]
    lines.append(line("작은 주석", 0.05, 0.3, 0.5, lid=9, hand=False, height=0.005))
    assert drop_figure_labels(lines)[1] == []


def test_page_rows_keeps_page_order() -> None:
    p2 = line("둘째 쪽", 0.05, 0.9, 0.1, lid=1, page=2)
    p1 = line("첫 쪽", 0.05, 0.9, 0.5, lid=1, page=1)
    assert [r["text"] for r in page_rows([p2, p1])] == ["첫 쪽", "둘째 쪽"]
