"""흐린 낱말 앞에 [?] 붙이기 (예: "[?]항균게"). 글자는 고치지 않습니다.

한국어 OCR은 음절마다 신뢰도를 주므로 띄어쓰기 단위 낱말로 묶어 평균을 봅니다.
"""

import re
import statistics
from dataclasses import dataclass

from app.services.note.models import Line, Row, Word

MARK = "[?]"
UNCERTAIN_MEAN = 0.5  # 낱말 신뢰도 평균이 이보다 낮으면 [?] (시험 쪽 10장으로 정함)
_TOKEN = re.compile(r"\S+")
_EDGE = re.compile(r"^[^\w가-힣]+|[^\w가-힣]+$")
_LETTER = re.compile(r"[A-Za-z가-힣]")
_HEADING_MARK = re.compile(r"^(?:[IVXivx]{1,4}|[Ⅰ-Ⅻ]|\d{1,2}|[①-⑳])[.)]?$")


@dataclass(frozen=True)
class Token:
    """띄어쓰기로 나뉜 낱말과 그 안의 OCR 단어(음절)들."""

    start: int
    end: int
    text: str
    words: list[Word]

    @property
    def confidence(self) -> float:
        # OCR 단어가 없으면 판단할 근거가 없어 1.0
        return statistics.fmean(w["confidence"] for w in self.words) if self.words else 1.0


def tokens(line: Line | Row) -> list[Token]:
    out: list[Token] = []
    for m in _TOKEN.finditer(line["text"]):
        ws = [w for w in line["words"] if m.start() <= w["start"] < m.end()]
        out.append(Token(m.start(), m.end(), m.group(), ws))
    return out


def is_uncertain(
    tok: Token, threshold: float = UNCERTAIN_MEAN, known: frozenset[str] = frozenset()
) -> bool:
    """기호만 있는 낱말(!! · 20°) · 제목 번호(I. · 1.) · 용어 사전(known)에 있는 낱말은 제외."""
    if tok.confidence >= threshold:
        return False
    if not _LETTER.search(tok.text) or _HEADING_MARK.match(tok.text):
        return False
    return _EDGE.sub("", tok.text) not in known


def mark_uncertain(
    lines: list[Line], threshold: float = UNCERTAIN_MEAN, known: frozenset[str] = frozenset()
) -> list[Line]:
    """흐린 낱말 앞에 [?]를 넣은 새 줄 목록. 단어 위치도 함께 옮김."""
    return [_mark_line(ln, threshold, known) for ln in lines]


def _mark_line(line: Line, threshold: float, known: frozenset[str]) -> Line:
    starts = [t.start for t in tokens(line) if is_uncertain(t, threshold, known)]
    if not starts:
        return line
    text = line["text"]
    for s in reversed(starts):
        text = text[:s] + MARK + text[s:]

    def shift(pos: int) -> int:
        return pos + len(MARK) * sum(1 for s in starts if s <= pos)

    words: list[Word] = [
        {**w, "start": shift(w["start"]), "end": shift(w["start"]) + (w["end"] - w["start"])}
        for w in line["words"]
    ]
    return {**line, "text": text, "words": words}


def lowest_token_confidence(line: Line | Row) -> float:
    """줄 안 낱말 신뢰도 중 가장 낮은 값 (음절 단위가 아님)."""
    return min((t.confidence for t in tokens(line)), default=1.0)
