"""강조 표시 찾기: 색이 다른 손글씨 · 형광펜 · 기호/낱말.

손글씨 색은 그 쪽 손글씨의 주된 색과 다를 때만 강조(인쇄 글자 색은 보지 않음).
형광펜은 인쇄 글자 위에 칠해도 강조. 파랑 · 보라는 구분하지 않고, 밑줄 · 동그라미는 못 찾음.
"""

import math
import re
from collections import Counter
from dataclasses import dataclass

import cv2
import numpy as np
from numpy.typing import NDArray

from app.services.note.models import Line, Mark, Row, Word

type Image = NDArray[np.uint8]  # OpenCV BGR

GRAY_CHROMA = 18  # 채도가 이보다 낮으면 검정
INK_DARK = 60  # 바탕보다 이만큼 어두우면 글씨 픽셀
INK_COLOR = (30, 25)  # 또는 바탕과 색 차이 30 이상 · 25 이상 어두우면 글씨 픽셀
HIGHLIGHT = 10  # 종이색과 이만큼 다르면 칠한 픽셀
HIGHLIGHT_SHARE = 0.3  # 칠한 픽셀이 이 비율을 넘으면 형광펜
MINOR_SHARE = 0.3  # 손글씨에서 이 비율보다 적게 쓴 색만 강조
MIN_INK = 12  # 글씨 픽셀이 이보다 적으면 색을 재지 않음
HUES = (  # Lab 색상각(도) → 이름. 파란 펜이 300° 근처라 파랑을 넓게 잡음
    ("red", 0, 50),
    ("yellow", 50, 110),
    ("green", 110, 190),
    ("cyan", 190, 240),
    ("blue", 240, 320),
    ("purple", 320, 345),
)

SYMBOLS = re.compile(r"[★☆※]|!{2,}")
_ALONE = "(?<![가-힣])(?:{})(?![가-힣])"  # 앞뒤에 한글이 붙으면 다른 낱말(시험관 · 중요성)
KEYWORDS = re.compile(
    "|".join(
        [
            _ALONE.format("중요|암기|필수|빈출|기출|국시|시험|출제"),
            r"시험에\s*(?:나|출제|잘)",
            r"꼭\s*(?:외우|외워|알아|기억)",
            r"객\s*\d+\s*[·,/]?\s*주\s*\d+",  # "객 33 · 주 9"
        ]
    )
)


def color_name(a: float, b: float, gray: float = GRAY_CHROMA) -> str:
    """Lab의 a · b(128을 뺀 값) → 색 이름."""
    if math.hypot(a, b) < gray:
        return "black"
    hue = math.degrees(math.atan2(b, a)) % 360
    return next((name for name, lo, hi in HUES if lo <= hue < hi), "red")


@dataclass(frozen=True)
class _Sample:
    ink: NDArray[np.float32]  # 글씨색 L · a · b
    rest: NDArray[np.float32]  # 글씨가 아닌 픽셀
    box: tuple[int, int, int, int]


def _measure(lab: NDArray[np.float32], polygon: list[float]) -> _Sample | None:
    xs, ys = polygon[0::2], polygon[1::2]
    h, w = lab.shape[:2]
    x0, y0 = max(int(min(xs)) - 2, 0), max(int(min(ys)) - 2, 0)
    x1, y1 = min(int(max(xs)) + 2, w), min(int(max(ys)) + 2, h)
    px = lab[y0:y1, x0:x1].reshape(-1, 3)
    if len(px) < 20:
        return None
    light = px[:, 0]
    bg = np.median(px[light >= np.percentile(light, 60)], axis=0)
    dark = bg[0] - light
    dist = np.hypot(px[:, 1] - bg[1], px[:, 2] - bg[2])
    is_ink = (dark > INK_DARK) | ((dist > INK_COLOR[0]) & (dark > INK_COLOR[1]))
    if int(is_ink.sum()) < MIN_INK:
        return None
    return _Sample(np.median(px[is_ink], axis=0), px[~is_ink], (x0, y0, x1, y1))


def _lab(image: Image) -> NDArray[np.float32]:
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB).astype(np.float32)
    lab[:, :, 1:] -= 128
    return lab


def _paper(lab: NDArray[np.float32], boxes: list[tuple[int, int, int, int]]) -> NDArray[np.float32]:
    # 단어 상자 바깥의 밝은 픽셀 (형광펜을 많이 칠한 쪽에서도 틀어지지 않게)
    outside = np.ones(lab.shape[:2], dtype=bool)
    for x0, y0, x1, y1 in boxes:
        outside[y0:y1, x0:x1] = False
    px = lab[outside] if outside.any() else lab.reshape(-1, 3)
    return np.asarray(np.median(px[px[:, 0] >= np.percentile(px[:, 0], 50)], axis=0), np.float32)


def annotate_colors(image: Image, lines: list[Line]) -> list[Line]:
    """단어마다 글씨색 · 형광펜을 붙인 새 줄 목록. image는 OCR에 넣은 것과 같은 크기."""
    lab = _lab(image)
    samples: dict[tuple[int, int], _Sample] = {}
    for i, ln in enumerate(lines):
        for j, w in enumerate(ln["words"]):
            if (s := _measure(lab, w["polygon"])) is not None:
                samples[(i, j)] = s
    paper = _paper(lab, [s.box for s in samples.values()])

    names = {k: color_name(float(s.ink[1]), float(s.ink[2])) for k, s in samples.items()}
    count: Counter[str] = Counter()
    for (i, j), name in names.items():
        if _is_hand(lines[i], lines[i]["words"][j]):
            count[name] += len(lines[i]["words"][j]["text"])
    total = sum(count.values())
    base = count.most_common(1)[0][0] if count else None

    out: list[Line] = []
    for i, ln in enumerate(lines):
        words: list[Word] = []
        for j, w in enumerate(ln["words"]):
            s = samples.get((i, j))
            if s is None:
                words.append(w)
                continue
            nw: Word = {**w, "color": names[(i, j)]}
            if _is_hand(ln, w) and base is not None:
                minor = count[names[(i, j)]] / total < MINOR_SHARE
                nw["colorDiff"] = names[(i, j)] != base and minor
                nw["baseColor"] = base
            if (hl := _highlight(s.rest, paper)) is not None:
                nw["highlight"] = hl
            words.append(nw)
        out.append({**ln, "words": words})
    return out


def _is_hand(ln: Line, w: Word) -> bool:
    return w.get("hand", ln["hand"])


def _highlight(rest: NDArray[np.float32], paper: NDArray[np.float32]) -> str | None:
    # 형광펜은 글자 높이의 일부만 칠하는 경우가 많아 칠한 픽셀의 비율로 봄
    if not len(rest):
        return None
    colored = rest[np.hypot(rest[:, 1] - paper[1], rest[:, 2] - paper[2]) > HIGHLIGHT]
    if len(colored) / len(rest) <= HIGHLIGHT_SHARE:
        return None
    c = np.median(colored, axis=0)
    return color_name(float(c[1]), float(c[2]), gray=HIGHLIGHT / 2)


def text_marks(text: str) -> list[Mark]:
    """글자로 찾는 강조: ★ · ※ · !! 와 '중요' · '시험에 나옴' 같은 낱말."""
    marks: list[Mark] = [
        {"kind": "symbol", "start": m.start(), "end": m.end(), "text": m.group()}
        for m in SYMBOLS.finditer(text)
    ]
    marks += [
        {"kind": "keyword", "start": m.start(), "end": m.end(), "text": m.group()}
        for m in KEYWORDS.finditer(text)
    ]
    return sorted(marks, key=lambda m: m["start"])


def marks_for_rows(rows: list[Row]) -> list[Mark]:
    """줄들을 \\n으로 이은 글 기준의 강조 구간."""
    found: list[Mark] = []
    offset = 0
    for r in rows:
        for w in r["words"]:
            start, end = offset + w["start"], offset + w["end"]
            if w.get("colorDiff"):
                found.append(
                    {
                        "kind": "color",
                        "start": start,
                        "end": end,
                        "color": w.get("color", ""),
                        "baseColor": w.get("baseColor", ""),
                    }
                )
            if hl := w.get("highlight"):
                found.append({"kind": "highlight", "start": start, "end": end, "color": hl})
        found += [
            {**m, "start": m["start"] + offset, "end": m["end"] + offset}
            for m in text_marks(r["text"])
        ]
        offset += len(r["text"]) + 1
    return merge_marks(found)


def merge_marks(marks: list[Mark], gap: int = 1) -> list[Mark]:
    """같은 종류 · 색의 색/형광펜 강조가 gap 글자 이하로 떨어져 있으면 하나로."""
    out: list[Mark] = []
    for m in sorted(marks, key=lambda x: (x["kind"], x.get("color", ""), x["start"])):
        prev = out[-1] if out else None
        if (
            prev is not None
            and m["kind"] in ("color", "highlight")
            and prev["kind"] == m["kind"]
            and prev.get("color") == m.get("color")
            and m["start"] - prev["end"] <= gap
        ):
            prev["end"] = max(prev["end"], m["end"])
        else:
            out.append({**m})
    return sorted(out, key=lambda x: (x["start"], x["kind"]))
