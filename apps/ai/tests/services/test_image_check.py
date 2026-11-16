from typing import Any

import pytest

from app.services.image_check import (
    MIN_HANDWRITTEN_CHARS,
    MIN_OCR_CONFIDENCE,
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


def test_returns_not_handwriting_for_printed_or_empty_content() -> None:
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
