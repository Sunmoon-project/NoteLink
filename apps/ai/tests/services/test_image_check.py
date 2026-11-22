from typing import Any

import pytest

from app.services.image_check import (
    MIN_HANDWRITTEN_CHARS,
    MIN_LINE_CHARS,
    MIN_OCR_CONFIDENCE,
    MIN_READABLE_CHARS,
    MIN_READABLE_LINES,
    verdict_from_read,
)


def read_result(
    *,
    handwritten_lengths: list[int] | None = None,
    confidences: list[Any] | None = None,
    content: str = "text",
) -> dict[str, Any]:
    """필기 글자 수(span 길이)와 단어 신뢰도만 바꿔 가며 경계값을 보기 위한 OCR 결과."""
    spans = [{"offset": 0, "length": n} for n in handwritten_lengths or []]
    return {
        "content": content,
        "styles": [{"isHandwritten": True, "spans": spans}],
        "pages": [{"words": [{"confidence": c} for c in confidences or []]}],
    }


def test_returns_ok_for_a_handwritten_span_with_readable_text() -> None:
    result = {
        "content": "abc",
        "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": 3}]}],
        "pages": [{"words": [{"confidence": 0.9}, {"confidence": 0.8}]}],
    }

    assert verdict_from_read(result) == "ok"


def test_returns_blurry_when_average_ocr_confidence_is_below_threshold() -> None:
    result = {
        "content": "abc",
        "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": 3}]}],
        "pages": [{"words": [{"confidence": 0.3}, {"confidence": 0.4}]}],
    }

    assert verdict_from_read(result) == "blurry"


def test_returns_not_handwriting_for_short_or_empty_content() -> None:
    assert verdict_from_read({"content": "printed text", "styles": []}) == "not_handwriting"
    assert verdict_from_read({"content": "  ", "styles": []}) == "not_handwriting"


def test_ignores_incomplete_ocr_metadata_instead_of_counting_it() -> None:
    result = {
        "content": "abc",
        "styles": [
            {"isHandwritten": True, "spans": [{"offset": None, "length": 3}, {"length": 4}]}
        ],
        "pages": [{"words": [{"confidence": None}, {"confidence": "0.99"}]}],
    }

    assert verdict_from_read(result) == "not_handwriting"


def test_handwritten_char_threshold_is_inclusive() -> None:
    at = read_result(handwritten_lengths=[MIN_HANDWRITTEN_CHARS], confidences=[0.9])
    below = read_result(handwritten_lengths=[MIN_HANDWRITTEN_CHARS - 1], confidences=[0.9])

    assert verdict_from_read(at) == "ok"
    assert verdict_from_read(below) == "not_handwriting"


def test_handwritten_chars_are_summed_across_spans_and_styles() -> None:
    across_spans = read_result(handwritten_lengths=[1, 2], confidences=[0.9])
    across_styles = {
        "content": "text",
        "styles": [
            {"isHandwritten": True, "spans": [{"offset": 0, "length": 1}]},
            {"isHandwritten": True, "spans": [{"offset": 5, "length": 2}]},
        ],
        "pages": [{"words": [{"confidence": 0.9}]}],
    }

    assert verdict_from_read(across_spans) == "ok"
    assert verdict_from_read(across_styles) == "ok"


def test_only_handwritten_styles_with_positive_span_length_are_counted() -> None:
    printed_style = {
        "content": "text",
        "styles": [{"isHandwritten": False, "spans": [{"offset": 0, "length": 10}]}],
        "pages": [{"words": [{"confidence": 0.9}]}],
    }
    truthy_but_not_true = {
        "content": "text",
        "styles": [{"isHandwritten": 1, "spans": [{"offset": 0, "length": 10}]}],
        "pages": [{"words": [{"confidence": 0.9}]}],
    }

    assert verdict_from_read(printed_style) == "not_handwriting"
    assert verdict_from_read(truthy_but_not_true) == "not_handwriting"
    assert verdict_from_read(read_result(handwritten_lengths=[0, -5], confidences=[0.9])) == (
        "not_handwriting"
    )
    assert verdict_from_read(read_result(handwritten_lengths=[0, 3], confidences=[0.9])) == "ok"


def test_average_confidence_threshold_is_exclusive() -> None:
    at = read_result(handwritten_lengths=[3], confidences=[MIN_OCR_CONFIDENCE])
    just_below = read_result(handwritten_lengths=[3], confidences=[MIN_OCR_CONFIDENCE - 0.001])

    assert verdict_from_read(at) == "ok"
    assert verdict_from_read(just_below) == "blurry"


def test_confidence_is_averaged_over_all_words_and_pages() -> None:
    # 평균 (0.9 + 0.1) / 2 = 0.5 → 통과. 첫 단어만 보면 통과, 마지막 단어만 보면 흐림이다.
    across_words = read_result(handwritten_lengths=[3], confidences=[0.9, 0.1])
    across_pages = {
        **across_words,
        "pages": [{"words": [{"confidence": 0.9}]}, {"words": [{"confidence": 0.1}]}],
    }
    # 평균 (0.9 + 0.1 + 0.1) / 3 ≈ 0.367 → 흐림
    lower = read_result(handwritten_lengths=[3], confidences=[0.9, 0.1, 0.1])

    assert verdict_from_read(across_words) == "ok"
    assert verdict_from_read(across_pages) == "ok"
    assert verdict_from_read(lower) == "blurry"


@pytest.mark.parametrize("confidence", [0, 0.0])
def test_zero_confidence_counts_as_a_valid_reading(confidence: float) -> None:
    assert verdict_from_read(read_result(handwritten_lengths=[3], confidences=[confidence])) == (
        "blurry"
    )


@pytest.mark.parametrize("confidence", [-0.1, 1.1, 2, None, "0.1", [0.1]])
def test_out_of_range_or_non_numeric_confidence_is_ignored(confidence: Any) -> None:
    ignored_only = read_result(handwritten_lengths=[3], confidences=[confidence])
    # 유효한 값(0.2)만 평균에 들어가므로 흐림으로 판정된다
    mixed = read_result(handwritten_lengths=[3], confidences=[confidence, 0.2])

    assert verdict_from_read(ignored_only) == "ok"  # 신뢰도 정보가 없으면 흐림으로 보지 않는다
    assert verdict_from_read(mixed) == "blurry"


def test_blurry_takes_precedence_over_the_handwriting_check() -> None:
    # 필기 글자가 없어도 신뢰도가 낮으면 not_handwriting이 아니라 blurry다
    assert verdict_from_read(read_result(handwritten_lengths=[], confidences=[0.1])) == "blurry"


def test_missing_or_non_string_content_is_not_handwriting() -> None:
    assert verdict_from_read({}) == "not_handwriting"
    assert verdict_from_read({"content": None}) == "not_handwriting"
    assert verdict_from_read({"content": 123, "styles": []}) == "not_handwriting"
    # 내용이 없으면 신뢰도가 낮아도 blurry보다 먼저 not_handwriting으로 판정한다
    empty = read_result(handwritten_lengths=[3], confidences=[0.1], content="")
    assert verdict_from_read(empty) == "not_handwriting"


def test_malformed_styles_pages_and_words_are_skipped() -> None:
    result = {
        "content": "abc",
        "styles": ["x", None, {"isHandwritten": True, "spans": ["y", {"offset": 0, "length": 3}]}],
        "pages": ["p", None, {"words": ["w", None, {"confidence": 0.9}]}],
    }

    assert verdict_from_read(result) == "ok"
    assert verdict_from_read({"content": "abc", "styles": None, "pages": None}) == (
        "not_handwriting"
    )


# ---------- 손글씨 표시 없이 글자가 충분히 읽힌 사진(NOTE-006, #651) ----------


def text_result(lines: list[Any], *, confidence: float = 0.9) -> dict[str, Any]:
    """손글씨 표시(styles)가 하나도 없는 Read 결과. content는 줄을 줄바꿈으로 이은 것."""
    return {
        "content": "\n".join(ln["content"] for ln in lines),
        "styles": [],
        "pages": [{"lines": lines, "words": [{"confidence": confidence}]}],
    }


def lines_of(*texts: str) -> list[dict[str, Any]]:
    return [{"content": t} for t in texts]


def test_korean_handwriting_without_a_handwriting_style_is_ok() -> None:
    # 한글 손글씨에는 Azure Read가 isHandwritten 표시를 잘 붙이지 않는다. 글자가 읽히면 통과
    result = text_result(
        lines_of("광합성의 명반응은 틸라코이드에서", "암반응(캘빈 회로)은 스트로마")
    )

    assert verdict_from_read(result) == "ok"


def test_printed_textbook_page_is_ok() -> None:
    # 인쇄물 · 교재 사진도 받는다(완우 결정 11/22)
    result = text_result(
        lines_of("제2장 세포의 구조", "세포막은 인지질 이중층으로 되어 있다.", "핵은 DNA를 담는다.")
    )

    assert verdict_from_read(result) == "ok"


def test_readable_text_thresholds_are_inclusive() -> None:
    per_line = -(
        -MIN_READABLE_CHARS // MIN_READABLE_LINES
    )  # 올림: 줄마다 이만큼이면 합이 기준 이상
    at = text_result(lines_of(*["가" * per_line] * MIN_READABLE_LINES))
    fewer_lines = text_result(lines_of(*["가" * MIN_READABLE_CHARS * 2] * (MIN_READABLE_LINES - 1)))
    # 줄 수는 채우고 글자 수만 하나 모자란다(두 줄로 나눠 MIN_READABLE_CHARS - 1자)
    short = MIN_READABLE_CHARS - 1
    assert short // 2 >= MIN_LINE_CHARS and MIN_READABLE_LINES == 2
    fewer_chars = text_result(lines_of("가" * (short - short // 2), "나" * (short // 2)))

    assert verdict_from_read(at) == "ok"
    assert verdict_from_read(fewer_lines) == "not_handwriting"
    assert verdict_from_read(fewer_chars) == "not_handwriting"


def test_whitespace_and_symbols_are_not_counted_as_readable_chars() -> None:
    # 공백까지 세면 기준을 넘지만, 공백을 빼면 MIN_READABLE_CHARS - 1자다
    half = (MIN_READABLE_CHARS - 1) // 2
    first = " ".join("가" * half)
    second = " ".join("나" * (MIN_READABLE_CHARS - 1 - half))
    result = text_result(lines_of(first, second))
    result["content"] = f"{first}\n   \t  \n{second}"
    assert len(result["content"]) >= MIN_READABLE_CHARS

    assert verdict_from_read(result) == "not_handwriting"
    # 구분선 · 화살표 같은 기호만 많은 사진(자 · 양식 테두리)
    ruler = text_result(lines_of("-" * 30, "0 1 2 3 4 5 →"))
    assert verdict_from_read(ruler) == "not_handwriting"


def test_landscape_or_sign_photo_with_a_little_text_is_not_handwriting() -> None:
    # 풍경 · 간판 사진: 짧은 글자 한두 줄만 읽힌다
    assert verdict_from_read(text_result(lines_of("STOP"))) == "not_handwriting"
    assert verdict_from_read(text_result(lines_of("김밥천국", "24시"))) == "not_handwriting"
    # 한 줄에 글자가 많아도(현수막 한 줄) 줄 수가 모자라면 필기 자료로 보지 않는다
    banner = text_result(lines_of("선문대학교 개교 기념 축제 행사장 안내 정문 앞 광장"))
    assert verdict_from_read(banner) == "not_handwriting"
    # 현수막 옆 잡티(「1」 · 「.」)가 한 줄로 읽혀도 줄로 세지 않는다
    stray = text_result(lines_of("선문대학교 개교 기념 축제 행사장 안내 정문 앞 광장", "1", "."))
    assert verdict_from_read(stray) == "not_handwriting"


def test_a_line_needs_min_line_chars_to_count() -> None:
    text = "가" * MIN_READABLE_CHARS
    at = text_result(lines_of(text, "나" * MIN_LINE_CHARS))
    below = text_result(lines_of(text, "나" * (MIN_LINE_CHARS - 1)))

    assert verdict_from_read(at) == "ok"
    assert verdict_from_read(below) == "not_handwriting"


def test_blank_photo_is_not_handwriting() -> None:
    blank = {"content": "", "styles": [], "pages": [{"lines": [], "words": []}]}

    assert verdict_from_read(blank) == "not_handwriting"


def test_lines_are_counted_across_pages_and_blank_or_malformed_lines_are_skipped() -> None:
    text = "가" * MIN_READABLE_CHARS
    across_pages = {
        "content": f"{text}\n나다",
        "styles": [],
        "pages": [{"lines": [{"content": text}]}, {"lines": [{"content": "나다"}]}],
    }
    padded = {
        "content": text,
        "styles": [],
        "pages": [
            {"lines": [{"content": text}, {"content": "  "}, {"content": None}, "x", None]},
            "p",
            None,
            {"lines": None},
        ],
    }

    assert verdict_from_read(across_pages) == "ok"
    assert verdict_from_read(padded) == "not_handwriting"  # 글자 있는 줄이 1줄뿐


def test_blurry_still_takes_precedence_over_readable_text() -> None:
    result = text_result(
        lines_of("광합성의 명반응은 틸라코이드에서", "암반응은 스트로마"), confidence=0.1
    )

    assert verdict_from_read(result) == "blurry"
