"""선택한 이미지가 필기 자료로 읽힐 수 있는지 미리 확인합니다."""

from collections.abc import Mapping
from typing import Any, Literal

type ImageVerdict = Literal["ok", "not_allowed", "not_handwriting", "blurry"]

MIN_HANDWRITTEN_CHARS = 3
MIN_OCR_CONFIDENCE = 0.45
# 손글씨 표시(isHandwritten)가 없어도 글자가 이만큼 읽히면 학습 자료로 받는다
# (인쇄물 · 교재 포함, #651). 한글 손글씨에는 Read가 손글씨 표시를 잘 붙이지 않아,
# 표시만 보면 필기 사진도 거절됐다(NOTE-006).
# 기준은 「글자 · 숫자 20자 이상 · 두 줄 이상」: 필기 · 교재 한 줄은 보통 10자를 넘어 두 줄이면
# 20자 안팎이고, 풍경 · 간판 사진에서 읽히는 글자(간판 이름 한두 줄, 현수막 한 줄)는 걸러진다.
# 공백 · 기호(구분선 ----, 화살표)는 세지 않고, 글자 · 숫자가 MIN_LINE_CHARS자 미만인 줄
# (현수막 옆에 읽힌 「1」 같은 잡티)은 줄로 세지 않는다.
# 노트 쪼개기 최소 문단(chunking.MIN_CHARS = 50)보다 낮게 둔 것은, 한 노트가 여러 장이라
# 공식 · 그림 위주로 글자가 적은 장도 막지 않기 위해서다.
MIN_READABLE_CHARS = 20
MIN_READABLE_LINES = 2
MIN_LINE_CHARS = 2


def _handwritten_chars(result: Mapping[str, Any]) -> int:
    total = 0
    for style in result.get("styles") or []:
        if not isinstance(style, Mapping) or style.get("isHandwritten") is not True:
            continue
        for span in style.get("spans") or []:
            if not isinstance(span, Mapping):
                continue
            offset = span.get("offset")
            length = span.get("length")
            if isinstance(offset, int) and isinstance(length, int) and length > 0:
                total += length
    return total


def _pages(result: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [page for page in result.get("pages") or [] if isinstance(page, Mapping)]


def _readable_chars(text: str) -> int:
    """글자 · 숫자 수. 공백 · 문장부호 · 기호는 세지 않는다(한글 음절은 글자다)."""
    return sum(1 for ch in text if ch.isalnum())


def _readable_lines(result: Mapping[str, Any]) -> int:
    """글자 · 숫자가 MIN_LINE_CHARS자 이상인 줄 수(모든 쪽). 형식이 깨진 줄은 세지 않는다."""
    return sum(
        1
        for page in _pages(result)
        for line in page.get("lines") or []
        if isinstance(line, Mapping)
        and isinstance(line.get("content"), str)
        and _readable_chars(line["content"]) >= MIN_LINE_CHARS
    )


def _is_blurry(result: Mapping[str, Any]) -> bool:
    confidence_total = 0.0
    confidence_count = 0
    for page in _pages(result):
        for word in page.get("words") or []:
            if not isinstance(word, Mapping):
                continue
            confidence = word.get("confidence")
            if isinstance(confidence, (int, float)) and 0 <= confidence <= 1:
                confidence_total += float(confidence)
                confidence_count += 1
    return bool(confidence_count) and confidence_total / confidence_count < MIN_OCR_CONFIDENCE


def verdict_from_read(result: Mapping[str, Any]) -> ImageVerdict:
    """Document Intelligence Read 결과를 앱이 표시하는 판정으로 바꿉니다."""
    content = result.get("content")
    if not isinstance(content, str) or not content.strip():
        return "not_handwriting"

    if _is_blurry(result):
        return "blurry"

    if _handwritten_chars(result) >= MIN_HANDWRITTEN_CHARS:
        return "ok"
    if (
        _readable_chars(content) >= MIN_READABLE_CHARS
        and _readable_lines(result) >= MIN_READABLE_LINES
    ):
        return "ok"
    return "not_handwriting"
