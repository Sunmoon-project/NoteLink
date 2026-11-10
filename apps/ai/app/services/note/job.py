"""노트 정리 작업(ai_jobs). 쪽마다 OCR → 색 · 형광펜 → [?] → 읽는 순서 → 조각 → 임베딩.

input   {pages: [{pageNo, imageUrl}], subject?: 글, seeds?: [{topic, terms: [{term, url?}]}]}
        pageNo는 업로드 순서(1부터). 여러 쪽 PDF는 pageNo부터 쪽 수만큼 번호를 차지함
result  {pages: [{pageNo, ocrText}], lineResults, chunks: [노트 조각 + embedding], warnings}
        chunks는 맞춤 퀴즈 input의 material.chunks에 그대로 들어감(quiz.generate)
        warnings는 녹음처럼 {code, ...} 목록. 지금은 색 · 형광펜을 찾지 못한 쪽만
        {code: NO_COLOR, pageNo(놓인 번호), reason: pdf | download | decode | size}

진행률 단계: ocr 0→50(쪽 하나 끝날 때마다), split 50→70, refine 70→90, embed 90→100.
거절은 InputError(코드가 있으면 앱이 구분), 일시 오류(LlmError · OcrUnavailableError ·
EmbedUnavailableError)는 그대로 올립니다. OCR 키 · 권한 오류(OcrSetupError)는 파일 문제가
아니므로 InputError로 바꾸지 않습니다. 오류 문구에 사진 주소(SAS)를 넣지 않습니다.
색 찾기용 사진을 쓰지 못하면 색 없이 계속하고 warnings에 NO_COLOR로 남깁니다.
OCR · 색 단계가 끝나면 업로드마다 {pageNo(놓인 번호), pages(차지한 쪽 수), lines(처리한 줄)}를
checkpoint에 저장하고, 다시 시도할 때 값이 검사를 통과하면 OCR과 내려받기를 건너뜁니다(과금 ·
SAS 만료를 피함). 문서 크기(16MB)를 지키려고 OCR 원본과 색 찾기 뒤에 쓰지 않는 단어 상자는
저장하지 않습니다.
"""

import logging
import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal, Protocol, TypedDict, TypeIs, get_args

import cv2
import numpy as np

from app.clients.docint import DownloadError, OcrError, OcrUnavailableError, download
from app.clients.llm import JsonObject, Llm
from app.clients.voyage import InputType
from app.core.config import settings
from app.services.note.emphasis import Image
from app.services.note.models import Line, Word
from app.services.note.pipeline import (
    NotePage,
    embed_texts,
    layouts_from_lines,
    page_lines,
    page_span,
    refine_note,
    result_from_layouts,
    split_with_llm,
)
from app.services.note.seeds import SeedTerm, TopicSeed

log = logging.getLogger(__name__)

TYPE = "handwriting_summary"
NOTE_MAX_PAGES = 50  # 업로드 수, 그리고 OCR 뒤 여러 쪽 PDF를 펼친 쪽 수의 상한
INVALID_FILE = "INVALID_FILE"
NO_TEXT = "NO_TEXT"
NO_COLOR = "NO_COLOR"
# 색 찾기용 사진의 최대 픽셀 수(폭 × 높이). 20MB 압축 파일도 풀면 훨씬 커질 수 있어 OCR 쪽
# 크기로 먼저 거름(5천만 픽셀 BGR ≈ 150MB, 색 계산용 Lab float32 ≈ 600MB)
IMAGE_MAX_PIXELS = 50_000_000
OCR_END = 50
SPLIT_END = 70
REFINE_END = 90
_WORD_TEXT_KEYS = ("color", "baseColor", "highlight")
_WORD_BOOL_KEYS = ("hand", "colorDiff")


type NoColorReason = Literal["pdf", "download", "decode", "size"]


class NoColor(TypedDict):
    """색 · 형광펜을 찾지 못한 쪽. 사유: pdf(사진 한 장이 아님) · download(내려받기 실패) ·
    decode(사진으로 읽지 못함) · size(OCR 쪽 크기가 없거나, 너무 크거나, 사진과 다름)."""

    code: Literal["NO_COLOR"]
    pageNo: int
    reason: NoColorReason


class InputError(ValueError):
    """노트 사진이나 input이 작업에 맞지 않음. 다시 해도 같음. 메시지는 앱에 보이는 짧은 원인."""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class Report(Protocol):
    def __call__(self, value: int, step: str | None = None) -> None: ...


class Checkpoint(Protocol):
    def load_checkpoint(self) -> object: ...

    def save_checkpoint(self, value: JsonObject) -> None: ...


class Reader(Protocol):
    def read(self, url: str) -> dict[str, Any]: ...


class Embedder(Protocol):
    def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]: ...


@dataclass(frozen=True)
class _Upload:
    page_no: int  # 놓인 번호(앞 PDF가 번호를 차지하면 밀림)
    pages: int  # 차지한 쪽 수
    lines: list[Line]


def run(
    llm: Llm,
    ocr: Callable[[], Reader],
    embedder: Embedder,
    inp: JsonObject,
    report: Report,
    *,
    checkpoint: Checkpoint | None = None,
    fetch: Callable[[str], bytes] = download,
) -> JsonObject:
    """ocr는 OCR을 할 때만 만듭니다. fetch는 색 찾기용 사진을 내려받음(시험에서 바꿈)."""
    pages = _pages(inp.get("pages"))
    subject = inp.get("subject")
    if subject is not None and not isinstance(subject, str):
        raise InputError("input.subject가 글자가 아님")
    seeds = _seeds(inp.get("seeds"))
    uploads, warnings = _read(ocr, fetch, pages, report, checkpoint)
    _check_text(uploads)
    lines = [ln for u in uploads for ln in u.lines]
    numbers = [n for u in uploads for n in range(u.page_no, u.page_no + u.pages)]
    note = result_from_layouts(layouts_from_lines(lines, numbers))
    report(OCR_END, "split")
    chunks = split_with_llm(llm, settings.note_split_model, note["chunks"])
    report(SPLIT_END, "refine")
    chunks = refine_note(llm, settings.note_refine_model, chunks, subject or "", seeds)
    report(REFINE_END, "embed")
    vectors = embedder.embed(embed_texts(chunks), "document")
    report(100, "embed")
    return {
        "pages": note["pages"],
        "lineResults": note["lineResults"],
        "chunks": [{**c, "embedding": v} for c, v in zip(chunks, vectors, strict=True)],
        "warnings": warnings,
    }


# ---------------------------------------------------------------- input


def _pages(raw: object) -> list[tuple[int, str]]:
    """(pageNo, imageUrl)을 pageNo 순서로."""
    if not isinstance(raw, list) or not raw:
        raise InputError("input.pages가 비어 있거나 목록이 아님")
    if len(raw) > NOTE_MAX_PAGES:
        raise InputError(f"input.pages가 {NOTE_MAX_PAGES}개를 넘음")
    out: list[tuple[int, str]] = []
    for i, p in enumerate(raw):
        page_no = p.get("pageNo") if isinstance(p, dict) else None
        url = p.get("imageUrl") if isinstance(p, dict) else None
        if not _is_count(page_no) or page_no < 1:
            raise InputError(f"input.pages[{i}].pageNo가 1 이상의 정수가 아님")
        if not isinstance(url, str) or not url.strip():
            raise InputError(f"input.pages[{i}].imageUrl이 글자가 아님")
        out.append((page_no, url))
    if len({n for n, _ in out}) != len(out):
        raise InputError("input.pages의 pageNo가 겹침")
    return sorted(out)


def _seeds(raw: object) -> list[TopicSeed]:
    if raw is None:
        return []
    if not isinstance(raw, list):
        raise InputError("input.seeds가 목록이 아님")
    out: list[TopicSeed] = []
    for i, s in enumerate(raw):
        error = InputError(f"input.seeds[{i}] 모양이 맞지 않음")
        if not isinstance(s, dict) or not isinstance(s.get("topic"), str):
            raise error
        terms = s.get("terms")
        if not isinstance(terms, list):
            raise error
        kept: list[SeedTerm] = []
        for t in terms:
            if not isinstance(t, dict) or not isinstance(t.get("term"), str):
                raise error
            url = t.get("url")
            if url is not None and not isinstance(url, str):
                raise error
            term: SeedTerm = {"term": t["term"]}
            if url is not None:
                term["url"] = url
            kept.append(term)
        out.append({"topic": s["topic"], "terms": kept})
    return out


# ---------------------------------------------------------------- OCR · 색


def _read(
    ocr: Callable[[], Reader],
    fetch: Callable[[str], bytes],
    pages: list[tuple[int, str]],
    report: Report,
    checkpoint: Checkpoint | None,
) -> tuple[list[_Upload], list[NoColor]]:
    if checkpoint is not None and (reused := _from_checkpoint(checkpoint.load_checkpoint(), pages)):
        return reused
    client = ocr()  # 설정 누락은 파일 문제가 아니므로 아래 except 밖에서
    report(0, "ocr")
    uploads: list[_Upload] = []
    warnings: list[NoColor] = []
    nxt, total = 1, 0
    for i, (page_no, url) in enumerate(pages, 1):
        start = max(page_no, nxt)
        try:
            read = client.read(url)
        except OcrUnavailableError:
            raise
        except OcrError as e:  # OcrSetupError(키 · 권한)는 OcrError가 아니라 그대로 올라감
            raise InputError(f"{page_no}번 파일 글자 인식 실패({e})", code=INVALID_FILE) from e
        span = page_span(read)
        total += span
        if total > NOTE_MAX_PAGES:
            raise InputError(f"노트가 {NOTE_MAX_PAGES}쪽을 넘음", code=INVALID_FILE)
        page: NotePage = {"pageNo": start, "read": read}
        image = _image(fetch, url, read)
        if isinstance(image, str):
            warnings.append({"code": "NO_COLOR", "pageNo": start, "reason": image})
        elif image is not None:
            page["image"] = image
        uploads.append(_Upload(start, span, page_lines(page)))
        nxt = start + span
        report(OCR_END * i // len(pages), "ocr")
    _check_text(uploads)
    if checkpoint is not None:
        checkpoint.save_checkpoint(
            {
                "uploads": [
                    {"pageNo": u.page_no, "pages": u.pages, "lines": [_slim(ln) for ln in u.lines]}
                    for u in uploads
                ],
                "warnings": warnings,
            }
        )
    return uploads, warnings


def _image(
    fetch: Callable[[str], bytes], url: str, read: dict[str, Any]
) -> Image | NoColorReason | None:
    """색 찾기용 사진. 사진 한 장(OCR 단위 pixel)만 내려받음. 못 쓰면 그 사유, 빈 쪽이면 None."""
    pages = read.get("pages") or []
    if not pages:
        return None
    if len(pages) > 1 or pages[0].get("unit") != "pixel":
        return "pdf"
    size = _page_size(pages[0])
    if size is None:  # 크기를 모르면 단어 상자와 맞는지 볼 수 없음. 내려받기 전에 건너뜀
        return "size"
    if size[0] * size[1] > IMAGE_MAX_PIXELS:  # 풀면 메모리를 많이 씀. 내려받기 전에 건너뜀
        return "size"
    try:
        data = fetch(url)
    except DownloadError as e:
        log.warning("색 찾기용 사진을 내려받지 못함: %s", e)  # e에는 주소가 없음
        return "download"
    try:
        image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    except cv2.error:
        image = None
    if image is None:
        return "decode"
    height, width = image.shape[:2]
    if (width, height) != size:
        # 단어 상자가 OCR 크기 기준이라 크기가 다르면 엉뚱한 곳의 색을 잼(회전 · 다른 파일)
        return "size"
    return np.asarray(image, dtype=np.uint8)


def _page_size(page: object) -> tuple[int, int] | None:
    """OCR 쪽의 (폭, 높이) 픽셀. 없거나 숫자가 아니면 None."""
    if not isinstance(page, dict):
        return None
    out: list[int] = []
    for key in ("width", "height"):
        v = page.get(key)
        if not isinstance(v, int | float) or isinstance(v, bool) or not math.isfinite(v):
            return None
        out.append(round(v))
    return out[0], out[1]


def _check_text(uploads: list[_Upload]) -> None:
    if not any(ln["text"].strip() for u in uploads for ln in u.lines):
        raise InputError("노트에서 글자를 찾지 못함", code=NO_TEXT)


def _slim(ln: Line) -> JsonObject:
    """checkpoint에 넣을 줄. 단어 상자(polygon)는 색 찾기에만 써서 뺌."""
    return {**ln, "words": [{k: v for k, v in w.items() if k != "polygon"} for w in ln["words"]]}


# ---------------------------------------------------------------- checkpoint


def _from_checkpoint(
    saved: object, pages: list[tuple[int, str]]
) -> tuple[list[_Upload], list[NoColor]] | None:
    """없거나 깨져 있으면 None(OCR부터 다시)."""
    if saved is None:
        return None
    if not isinstance(saved, dict):
        log.warning("저장된 OCR 결과가 객체가 아니라 OCR부터 다시 함")
        return None
    try:
        uploads = _saved_uploads(saved.get("uploads"), pages)
        warnings = _saved_warnings(saved.get("warnings"), {u.page_no for u in uploads})
        _check_text(uploads)
    except InputError as e:
        log.warning("저장된 OCR 결과가 깨져 OCR부터 다시 함: %s", e)
        return None
    return uploads, warnings


def _saved_warnings(raw: object, starts: set[int]) -> list[NoColor]:
    """경고는 업로드 하나에 하나까지, 놓인 번호(upload pageNo)에만 붙음."""
    if not isinstance(raw, list):
        raise InputError("warnings가 목록이 아님")
    out: list[NoColor] = []
    for i, w in enumerate(raw):
        page_no = w.get("pageNo") if isinstance(w, dict) else None
        reason = w.get("reason") if isinstance(w, dict) else None
        if (
            not isinstance(w, dict)
            or w.get("code") != NO_COLOR
            or set(w) != {"code", "pageNo", "reason"}
            or not _is_count(page_no)
            or page_no not in starts
            or not _is_reason(reason)
        ):
            raise InputError(f"warnings[{i}] 모양이 맞지 않음")
        out.append({"code": "NO_COLOR", "pageNo": page_no, "reason": reason})
    if len({w["pageNo"] for w in out}) != len(out):
        raise InputError("warnings의 pageNo가 겹침")
    return out


def _is_reason(value: object) -> TypeIs[NoColorReason]:
    return value in get_args(NoColorReason.__value__)


def _saved_uploads(raw: object, pages: list[tuple[int, str]]) -> list[_Upload]:
    if not isinstance(raw, list) or len(raw) != len(pages):
        raise InputError("uploads 수가 input과 다름")
    out: list[_Upload] = []
    nxt, total = 1, 0
    for i, (u, (page_no, _)) in enumerate(zip(raw, pages, strict=True)):
        error = InputError(f"uploads[{i}] 모양이 맞지 않음")
        if not isinstance(u, dict):
            raise error
        start, span, lines = u.get("pageNo"), u.get("pages"), u.get("lines")
        if not _is_count(start) or start != max(page_no, nxt) or not _is_count(span) or span < 1:
            raise error
        total += span
        if total > NOTE_MAX_PAGES or not isinstance(lines, list):
            raise error
        kept = [
            _saved_line(ln, start, start + span, f"uploads[{i}].lines[{j}]")
            for j, ln in enumerate(lines)
        ]
        out.append(_Upload(start, span, kept))
        nxt = start + span
    return out


def _saved_line(raw: object, lo: int, hi: int, where: str) -> Line:
    error = InputError(f"{where} 모양이 맞지 않음")
    if not isinstance(raw, dict):
        raise error
    lid, page, text, hand, words = (
        raw.get("id"),
        raw.get("page"),
        raw.get("text"),
        raw.get("hand"),
        raw.get("words"),
    )
    if not _is_count(lid) or not _is_count(page) or not lo <= page < hi:
        raise error
    if not isinstance(text, str) or not isinstance(hand, bool) or not isinstance(words, list):
        raise error
    x0, x1, y0, y1 = (_number(raw.get(k), error) for k in ("x0", "x1", "y0", "y1"))
    return {
        "id": lid,
        "page": page,
        "text": text,
        "x0": x0,
        "x1": x1,
        "y0": y0,
        "y1": y1,
        "hand": hand,
        "words": [_saved_word(w, len(text), error) for w in words],
    }


def _saved_word(raw: object, n_chars: int, error: InputError) -> Word:
    if not isinstance(raw, dict):
        raise error
    text, start, end = raw.get("text"), raw.get("start"), raw.get("end")
    if not isinstance(text, str):
        raise error
    if not _is_count(start) or not _is_count(end) or not start <= end <= n_chars:
        raise error
    word: Word = {
        "text": text,
        "start": start,
        "end": end,
        "polygon": [],  # 저장하지 않음(_slim)
        "confidence": _number(raw.get("confidence"), error),
    }
    for key in _WORD_BOOL_KEYS:
        if key in raw:
            if not isinstance(raw[key], bool):
                raise error
            word[key] = raw[key]  # type: ignore[literal-required]
    for key in _WORD_TEXT_KEYS:
        if key in raw:
            if not isinstance(raw[key], str):
                raise error
            word[key] = raw[key]  # type: ignore[literal-required]
    return word


def _is_count(value: object) -> TypeIs[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _number(value: object, error: InputError) -> float:
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    raise error
