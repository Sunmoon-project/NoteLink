from app.services.image_check import verdict_from_read


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
