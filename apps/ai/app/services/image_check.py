"""선택한 이미지가 필기 자료로 읽힐 수 있는지 미리 확인합니다."""

from collections.abc import Mapping
from typing import Any, Literal

type ImageVerdict = Literal["ok", "not_allowed", "not_handwriting", "blurry"]

MIN_HANDWRITTEN_CHARS = 3
MIN_OCR_CONFIDENCE = 0.45


def verdict_from_read(result: Mapping[str, Any]) -> ImageVerdict:
    """Document Intelligence Read 결과를 앱이 표시하는 판정으로 바꿉니다."""
    content = result.get("content")
    if not isinstance(content, str) or not content.strip():
        return "not_handwriting"

    handwritten_spans = [
        (span.get("offset"), span.get("length"))
        for style in result.get("styles") or []
        if isinstance(style, Mapping) and style.get("isHandwritten") is True
        for span in style.get("spans") or []
        if isinstance(span, Mapping)
        and isinstance(span.get("offset"), int)
        and isinstance(span.get("length"), int)
        and span["length"] > 0
    ]
    handwritten_chars = sum(length for _, length in handwritten_spans)

    confidences = [
        word.get("confidence")
        for page in result.get("pages") or []
        if isinstance(page, Mapping)
        for word in page.get("words") or []
        if isinstance(word, Mapping)
        and isinstance(word.get("confidence"), (int, float))
        and 0 <= word["confidence"] <= 1
    ]
    if confidences and sum(confidences) / len(confidences) < MIN_OCR_CONFIDENCE:
        return "blurry"

    if handwritten_chars >= MIN_HANDWRITTEN_CHARS:
        return "ok"
    return "not_handwriting"
