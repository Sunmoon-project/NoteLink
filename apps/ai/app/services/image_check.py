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

    handwritten_chars = 0
    for style in result.get("styles") or []:
        if not isinstance(style, Mapping) or style.get("isHandwritten") is not True:
            continue
        for span in style.get("spans") or []:
            if not isinstance(span, Mapping):
                continue
            offset = span.get("offset")
            length = span.get("length")
            if isinstance(offset, int) and isinstance(length, int) and length > 0:
                handwritten_chars += length

    confidence_total = 0.0
    confidence_count = 0
    for page in result.get("pages") or []:
        if not isinstance(page, Mapping):
            continue
        for word in page.get("words") or []:
            if not isinstance(word, Mapping):
                continue
            confidence = word.get("confidence")
            if isinstance(confidence, (int, float)) and 0 <= confidence <= 1:
                confidence_total += float(confidence)
                confidence_count += 1

    if confidence_count and confidence_total / confidence_count < MIN_OCR_CONFIDENCE:
        return "blurry"

    if handwritten_chars >= MIN_HANDWRITTEN_CHARS:
        return "ok"
    return "not_handwriting"
