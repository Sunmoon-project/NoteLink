from typing import Any

import numpy as np

from app.services.note.handoff import line_results, page_texts
from app.services.note.models import PageLayout
from app.services.note.pipeline import NotePage, note_chunks, note_result, page_lines
from tests.services.note.helpers import row, word


def layout(page: int, *texts: str, two: bool = False) -> PageLayout:
    return {"pageNo": page, "twoColumn": two, "rows": [row(t, page=page) for t in texts]}


def test_page_texts_join_rows_in_reading_order() -> None:
    out = page_texts([layout(1, "1. 제목", "내용"), layout(3)])
    assert out == [{"pageNo": 1, "ocrText": "1. 제목\n내용"}, {"pageNo": 3, "ocrText": ""}]


def test_line_results_shape_for_exam_import() -> None:
    r = row(
        "1 선극",
        words=[
            word("1", 0, confidence=0.99),
            word("선", 2, confidence=0.4),
            word("극", 3, confidence=0.6),
        ],
    )
    (page,) = line_results([{"pageNo": 2, "twoColumn": True, "rows": [r]}])
    assert page["pageNo"] == 2 and page["twoColumn"]
    assert page["marks"] == [] and page["marksChecked"] is False  # '표시 없음'이 아니라 '찾지 않음'
    (ln,) = page["lines"]
    assert set(ln) == {"text", "x0", "x1", "y", "handwritten", "conf"}
    assert ln["y"] == 0.11 and ln["conf"] == 0.5  # '선극' 평균 0.5 (음절 최솟값 0.4가 아님)


def read(*lines: tuple[str, float]) -> dict[str, Any]:
    """줄마다 (글, 신뢰도). 글자 하나가 단어 하나인 작은 Read 결과."""
    content = "\n".join(t for t, _ in lines)
    page_lines, words = [], []
    off = 0
    for i, (text, conf) in enumerate(lines):
        y = 10 + i * 5
        page_lines.append(
            {
                "content": text,
                "polygon": [5, y, 60, y, 60, y + 2, 5, y + 2],
                "spans": [{"offset": off, "length": len(text)}],
            }
        )
        for j, ch in enumerate(text):
            if ch != " ":
                words.append(
                    {
                        "content": ch,
                        "polygon": [5, y, 6, y, 6, y + 2, 5, y + 2],
                        "confidence": conf,
                        "span": {"offset": off + j, "length": 1},
                    }
                )
        off += len(text) + 1
    return {
        "content": content,
        "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": len(content)}]}],
        "pages": [
            {"pageNumber": 1, "width": 100, "height": 100, "lines": page_lines, "words": words}
        ],
    }


def test_note_result_uses_upload_page_numbers_not_ocr_page_numbers() -> None:
    pages: list[NotePage] = [
        {"pageNo": 3, "read": read(("2. 대장 아메바", 0.9), ("- 포낭형 : 8핵성", 0.9))},
        {"pageNo": 1, "read": read(("1. 이질 아메바", 0.9), ("- 영양형 ★", 0.9))},
        {"pageNo": 2, "read": {}},  # 빈 쪽: 번호는 남기고 당기지 않음
    ]
    res = note_result(pages)
    assert [p["pageNo"] for p in res["pages"]] == [1, 2, 3]  # OCR pageNumber는 모두 1
    assert res["pages"][0]["ocrText"] == "1. 이질 아메바\n- 영양형 ★"
    assert res["pages"][1]["ocrText"] == ""
    assert [c["title"] for c in res["chunks"]] == ["1. 이질 아메바", "2. 대장 아메바"]
    assert res["chunks"][1]["lines"][0]["pageNo"] == 3
    assert [p["pageNo"] for p in res["lineResults"]] == [1, 2, 3]
    assert res["lineResults"][1]["lines"] == []


def test_blurry_words_get_marks_in_every_output() -> None:
    res = note_result([{"pageNo": 1, "read": read(("1. 로로드아메바", 0.3), ("포낭형 ★", 0.95))}])
    assert res["pages"][0]["ocrText"] == "1. [?]로로드아메바\n포낭형 ★"
    first = res["lineResults"][0]["lines"][0]
    assert first["text"] == "1. [?]로로드아메바" and first["conf"] == 0.3
    (c,) = res["chunks"]
    assert c["uncertainCount"] == 1
    (m,) = c["emphasis"]["marks"]
    assert c["text"][m["start"] : m["end"]] == "★"  # [?]를 넣은 뒤의 위치


def test_note_chunks_takes_a_page_number() -> None:
    (c,) = note_chunks(read(("1. 이질 아메바", 0.9), ("내용", 0.9)), page_no=7)
    assert c["lines"][0]["pageNo"] == 7


def two_page_pdf(first: str, second: str) -> dict[str, Any]:
    """쪽 2개짜리 PDF의 Read 결과 (OCR pageNumber 1 · 2)."""
    a, b = read((first, 0.9)), read((second, 0.9))
    shift = len(a["content"]) + 1
    for ln in b["pages"][0]["lines"]:
        ln["spans"][0]["offset"] += shift
    for w in b["pages"][0]["words"]:
        w["span"]["offset"] += shift
    b["pages"][0]["pageNumber"] = 2
    content = f"{a['content']}\n{b['content']}"
    return {
        "content": content,
        "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": len(content)}]}],
        "pages": a["pages"] + b["pages"],
    }


def test_multi_page_pdf_keeps_every_page_and_pushes_next_upload() -> None:
    pages: list[NotePage] = [
        {"pageNo": 1, "read": two_page_pdf("1. 첫 쪽", "2. 둘째 쪽")},
        {"pageNo": 2, "read": read(("3. 사진 쪽", 0.9))},
        {"pageNo": 3, "read": {}},
    ]
    res = note_result(pages)
    # 고치기 전에는 PDF 둘째 쪽이 빠지고 사진이 2쪽이 됨
    assert [p["ocrText"] for p in res["pages"]] == ["1. 첫 쪽", "2. 둘째 쪽", "3. 사진 쪽", ""]
    assert [p["pageNo"] for p in res["pages"]] == [1, 2, 3, 4]
    assert [p["pageNo"] for p in res["lineResults"]] == [1, 2, 3, 4]
    assert [c["lines"][0]["pageNo"] for c in res["chunks"]] == [1, 2, 3]


def test_gap_in_upload_numbers_is_kept() -> None:
    res = note_result([{"pageNo": 1, "read": read(("내용", 0.9))}, {"pageNo": 3, "read": {}}])
    assert [p["pageNo"] for p in res["pages"]] == [1, 3]


def test_photo_colors_are_not_applied_to_a_multi_page_pdf() -> None:
    # 사진 한 장은 한 쪽에만 맞으므로, 여러 쪽 OCR 결과에는 색 · 형광펜을 찾지 않음
    image = np.full((100, 100, 3), 255, np.uint8)
    image[:, 5:7] = 20  # 단어 상자마다 검은 획
    lines = page_lines(
        {"pageNo": 1, "read": two_page_pdf("1. 첫 쪽", "2. 둘째 쪽"), "image": image}
    )
    assert all("color" not in w for ln in lines for w in ln["words"])


def test_small_line_starting_with_a_printed_number_stays_in_the_result() -> None:
    res_read = read(*[(f"손글씨 {i}", 0.9) for i in range(4)], ("1. 메모", 0.9))
    last = res_read["pages"][0]["lines"][-1]
    off, y = last["spans"][0]["offset"], last["polygon"][1]
    last["polygon"] = [5, y, 60, y, 60, y + 1, 5, y + 1]  # 다른 줄의 절반 높이
    # '1.'만 인쇄, '메모'는 손글씨 → 줄은 인쇄로 시작
    res_read["styles"] = [
        {
            "isHandwritten": True,
            "spans": [{"offset": 0, "length": off}, {"offset": off + 3, "length": 2}],
        }
    ]
    res = note_result([{"pageNo": 1, "read": res_read}])
    assert res["pages"][0]["ocrText"].endswith("\n1. 메모")
