"""OCR(Read) 결과를 읽는 순서로 정리. Read가 주는 줄 순서는 읽는 순서가 아니라 좌표로 정합니다."""

import statistics
import unicodedata
from typing import Any

from app.services.note.models import Line, PageLayout, Row, Word

FIGURE_LABEL_HEIGHT = 0.75  # 손글씨 줄 높이의 이 배보다 작은 인쇄 줄 = 그림 이름표
MOSTLY_HANDWRITTEN = 0.6  # 손글씨 줄이 이 비율 이상인 쪽에서만 이름표를 뺌
GUTTER_RANGE = (30, 70)  # 단 경계를 찾는 범위(쪽 폭 %)
GUTTER_MIN_WIDTH = 3  # 단 경계로 볼 빈 띠의 최소 폭(%)
GUTTER_ALLOW = 0.04  # 경계를 지나가도 되는 줄 비율
GUTTER_MIN_LINES = 2  # 두 단으로 보려면 경계 양쪽에 있어야 하는 줄 수
SPAN_BOTH = 0.05  # 경계 양쪽으로 이만큼 걸친 줄 = 두 단을 가로지르는 줄
SIDE_BY_SIDE = 0.3  # 가로로 나란한 두 줄이 높이로 이만큼 겹치면 한 줄
X_TOLERANCE = 0.01  # 나란한지 볼 때 허용하는 가로 겹침


def lines_from_read(result: dict[str, Any], page_no: int | None = None) -> list[Line]:
    """Read 결과에서 줄과 단어를 꺼냄.

    page_no: 업로드 순서의 쪽 번호. 사진은 장마다 OCR해서 pageNumber가 늘 1이라 넘겨야 함.
    """
    hand = [
        (s["offset"], s["offset"] + s["length"])
        for st in result.get("styles") or []
        if st.get("isHandwritten")
        for s in st.get("spans") or []
    ]
    out: list[Line] = []
    for page in result.get("pages") or []:
        width, height = float(page["width"]), float(page["height"])
        number = int(page["pageNumber"])
        if page_no is not None:
            number = page_no + number - 1
        words = page.get("words") or []
        for i, ln in enumerate(page.get("lines") or []):
            xs, ys = ln["polygon"][0::2], ln["polygon"][1::2]
            off = ln["spans"][0]["offset"]
            end = off + sum(s["length"] for s in ln["spans"])
            text = unicodedata.normalize("NFC", ln["content"])
            out.append(
                {
                    "id": i + 1,
                    "page": number,
                    "text": text,
                    "x0": min(xs) / width,
                    "x1": max(xs) / width,
                    "y0": min(ys) / height,
                    "y1": max(ys) / height,
                    "hand": any(a <= off < b for a, b in hand),
                    "words": _words_in(words, off, end, text, hand),
                }
            )
    return out


def _words_in(
    words: list[dict[str, Any]],
    start: int,
    end: int,
    line_text: str,
    hand: list[tuple[int, int]],
) -> list[Word]:
    # NFC로 바꾸면 글자 수가 달라질 수 있어 OCR offset 대신 줄 글자에서 찾음
    out: list[Word] = []
    cursor = 0
    for w in words:
        off = w["span"]["offset"]
        if not start <= off < end:
            continue
        text = unicodedata.normalize("NFC", w["content"])
        found = line_text.find(text, cursor)
        pos = found if found >= 0 else min(off - start, len(line_text))
        cursor = pos + len(text) if found >= 0 else cursor
        out.append(
            {
                "text": text,
                "start": pos,
                "end": pos + len(text),
                "polygon": [float(v) for v in w["polygon"]],
                "confidence": float(w["confidence"]),
                "hand": any(a <= off < b for a, b in hand),
            }
        )
    return out


def drop_figure_labels(lines: list[Line]) -> tuple[list[Line], list[Line]]:
    """(본문 줄, 그림 이름표 줄). 손으로 그린 그림의 이름표는 못 거름."""
    hand = [ln for ln in lines if ln["hand"]]
    if not lines or len(hand) < MOSTLY_HANDWRITTEN * len(lines):
        return lines, []
    usual = statistics.median(ln["y1"] - ln["y0"] for ln in hand)
    small = [
        ln
        for ln in lines
        if not _has_hand(ln) and (ln["y1"] - ln["y0"]) < FIGURE_LABEL_HEIGHT * usual
    ]
    return [ln for ln in lines if ln not in small], small


def _has_hand(ln: Line) -> bool:
    # 인쇄 번호로 시작해도 손글씨 단어가 있으면 본문 (이름표로 지우지 않음)
    return ln["hand"] or any(w.get("hand") for w in ln["words"])


def find_gutter(lines: list[Line]) -> float | None:
    """두 단 사이 경계(0~1). 줄이 거의 지나지 않는 가장 넓은 세로 띠의 가운데."""
    # 찾는 범위를 다 덮는 줄(가로 제목)은 빼고 셈. 대신 경계 양쪽에 줄이 있어야 두 단
    lo, hi = GUTTER_RANGE[0] / 100, GUTTER_RANGE[1] / 100
    narrow = [ln for ln in lines if not (ln["x0"] <= lo and ln["x1"] >= hi)]
    if not narrow:
        return None
    cover = [0] * 101
    for ln in narrow:
        for x in range(int(ln["x0"] * 100), min(int(ln["x1"] * 100), 100) + 1):
            cover[x] += 1
    allow = max(1, int(len(narrow) * GUTTER_ALLOW))
    best: tuple[int, int] | None = None  # (시작, 폭)
    run = 0
    for x in range(GUTTER_RANGE[0], GUTTER_RANGE[1] + 1):
        run = run + 1 if cover[x] <= allow else 0
        if run >= GUTTER_MIN_WIDTH and (best is None or run > best[1]):
            best = (x - run + 1, run)
    if best is None:
        return None
    g = (best[0] + best[1] / 2) / 100
    left = sum(ln["x1"] <= g for ln in narrow)
    right = sum(ln["x0"] >= g for ln in narrow)
    return g if min(left, right) >= GUTTER_MIN_LINES else None


def merge_rows(lines: list[Line]) -> list[Row]:
    """위→아래로 놓고, 같은 높이에 나란한 줄은 왼쪽→오른쪽으로 합침."""
    rows: list[Row] = []
    for ln in sorted(lines, key=lambda x: (x["y0"], x["x0"])):
        if rows and _overlap(rows[-1], ln) > _need(rows[-1], ln):
            rows[-1] = _join(rows[-1], ln)
        else:
            rows.append(_row(ln))
    return rows


def _need(r: Row, ln: Line) -> float:
    # 가로로 겹치는 줄은 같은 줄일 수 없음 (휘어진 사진은 위아래 줄 상자가 높이로 겹치기도 함)
    side_by_side = ln["x0"] >= r["x1"] - X_TOLERANCE or ln["x1"] <= r["x0"] + X_TOLERANCE
    return SIDE_BY_SIDE if side_by_side else float("inf")


def _overlap(r: Row, ln: Line) -> float:
    shorter = min(r["y1"] - r["y0"], ln["y1"] - ln["y0"])
    return (min(r["y1"], ln["y1"]) - max(r["y0"], ln["y0"])) / shorter if shorter > 0 else 0.0


def _row(ln: Line) -> Row:
    return {
        "page": ln["page"],
        "lineIds": [ln["id"]],
        "text": ln["text"],
        "x0": ln["x0"],
        "x1": ln["x1"],
        "y0": ln["y0"],
        "y1": ln["y1"],
        "hand": ln["hand"],
        "words": list(ln["words"]),
    }


def _join(r: Row, ln: Line) -> Row:
    a, b = (r, _row(ln)) if r["x0"] <= ln["x0"] else (_row(ln), r)
    shift = len(a["text"]) + 1
    moved: list[Word] = [
        {**w, "start": w["start"] + shift, "end": w["end"] + shift} for w in b["words"]
    ]
    return {
        "page": r["page"],
        "lineIds": a["lineIds"] + b["lineIds"],
        "text": f"{a['text']} {b['text']}",
        "x0": min(r["x0"], ln["x0"]),
        "x1": max(r["x1"], ln["x1"]),
        "y0": min(r["y0"], ln["y0"]),
        "y1": max(r["y1"], ln["y1"]),
        "hand": r["hand"] and ln["hand"],
        "words": a["words"] + moved,
    }


def reading_order(lines: list[Line]) -> list[Row]:
    """쪽 하나를 읽는 순서로. 두 단이면 왼쪽 단 → 오른쪽 단."""
    gutter = find_gutter(lines)
    if gutter is None:
        return merge_rows(lines)

    def side(ln: Line) -> str:
        if ln["x0"] < gutter - SPAN_BOTH and ln["x1"] > gutter + SPAN_BOTH:
            return "both"
        return "left" if ln["x0"] < gutter else "right"

    # 두 단을 가로지르는 줄을 기준으로 위아래 구역을 나눠 구역마다 왼쪽 → 오른쪽
    out: list[Row] = []
    top = -1.0
    crossing = sorted((ln for ln in lines if side(ln) == "both"), key=lambda x: x["y0"])
    for cut in [*crossing, None]:
        bottom = cut["y0"] if cut else 2.0
        for s in ("left", "right"):
            out += merge_rows([ln for ln in lines if side(ln) == s and top <= ln["y0"] < bottom])
        if cut:
            out.append(_row(cut))
            top = cut["y0"]
    return out


def layout_pages(lines: list[Line]) -> list[PageLayout]:
    """쪽마다 그림 이름표를 빼고 읽는 순서로 놓음."""
    out: list[PageLayout] = []
    for page in sorted({ln["page"] for ln in lines}):
        body, _ = drop_figure_labels([ln for ln in lines if ln["page"] == page])
        out.append(
            {
                "pageNo": page,
                "twoColumn": find_gutter(body) is not None,
                "rows": reading_order(body),
            }
        )
    return out


def page_rows(lines: list[Line]) -> list[Row]:
    """여러 쪽을 쪽 순서대로 이은 읽는 순서."""
    return [r for p in layout_pages(lines) for r in p["rows"]]
