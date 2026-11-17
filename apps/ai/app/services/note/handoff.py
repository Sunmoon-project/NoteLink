"""퀴즈 쪽에 넘기는 결과: ① 쪽별 원본 글자, ② 쪽별 OCR 줄 결과(기출 등록용)."""

from app.services.note.models import OcrLine, PageLayout, PageLines, PageText, Row
from app.services.note.uncertain import lowest_token_confidence


def page_texts(layouts: list[PageLayout]) -> list[PageText]:
    """① 쪽마다 읽는 순서의 줄을 \\n으로 이은 글. 글이 없는 쪽도 남김."""
    return [
        {"pageNo": p["pageNo"], "ocrText": "\n".join(r["text"] for r in p["rows"])} for p in layouts
    ]


def line_results(layouts: list[PageLayout]) -> list[PageLines]:
    """② 쪽마다 OCR 줄 결과. ✓ · 동그라미는 아직 찾지 않음(marksChecked=False)."""
    return [
        {
            "pageNo": p["pageNo"],
            "twoColumn": p["twoColumn"],
            "lines": [_ocr_line(r) for r in p["rows"]],
            "marks": [],
            "marksChecked": False,
        }
        for p in layouts
    ]


def _ocr_line(r: Row) -> OcrLine:
    return {
        "text": r["text"],
        "x0": round(r["x0"], 4),
        "x1": round(r["x1"], 4),
        "y": round((r["y0"] + r["y1"]) / 2, 4),
        "handwritten": r["hand"],
        "conf": round(lowest_token_confidence(r), 3),
    }
