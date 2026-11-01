"""노트 시험에서 줄 · 단어를 짧게 만드는 도우미."""

from app.services.note.models import Line, Row, Word


def word(
    text: str, start: int, box: tuple[int, int, int, int] = (0, 0, 10, 10), **extra: object
) -> Word:
    x0, y0, x1, y1 = box
    w: Word = {
        "text": text,
        "start": start,
        "end": start + len(text),
        "polygon": [float(v) for v in (x0, y0, x1, y0, x1, y1, x0, y1)],
        "confidence": 0.99,
    }
    w.update(extra)  # type: ignore[typeddict-item]
    return w


def line(
    text: str,
    x0: float,
    x1: float,
    y0: float,
    *,
    lid: int = 1,
    page: int = 1,
    height: float = 0.02,
    hand: bool = True,
    words: list[Word] | None = None,
) -> Line:
    return {
        "id": lid,
        "page": page,
        "text": text,
        "x0": x0,
        "x1": x1,
        "y0": y0,
        "y1": y0 + height,
        "hand": hand,
        "words": words or [],
    }


def row(text: str, *, page: int = 1, lid: int = 1, words: list[Word] | None = None) -> Row:
    return {
        "page": page,
        "lineIds": [lid],
        "text": text,
        "x0": 0.05,
        "x1": 0.5,
        "y0": 0.1,
        "y1": 0.12,
        "hand": True,
        "words": words or [],
    }


def rows(*texts: str) -> list[Row]:
    return [row(t, lid=i) for i, t in enumerate(texts, 1)]
