"""읽는 순서의 줄을 문단(개념) 조각으로 나누기.

번호 제목(1.)에서 끊고, 큰 제목(I.)은 상위 경로(path)로 붙임. 너무 긴 문단은 안의 작은 제목
((1) · ①)에서 다시 나누고, 나눌 제목이 없으면 needsLlm으로 표시(pipeline.split_with_llm).
"""

import re
from dataclasses import dataclass, field

from app.services.note.emphasis import marks_for_rows
from app.services.note.models import Chunk, PageRef, Row

# (단계, 패턴). 글머리표(- · •)는 본문. "I am …" · "1.5 mL"은 제목이 아님.
HEADINGS: list[tuple[int, re.Pattern[str]]] = [
    (1, re.compile(r"^\s*(?:[IVX]{1,4}\s*[.)]|[Ⅰ-Ⅻ]\s*[.)]?)\s*\S")),
    (2, re.compile(r"^\s*\d{1,2}\s*\.(?!\d)\s*\S")),
    (3, re.compile(r"^\s*(?:\d{1,2}\)|\(\d{1,2}\))\s*\S")),
    (4, re.compile(r"^\s*[①-⑳]\s*\S")),
    (4, re.compile(r"^\s*[가-하]\s*[.)]\s*\S")),
]
SPLIT_LEVEL = 2
MIN_CHARS = 50  # 제목 없는 앞부분이 이보다 짧으면 다음 문단에 붙임
MAX_CHARS = 500  # 이보다 긴 문단은 다시 나눔


def heading_level(text: str) -> int | None:
    """제목이면 단계(1이 가장 큼), 아니면 None."""
    for level, pattern in HEADINGS:
        if pattern.match(text):
            return level
    return None


@dataclass
class _Part:
    title: str | None
    path: list[str]
    level: int | None
    rows: list[Row] = field(default_factory=list)

    @property
    def chars(self) -> int:
        return sum(len(r["text"]) for r in self.rows)


def split_rows(
    rows: list[Row],
    *,
    split_level: int = SPLIT_LEVEL,
    min_chars: int = MIN_CHARS,
    max_chars: int = MAX_CHARS,
) -> list[Chunk]:
    """줄 → 문단 조각. 제목이 있는 문단은 짧아도 합치지 않음(개념 단위)."""
    parts: list[_Part] = []
    path: list[str] = []
    for r in rows:
        level = heading_level(r["text"])
        if level is not None and level < split_level:
            path = [r["text"]]
            continue
        if level == split_level or not parts or parts[-1].path != path:
            starts = level == split_level
            parts.append(_Part(r["text"] if starts else None, path, level if starts else None))
        parts[-1].rows.append(r)

    parts = [p for part in parts for p in _split_long(part, max_chars)]
    # 짧은 서두는 같은 큰 제목 아래 다음 문단에만 붙임 (다른 제목 문맥으로 임베딩되지 않게)
    if (
        len(parts) > 1
        and parts[0].title is None
        and parts[0].chars < min_chars
        and parts[0].path == parts[1].path
    ):
        parts[1].rows[:0] = parts[0].rows
        parts.pop(0)
    return [_chunk(i, p, max_chars) for i, p in enumerate(parts, 1)]


def _split_long(part: _Part, max_chars: int) -> list[_Part]:
    if part.chars <= max_chars:
        return [part]
    floor = part.level or SPLIT_LEVEL
    inner = [
        lv for r in part.rows[1:] if (lv := heading_level(r["text"])) is not None and lv > floor
    ]
    if not inner:
        return [part]
    cut = min(inner)
    path = part.path + ([part.title] if part.title else [])
    out = [_Part(part.title, part.path, part.level)]
    for i, r in enumerate(part.rows):
        if i > 0 and heading_level(r["text"]) == cut:
            out.append(_Part(r["text"], path, cut))
        out[-1].rows.append(r)
    return [p for q in out if q.rows for p in _split_long(q, max_chars)]


def _chunk(order: int, part: _Part, max_chars: int) -> Chunk:
    text = "\n".join(r["text"] for r in part.rows)
    marks = marks_for_rows(part.rows)
    return {
        "order": order,
        "title": part.title,
        "path": part.path,
        "text": text,
        "lines": [{"pageNo": r["page"], "lineIds": r["lineIds"]} for r in part.rows],
        "emphasis": {"has": bool(marks), "marks": marks},
        "uncertainCount": text.count("[?]"),
        "needsLlm": part.chars > max_chars,
    }


def pages_of(chunk: Chunk) -> list[PageRef]:
    """조각이 걸친 쪽과 OCR 줄 번호."""
    out: dict[int, list[int]] = {}
    for ref in chunk["lines"]:
        out.setdefault(ref["pageNo"], []).extend(ref["lineIds"])
    return [{"pageNo": p, "lineIds": sorted(ids)} for p, ids in sorted(out.items())]
