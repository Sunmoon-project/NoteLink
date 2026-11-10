import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import bson
import cv2
import mongomock
import numpy as np
import pytest

from app.clients.docint import DownloadError, OcrError, OcrSetupError, OcrUnavailableError
from app.clients.llm import JsonObject, LlmError
from app.clients.voyage import EmbedUnavailableError
from app.core.config import settings
from app.services.note import job as note_job
from app.services.note.job import (
    IMAGE_MAX_PIXELS,
    NOTE_MAX_PAGES,
    TYPE,
    InputError,
    Reader,
    run,
)
from app.services.quiz import generate
from app.worker import handlers
from app.worker.handlers import HANDLERS
from app.worker.jobs import JobGoneError, JobStore
from app.worker.runner import run_once
from tests.fakes import FakeLlm
from tests.services.recording.test_job import FakeVoyage

T0 = datetime(2026, 11, 10, 1, 0, tzinfo=UTC)
URL1 = "https://blob.example.test/notes/1.jpg?sig=secret-sas"
URL2 = "https://blob.example.test/notes/2.jpg?sig=secret-sas"
PDF_URL = "https://blob.example.test/notes/3.pdf?sig=secret-sas"
W, H = 400, 300
MONGO_DOC_LIMIT = 16 * 1024 * 1024

BLACK = (0, 0, 0)
RED = (0, 0, 255)  # OpenCV BGR

# ---------- 가짜 OCR 결과 · 사진 ----------


def box(i: int) -> tuple[int, int, int, int]:
    """i번째 줄(0부터)의 상자. 줄마다 40px 아래."""
    return 20, 20 + 40 * i, 300, 44 + 40 * i


def ocr_page(*texts: str, unit: str = "pixel", page_number: int = 1) -> JsonObject:
    """줄마다 단어 하나인 Read 결과의 쪽 하나."""
    lines, words = [], []
    offset = 0
    for i, text in enumerate(texts):
        x0, y0, x1, y1 = box(i)
        polygon = [x0, y0, x1, y0, x1, y1, x0, y1]
        lines.append(
            {
                "content": text,
                "polygon": polygon,
                "spans": [{"offset": offset, "length": len(text)}],
            }
        )
        words.append(
            {
                "content": text,
                "polygon": polygon,
                "span": {"offset": offset, "length": len(text)},
                "confidence": 0.99,
            }
        )
        offset += len(text) + 1
    return {
        "pageNumber": page_number,
        "width": W,
        "height": H,
        "unit": unit,
        "lines": lines,
        "words": words,
    }


def read(*pages: JsonObject) -> JsonObject:
    """손글씨로 표시한 Read 결과. 쪽마다 offset이 이어지게 다시 매김."""
    offset = 0
    out = []
    for p in pages:
        page = json.loads(json.dumps(p))
        for ln, w in zip(page["lines"], page["words"], strict=True):
            ln["spans"][0]["offset"] = offset
            w["span"]["offset"] = offset
            offset += ln["spans"][0]["length"] + 1
        out.append(page)
    return {
        "content": "",
        "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": offset}]}],
        "pages": out,
    }


def note_read(title: str = "1. 이질 아메바") -> JsonObject:
    return read(ocr_page(title, "- 영양형 위족", "포낭형"))


def image(*inks: tuple[int, int, int]) -> bytes:
    """흰 종이에 줄마다 inks 색 줄무늬(글씨 대신)를 그린 PNG."""
    img = np.full((H, W, 3), 255, np.uint8)
    for i, color in enumerate(inks):
        x0, y0, x1, y1 = box(i)
        for y in range(y0 + 4, y1 - 4, 3):
            cv2.line(img, (x0 + 4, y), (x1 - 4, y), color, 1)
    ok, data = cv2.imencode(".png", img)
    assert ok
    return data.tobytes()


class FakeOcr:
    def __init__(self, answers: dict[str, JsonObject | Exception] | None = None) -> None:
        self.answers = (
            answers
            if answers is not None
            else {URL1: note_read(), URL2: note_read("2. 대장 아메바")}
        )
        self.urls: list[str] = []

    def read(self, url: str) -> dict[str, Any]:
        self.urls.append(url)
        a = self.answers[url]
        if isinstance(a, Exception):
            raise a
        return a


class FakeFetch:
    def __init__(self, answers: dict[str, bytes | Exception] | None = None) -> None:
        self.answers = answers if answers is not None else {}
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        a = self.answers.get(url, image(BLACK, BLACK, BLACK))
        if isinstance(a, Exception):
            raise a
        return a


def two_pages() -> JsonObject:
    return {"pages": [{"pageNo": 2, "imageUrl": URL2}, {"pageNo": 1, "imageUrl": URL1}]}


def run_direct(
    inp: JsonObject,
    *,
    llm: Any = None,
    ocr: FakeOcr | None = None,
    fetch: FakeFetch | None = None,
    voyage: FakeVoyage | None = None,
    report: Callable[[int, str | None], None] | None = None,
) -> JsonObject:
    def on_report(value: int, step: str | None = None) -> None:
        if report is not None:
            report(value, step)

    def make_ocr() -> Reader:
        return ocr if ocr is not None else FakeOcr()

    return run(
        llm if llm is not None else FakeLlm(),
        make_ocr,
        voyage if voyage is not None else FakeVoyage(),
        inp,
        on_report,
        fetch=fetch if fetch is not None else FakeFetch(),
    )


# ---------- 작업 처리기를 거침 ----------


def queued_job(inp: object) -> Any:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    col.insert_one(
        {
            "_id": "j1",
            "type": TYPE,
            "status": "queued",
            "input": inp,
            "progress": 0,
            "attempts": 0,
            "result": None,
            "error": None,
            "createdAt": T0,
        }
    )
    return col


def attempt(
    monkeypatch: pytest.MonkeyPatch,
    col: Any,
    *,
    llm: Any = None,
    ocr: FakeOcr | None = None,
    fetch: FakeFetch | None = None,
    voyage: FakeVoyage | None = None,
) -> dict[str, Any]:
    """같은 문서로 시도를 하나 더 합니다. 시계는 다시 시도 대기를 넘긴 때로 둠."""
    the_fetch = fetch if fetch is not None else FakeFetch()
    monkeypatch.setattr(handlers, "_llm", lambda: llm if llm is not None else FakeLlm())
    monkeypatch.setattr(handlers, "_ocr", lambda: ocr if ocr is not None else FakeOcr())
    monkeypatch.setattr(handlers, "_voyage", lambda: voyage if voyage is not None else FakeVoyage())
    monkeypatch.setattr(handlers, "download", the_fetch)
    later = T0 + timedelta(hours=col.find_one({"_id": "j1"})["attempts"])
    store = JobStore(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: later)
    assert run_once(store, HANDLERS)
    doc: dict[str, Any] = col.find_one({"_id": "j1"})
    return doc


def run_job(monkeypatch: pytest.MonkeyPatch, inp: object, **fakes: Any) -> dict[str, Any]:
    return attempt(monkeypatch, queued_job(inp), **fakes)


# ---------- 등록 · 정상 흐름 ----------


def test_job_type_is_registered() -> None:
    assert TYPE == "handwriting_summary"
    assert HANDLERS[TYPE] is handlers.handwriting_summary


def test_two_pages_give_pages_lines_chunks_and_embeddings() -> None:
    ocr, fetch, voyage = FakeOcr(), FakeFetch(), FakeVoyage()

    result = run_direct(two_pages(), ocr=ocr, fetch=fetch, voyage=voyage)

    assert ocr.urls == [URL1, URL2]  # pageNo 순서
    assert fetch.urls == [URL1, URL2]
    assert result["pages"] == [
        {"pageNo": 1, "ocrText": "1. 이질 아메바\n- 영양형 위족\n포낭형"},
        {"pageNo": 2, "ocrText": "2. 대장 아메바\n- 영양형 위족\n포낭형"},
    ]
    assert [p["pageNo"] for p in result["lineResults"]] == [1, 2]
    assert [len(p["lines"]) for p in result["lineResults"]] == [3, 3]
    assert [c["title"] for c in result["chunks"]] == ["1. 이질 아메바", "2. 대장 아메바"]
    assert [c["order"] for c in result["chunks"]] == [1, 2]
    assert voyage.input_types == ["document"]
    assert [c["embedding"] for c in result["chunks"]] == [[0.5, 0.5], [1.5, 1.5]]
    assert result["warnings"] == []
    assert json.loads(json.dumps(result)) == result


def test_chunks_fit_the_quiz_material_input() -> None:
    result = json.loads(json.dumps(run_direct(two_pages())))

    parsed = generate.parse(
        {
            "day": "2026-11-10",
            "material": {
                "id": "m1",
                "title": "기생충",
                "pages": result["pages"],
                "chunks": result["chunks"],
            },
            "sets": [],
            "attempts": [],
            "notes": {},
        }
    )

    chunks = parsed.material.chunks
    assert [(c.order, c.title, c.page) for c in chunks] == [
        (1, "1. 이질 아메바", 1),
        (2, "2. 대장 아메바", 2),
    ]


def test_result_is_saved_through_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    doc = run_job(monkeypatch, two_pages())

    assert (doc["status"], doc["progress"], doc["error"]) == ("succeeded", 100, None)
    assert len(doc["result"]["chunks"]) == 2
    assert "checkpoint" not in doc


def test_progress_goes_through_steps_in_order_and_only_up() -> None:
    seen: list[tuple[int, str | None]] = []

    run_direct(two_pages(), report=lambda v, s: seen.append((v, s)))

    values = [v for v, _ in seen]
    assert values == sorted(values)
    assert seen[0] == (0, "ocr")
    assert (25, "ocr") in seen and (50, "ocr") in seen  # 쪽 하나 끝날 때마다
    assert [(50, "split"), (70, "refine"), (90, "embed"), (100, "embed")] == seen[-4:]


# ---------- 색 · 형광펜 사진 ----------


def test_photo_colors_become_emphasis() -> None:
    fetch = FakeFetch({URL1: image(BLACK, BLACK, RED)})

    result = run_direct({"pages": [{"pageNo": 1, "imageUrl": URL1}]}, fetch=fetch)

    (chunk,) = result["chunks"]
    marks = [m for m in chunk["emphasis"]["marks"] if m["kind"] == "color"]
    assert [chunk["text"][m["start"] : m["end"]] for m in marks] == ["포낭형"]
    assert marks[0]["color"] == "red"


def no_color(page_no: int, reason: str) -> dict[str, Any]:
    return {"code": "NO_COLOR", "pageNo": page_no, "reason": reason}


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        (DownloadError("ConnectError"), "download"),
        (DownloadError("파일이 너무 큼"), "download"),
        (b"not an image", "decode"),
        (b"", "decode"),
    ],
)
def test_photo_failure_skips_colors_and_warns(answer: bytes | Exception, reason: str) -> None:
    fetch = FakeFetch({URL1: answer})

    result = run_direct(two_pages(), fetch=fetch)

    assert len(result["chunks"]) == 2
    assert result["warnings"] == [no_color(1, reason)]
    assert "secret-sas" not in json.dumps(result["warnings"])


def test_photo_of_another_size_is_not_used() -> None:
    other = cv2.imencode(".png", np.full((H + 10, W, 3), 255, np.uint8))[1].tobytes()

    result = run_direct(two_pages(), fetch=FakeFetch({URL1: other}))

    assert result["warnings"] == [no_color(1, "size")]


@pytest.mark.parametrize(
    "change",
    [{"width": "400"}, {"height": "300"}, {"width": True}, {"height": float("inf")}],
)
def test_page_size_that_is_not_a_number_skips_colors_without_download(
    change: dict[str, object],
) -> None:
    # 글자 숫자("400")는 레이아웃이 float()로 읽어 계속되지만 색 찾기는 건너뜀
    bad = note_read()
    bad["pages"][0].update(change)
    fetch = FakeFetch()

    result = run_direct(
        two_pages(), ocr=FakeOcr({URL1: bad, URL2: note_read("2. 대장 아메바")}), fetch=fetch
    )

    assert fetch.urls == [URL2]
    assert result["warnings"] == [no_color(1, "size")]
    assert len(result["chunks"]) == 2


@pytest.mark.parametrize("missing", ["width", "height"])
def test_missing_page_size_is_a_size_warning_not_a_key_error(missing: str) -> None:
    bad = note_read()
    del bad["pages"][0][missing]
    fetch = FakeFetch()

    assert note_job._image(fetch, URL1, bad) == "size"
    assert fetch.urls == []


def test_page_over_the_pixel_limit_is_not_downloaded() -> None:
    big = note_read()
    big["pages"][0].update({"width": 10_000, "height": 5_001})  # 5천만을 조금 넘음
    fetch = FakeFetch()

    result = run_direct(
        two_pages(), ocr=FakeOcr({URL1: big, URL2: note_read("2. 대장 아메바")}), fetch=fetch
    )

    assert big["pages"][0]["width"] * big["pages"][0]["height"] > IMAGE_MAX_PIXELS
    assert fetch.urls == [URL2]
    assert result["warnings"] == [no_color(1, "size")]
    assert len(result["chunks"]) == 2


@pytest.mark.parametrize(("limit", "used"), [(W * H, True), (W * H - 1, False)])
def test_pixel_limit_boundary(monkeypatch: pytest.MonkeyPatch, limit: int, used: bool) -> None:
    monkeypatch.setattr(note_job, "IMAGE_MAX_PIXELS", limit)
    fetch = FakeFetch({URL1: image(BLACK, BLACK, RED)})

    result = run_direct({"pages": [{"pageNo": 1, "imageUrl": URL1}]}, fetch=fetch)

    (chunk,) = result["chunks"]
    has_color = any(m["kind"] == "color" for m in chunk["emphasis"]["marks"])
    if used:  # 상한과 같으면 그대로 내려받아 색을 찾음
        assert (fetch.urls, result["warnings"], has_color) == ([URL1], [], True)
    else:
        assert (fetch.urls, result["warnings"], has_color) == ([], [no_color(1, "size")], False)


def test_pdf_is_not_downloaded_and_takes_its_page_numbers() -> None:
    pdf = read(
        ocr_page("1. 개요", "내용", unit="inch"),
        ocr_page("2. 분류", "내용", unit="inch", page_number=2),
    )
    ocr = FakeOcr({PDF_URL: pdf, URL2: note_read("3. 이질 아메바")})
    fetch = FakeFetch()

    result = run_direct(
        {"pages": [{"pageNo": 1, "imageUrl": PDF_URL}, {"pageNo": 2, "imageUrl": URL2}]},
        ocr=ocr,
        fetch=fetch,
    )

    assert fetch.urls == [URL2]
    assert [p["pageNo"] for p in result["pages"]] == [1, 2, 3]  # 뒤 사진은 3쪽으로 밀림
    assert result["warnings"] == [no_color(1, "pdf")]


# ---------- input 검사 ----------


@pytest.mark.parametrize(
    "inp",
    [
        {},
        {"pages": []},
        {"pages": "글"},
        {"pages": ["글"]},
        {"pages": [{"imageUrl": URL1}]},
        {"pages": [{"pageNo": 0, "imageUrl": URL1}]},
        {"pages": [{"pageNo": -1, "imageUrl": URL1}]},
        {"pages": [{"pageNo": 1.0, "imageUrl": URL1}]},
        {"pages": [{"pageNo": True, "imageUrl": URL1}]},
        {"pages": [{"pageNo": "1", "imageUrl": URL1}]},
        {"pages": [{"pageNo": 1}]},
        {"pages": [{"pageNo": 1, "imageUrl": "  "}]},
        {"pages": [{"pageNo": 1, "imageUrl": 3}]},
        {"pages": [{"pageNo": 1, "imageUrl": URL1}, {"pageNo": 1, "imageUrl": URL2}]},
        {"pages": [{"pageNo": i, "imageUrl": URL1} for i in range(1, NOTE_MAX_PAGES + 2)]},
        {"pages": [{"pageNo": 1, "imageUrl": URL1}], "subject": 3},
        {"pages": [{"pageNo": 1, "imageUrl": URL1}], "seeds": "글"},
        {"pages": [{"pageNo": 1, "imageUrl": URL1}], "seeds": ["글"]},
        {"pages": [{"pageNo": 1, "imageUrl": URL1}], "seeds": [{"topic": "회충"}]},
        {"pages": [{"pageNo": 1, "imageUrl": URL1}], "seeds": [{"topic": 1, "terms": []}]},
        {
            "pages": [{"pageNo": 1, "imageUrl": URL1}],
            "seeds": [{"topic": "회충", "terms": ["회충"]}],
        },
        {
            "pages": [{"pageNo": 1, "imageUrl": URL1}],
            "seeds": [{"topic": "회충", "terms": [{"term": "회충", "url": 1}]}],
        },
    ],
)
def test_bad_input_fails_without_calling_anything(
    monkeypatch: pytest.MonkeyPatch, inp: JsonObject
) -> None:
    ocr, llm = FakeOcr(), FakeLlm()

    doc = run_job(monkeypatch, inp, ocr=ocr, llm=llm)

    assert (doc["status"], doc["attempts"]) == ("failed", 1)
    assert doc["error"].startswith("입력 오류: ")
    assert ocr.urls == []
    assert llm.calls == []


def test_good_optional_input_is_accepted() -> None:
    result = run_direct(
        {
            "pages": [{"pageNo": NOTE_MAX_PAGES + 7, "imageUrl": URL1}],
            "subject": "기생충학",
            "seeds": [{"topic": "원충류", "terms": [{"term": "이질 아메바", "url": "https://x"}]}],
        }
    )

    assert [p["pageNo"] for p in result["pages"]] == [NOTE_MAX_PAGES + 7]


def test_pdf_pages_over_the_limit_are_rejected_after_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    big = read(
        *(ocr_page("내용", unit="inch", page_number=i) for i in range(1, NOTE_MAX_PAGES + 2))
    )
    llm = FakeLlm()

    doc = run_job(
        monkeypatch,
        {"pages": [{"pageNo": 1, "imageUrl": PDF_URL}]},
        ocr=FakeOcr({PDF_URL: big}),
        llm=llm,
    )

    assert (doc["status"], doc["attempts"]) == ("failed", 1)
    assert doc["error"].startswith("INVALID_FILE: ")
    assert "checkpoint" not in doc


# ---------- OCR 오류 · 글 없음 ----------


def test_ocr_rejecting_the_file_is_invalid_file_and_hides_the_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ocr = FakeOcr({URL1: note_read(), URL2: OcrError("HTTP 400 InvalidRequest")})

    doc = run_job(monkeypatch, two_pages(), ocr=ocr)

    assert (doc["status"], doc["attempts"]) == ("failed", 1)
    assert doc["error"] == "INVALID_FILE: 2번 파일 글자 인식 실패(HTTP 400 InvalidRequest)"
    assert "checkpoint" not in doc


def test_input_error_keeps_code_outside_runner() -> None:
    with pytest.raises(InputError) as e:
        run_direct(two_pages(), ocr=FakeOcr({URL1: OcrError("HTTP 400"), URL2: note_read()}))
    assert e.value.code == "INVALID_FILE"


def test_ocr_unavailable_goes_up_as_is() -> None:
    with pytest.raises(OcrUnavailableError):
        run_direct(
            two_pages(), ocr=FakeOcr({URL1: OcrUnavailableError("HTTP 503"), URL2: note_read()})
        )


def test_ocr_key_error_is_not_a_file_error() -> None:
    with pytest.raises(OcrSetupError):
        run_direct(two_pages(), ocr=FakeOcr({URL1: OcrSetupError("HTTP 401"), URL2: note_read()}))


@pytest.mark.parametrize("error", [OcrSetupError("HTTP 401"), OcrSetupError("HTTP 403 Forbidden")])
def test_ocr_key_error_fails_without_retry_and_without_invalid_file(
    monkeypatch: pytest.MonkeyPatch, error: Exception
) -> None:
    llm = FakeLlm()
    ocr = FakeOcr({URL1: error, URL2: note_read()})

    doc = run_job(monkeypatch, two_pages(), ocr=ocr, llm=llm)

    assert (doc["status"], doc["attempts"], doc["error"]) == ("failed", 1, "처리 중 오류")
    assert ocr.urls == [URL1] and llm.calls == []
    assert "checkpoint" not in doc


def test_missing_ocr_setting_fails_without_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    # 실제 docint()로 설정 누락을 봄. 캐시가 남지 않게 새 _Once를 씀
    monkeypatch.setattr(settings, "azure_docint_endpoint", "")
    col = queued_job(two_pages())
    monkeypatch.setattr(handlers, "_llm", lambda: FakeLlm())
    monkeypatch.setattr(handlers, "_voyage", lambda: FakeVoyage())
    monkeypatch.setattr(handlers, "_ocr", handlers._Once(lambda: handlers.Ocr(handlers.docint())))
    store = JobStore(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: T0)

    assert run_once(store, HANDLERS)

    doc = col.find_one({"_id": "j1"})
    assert (doc["status"], doc["attempts"], doc["error"]) == ("failed", 1, "처리 중 오류")


def test_ocr_unavailable_is_retried_later(monkeypatch: pytest.MonkeyPatch) -> None:
    ocr = FakeOcr({URL1: OcrUnavailableError("HTTP 503"), URL2: note_read()})

    doc = run_job(monkeypatch, two_pages(), ocr=ocr)

    assert (doc["status"], doc["attempts"], doc["result"]) == ("queued", 1, None)
    assert doc["error"] == "AI 응답을 받지 못함(OCR HTTP 503)"
    assert "secret-sas" not in doc["error"]


@pytest.mark.parametrize(
    "empty",
    [{"pages": []}, read(ocr_page()), read(ocr_page("  "))],
    ids=["no-page", "no-line", "blank-line"],
)
def test_no_text_fails_with_code_before_the_llm(
    monkeypatch: pytest.MonkeyPatch, empty: JsonObject
) -> None:
    llm, voyage = FakeLlm(), FakeVoyage()
    ocr = FakeOcr({URL1: empty})

    doc = run_job(
        monkeypatch, {"pages": [{"pageNo": 1, "imageUrl": URL1}]}, ocr=ocr, llm=llm, voyage=voyage
    )

    assert (doc["status"], doc["attempts"]) == ("failed", 1)
    assert doc["error"] == "NO_TEXT: 노트에서 글자를 찾지 못함"
    assert llm.calls == [] and voyage.texts == []
    assert "checkpoint" not in doc


# ---------- 조각 나누기 · 후처리 ----------


def test_refine_without_seeds_calls_no_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "note_refine_enabled", True)
    llm = FakeLlm()

    run_direct(two_pages(), llm=llm)

    assert llm.calls == []


def test_refine_with_seeds_uses_subject_and_seeds(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "note_refine_enabled", True)
    llm = FakeLlm({"note_topics": [{"topics": []}]})
    seeds = [{"topic": "원충류", "terms": [{"term": "이질 아메바"}]}]

    run_direct({**two_pages(), "subject": "기생충학", "seeds": seeds}, llm=llm)

    (call,) = llm.calls
    assert call.name == "note_topics"
    assert call.model == settings.note_refine_model
    assert "과목: 기생충학" in call.user and "1) 원충류" in call.user


def test_long_paragraph_is_split_by_the_llm() -> None:
    rows = [f"- 내용 {i} " + "가" * 40 for i in range(30)]
    ocr = FakeOcr({URL1: read(ocr_page(*rows[:15]))})  # 500자를 넘는 제목 없는 문단
    llm = FakeLlm({"note_split": lambda user: {"starts": [1, 4]}})

    result = run_direct({"pages": [{"pageNo": 1, "imageUrl": URL1}]}, ocr=ocr, llm=llm)

    assert [c.model for c in llm.calls] == [settings.note_split_model]
    assert [c["order"] for c in result["chunks"]] == [1, 2]


def test_llm_unavailable_is_retried_later(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "note_refine_enabled", True)
    llm = FakeLlm({"note_topics": [LlmError("HTTP 503")]})
    seeds = [{"topic": "원충류", "terms": [{"term": "이질 아메바"}]}]

    doc = run_job(monkeypatch, {**two_pages(), "seeds": seeds}, llm=llm)

    assert (doc["status"], doc["attempts"]) == ("queued", 1)
    assert doc["error"] == "AI 응답을 받지 못함(HTTP 503)"


def test_voyage_unavailable_is_retried_later(monkeypatch: pytest.MonkeyPatch) -> None:
    doc = run_job(monkeypatch, two_pages(), voyage=FakeVoyage(EmbedUnavailableError("HTTP 429")))

    assert (doc["status"], doc["attempts"], doc["result"]) == ("queued", 1, None)
    assert doc["error"] == "AI 응답을 받지 못함(임베딩 HTTP 429)"


# ---------- 다시 시도 때 OCR 결과 재사용 ----------


def voyage_down() -> FakeVoyage:
    return FakeVoyage(EmbedUnavailableError("HTTP 503"))


def expired_sas() -> FakeOcr:
    """다시 부르면 바로 실패로 끝나는 OCR(읽기 주소 만료)."""
    return FakeOcr({URL1: OcrError("HTTP 400"), URL2: OcrError("HTTP 400")})


def test_ocr_result_is_saved_without_raw_ocr_or_word_boxes(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job(two_pages())
    fetch = FakeFetch({URL2: DownloadError("ConnectError")})

    doc = attempt(monkeypatch, col, voyage=voyage_down(), fetch=fetch)

    assert (doc["status"], doc["attempts"]) == ("queued", 1)
    saved = doc["checkpoint"]
    assert set(saved) == {"uploads", "warnings"}
    assert [(u["pageNo"], u["pages"], len(u["lines"])) for u in saved["uploads"]] == [
        (1, 1, 3),
        (2, 1, 3),
    ]
    assert saved["warnings"] == [no_color(2, "download")]
    words = [w for u in saved["uploads"] for ln in u["lines"] for w in ln["words"]]
    assert words and all("polygon" not in w for w in words)
    assert all("color" in w for w in saved["uploads"][0]["lines"][0]["words"])  # 색 찾기는 끝남
    assert "secret-sas" not in json.dumps(saved, ensure_ascii=False)


def test_retry_skips_ocr_and_download_and_gives_the_same_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fresh = run_direct(two_pages(), fetch=FakeFetch({URL1: image(BLACK, BLACK, RED)}))
    col = queued_job(two_pages())
    attempt(
        monkeypatch, col, voyage=voyage_down(), fetch=FakeFetch({URL1: image(BLACK, BLACK, RED)})
    )
    ocr, fetch = expired_sas(), FakeFetch()

    doc = attempt(monkeypatch, col, ocr=ocr, fetch=fetch)

    assert (doc["status"], doc["attempts"], doc["error"]) == ("succeeded", 2, None)
    assert ocr.urls == [] and fetch.urls == []
    assert doc["result"] == json.loads(json.dumps(fresh))
    assert "checkpoint" not in doc


def test_retry_keeps_download_warnings(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job(two_pages())
    attempt(
        monkeypatch, col, voyage=voyage_down(), fetch=FakeFetch({URL1: DownloadError("HTTP 403")})
    )

    doc = attempt(monkeypatch, col, ocr=expired_sas())

    assert doc["status"] == "succeeded"
    assert doc["result"]["warnings"] == [no_color(1, "download")]


def test_retry_progress_starts_at_split(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job(two_pages())
    saved = attempt(monkeypatch, col, voyage=voyage_down())["checkpoint"]
    seen: list[tuple[int, str | None]] = []

    class Saved:
        def load_checkpoint(self) -> object:
            return saved

        def save_checkpoint(self, value: JsonObject) -> None:
            raise AssertionError("다시 저장하면 안 됨")

    def no_ocr() -> Reader:
        raise AssertionError("OCR을 만들면 안 됨")

    run(
        FakeLlm(),
        no_ocr,
        FakeVoyage(),
        two_pages(),
        lambda value, step=None: seen.append((value, step)),
        checkpoint=Saved(),
        fetch=FakeFetch(),
    )

    assert seen[0] == (50, "split")
    assert "ocr" not in [s for _, s in seen]


def good_upload(page_no: int = 1, **change: object) -> dict[str, Any]:
    line = {
        "id": 1,
        "page": page_no,
        "text": "1. 개요",
        "x0": 0.1,
        "x1": 0.5,
        "y0": 0.1,
        "y1": 0.12,
        "hand": True,
        "words": [{"text": "1. 개요", "start": 0, "end": 5, "confidence": 0.9}],
    }
    return {"pageNo": page_no, "pages": 1, "lines": [line], **change}


def bad_line(**change: object) -> dict[str, Any]:
    return good_upload(lines=[{**good_upload()["lines"][0], **change}])


def bad_word(**change: object) -> dict[str, Any]:
    word = {**good_upload()["lines"][0]["words"][0], **change}
    return bad_line(words=[word])


@pytest.mark.parametrize(
    "broken",
    [
        "글",
        {},
        {"uploads": [good_upload(1)]},  # warnings 없음
        {"uploads": [good_upload(1)], "warnings": [1]},
        {"uploads": [good_upload(1), good_upload(2)], "warnings": "글"},
        {"uploads": [good_upload(1), good_upload(2)], "warnings": ["1쪽: 예전 글 경고"]},
        {
            "uploads": [good_upload(1), good_upload(2)],
            "warnings": [{**no_color(1, "pdf"), "code": "X"}],
        },
        {"uploads": [good_upload(1), good_upload(2)], "warnings": [no_color(1, "blur")]},
        {"uploads": [good_upload(1), good_upload(2)], "warnings": [no_color(3, "pdf")]},
        {"uploads": [good_upload(1), good_upload(2)], "warnings": [no_color(0, "pdf")]},
        {
            "uploads": [good_upload(1), good_upload(2)],
            "warnings": [{**no_color(1, "pdf"), "url": "x"}],
        },
        {"uploads": [good_upload(1), good_upload(2)], "warnings": [no_color(1, "pdf")] * 2},
        {"uploads": [good_upload(1), good_upload(2), good_upload(3)], "warnings": []},
        {"uploads": [good_upload(1), "글"], "warnings": []},
        {"uploads": [good_upload(1), good_upload(5)], "warnings": []},  # 놓인 번호가 다름
        {"uploads": [good_upload(1, pages=2), good_upload(2)], "warnings": []},
        {"uploads": [good_upload(1, pages=0), good_upload(2)], "warnings": []},
        {"uploads": [good_upload(1, pages=NOTE_MAX_PAGES + 1), good_upload(52)], "warnings": []},
        {"uploads": [good_upload(1, lines="글"), good_upload(2)], "warnings": []},
        {"uploads": [good_upload(1, lines=[]), good_upload(2, lines=[])], "warnings": []},
        {"uploads": [bad_line(page=2), good_upload(2)], "warnings": []},
        {"uploads": [bad_line(text=None), good_upload(2)], "warnings": []},
        {"uploads": [bad_line(hand="예"), good_upload(2)], "warnings": []},
        {"uploads": [bad_line(x0="0"), good_upload(2)], "warnings": []},
        {"uploads": [bad_line(y1=float("nan")), good_upload(2)], "warnings": []},
        {"uploads": [bad_line(id=-1), good_upload(2)], "warnings": []},
        {"uploads": [bad_line(words="글"), good_upload(2)], "warnings": []},
        {"uploads": [bad_word(end=99), good_upload(2)], "warnings": []},
        {"uploads": [bad_word(confidence=None), good_upload(2)], "warnings": []},
        {"uploads": [bad_word(colorDiff="예"), good_upload(2)], "warnings": []},
        {"uploads": [bad_word(color=1), good_upload(2)], "warnings": []},
    ],
)
def test_broken_checkpoint_is_ignored_and_ocr_runs_again(
    monkeypatch: pytest.MonkeyPatch, broken: object
) -> None:
    col = queued_job(two_pages())
    col.update_one({"_id": "j1"}, {"$set": {"checkpoint": broken}})
    ocr = FakeOcr()

    doc = attempt(monkeypatch, col, ocr=ocr)

    assert (doc["status"], doc["error"]) == ("succeeded", None)
    assert ocr.urls == [URL1, URL2]
    assert "checkpoint" not in doc


def test_good_hand_written_checkpoint_is_used(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job(two_pages())
    saved = {
        "uploads": [good_upload(1), good_upload(2, lines=[])],
        "warnings": [no_color(2, "size")],
    }
    col.update_one({"_id": "j1"}, {"$set": {"checkpoint": saved}})
    ocr = expired_sas()

    doc = attempt(monkeypatch, col, ocr=ocr)

    assert doc["status"] == "succeeded"
    assert ocr.urls == []
    assert doc["result"]["pages"] == [
        {"pageNo": 1, "ocrText": "1. 개요"},
        {"pageNo": 2, "ocrText": ""},
    ]
    assert doc["result"]["warnings"] == [no_color(2, "size")]


def test_nothing_is_saved_when_canceled_during_ocr(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job(two_pages())

    class CanceledOcr(FakeOcr):
        def read(self, url: str) -> dict[str, Any]:
            col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})
            return super().read(url)

    ocr = CanceledOcr()
    doc = attempt(monkeypatch, col, ocr=ocr)

    assert doc["status"] == "canceled"
    assert ocr.urls == [URL1]  # 첫 쪽 진행률을 쓸 때 멈춤
    assert "checkpoint" not in doc


def test_cancel_during_ocr_stops_before_the_next_page() -> None:
    ocr = FakeOcr()

    def cancel(value: int, step: str | None) -> None:
        if step == "ocr" and value > 0:
            raise JobGoneError("j1")

    with pytest.raises(JobGoneError):
        run_direct(two_pages(), ocr=ocr, report=cancel)
    assert ocr.urls == [URL1]


# ---------- 크기 ----------


def dense_read(page_no: int) -> JsonObject:
    """빽빽한 쪽: 40줄 × 줄마다 20음절(한국어는 음절 하나가 단어 하나)."""
    texts = [f"{page_no}-{i} " + "가나다라마" * 4 for i in range(40)]
    page = ocr_page(*texts)
    words = []
    for ln, text in zip(page["lines"], texts, strict=True):
        start = ln["spans"][0]["offset"]
        for k, ch in enumerate(text):
            words.append(
                {
                    "content": ch,
                    "polygon": [float(v) for v in ln["polygon"]],
                    "span": {"offset": start + k, "length": 1},
                    "confidence": 0.987654,
                }
            )
    page["words"] = words
    return {
        "content": "",
        "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": 10**6}]}],
        "pages": [page],
    }


def test_thirty_dense_pages_checkpoint_and_result_fit_in_a_mongo_document() -> None:
    n = 30
    urls = [f"https://blob.example.test/notes/{i}.jpg" for i in range(1, n + 1)]
    ocr = FakeOcr({u: dense_read(i) for i, u in enumerate(urls, 1)})
    saved: list[JsonObject] = []

    class Keep:
        def load_checkpoint(self) -> object:
            return None

        def save_checkpoint(self, value: JsonObject) -> None:
            saved.append(value)

    result = run(
        FakeLlm({"note_split": lambda user: {"starts": [1]}}),
        lambda: ocr,
        FakeVoyage(dims=1024),
        {"pages": [{"pageNo": i, "imageUrl": u} for i, u in enumerate(urls, 1)]},
        lambda value, step=None: None,
        checkpoint=Keep(),
        fetch=FakeFetch({u: DownloadError("시험") for u in urls}),
    )

    checkpoint_bytes = len(bson.encode({"checkpoint": saved[0]}))
    assert checkpoint_bytes < 4 * 1024 * 1024
    # 성공하면 checkpoint는 지워지지만, 마지막 저장과 결과가 함께 있는 때를 넉넉히 봄
    assert len(bson.encode({"checkpoint": saved[0], "result": result})) < MONGO_DOC_LIMIT
