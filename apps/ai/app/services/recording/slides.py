"""강의 자료(PPT) 파일에서 쪽마다 글을 뽑습니다(FR-23, #123). 그림은 쓰지 않습니다.

read_slides(url, fetch) → (쪽 글 목록, 경고 목록). 파일 문제는 예외가 아니라 경고입니다:
  {code: NO_SLIDES, reason: download | format | parse | empty | size}
  {code: MATERIAL_TRIMMED, reason: slides}  전체 글자 상한(SLIDES_MAX_CHARS) · 쪽 수 상한
                                            (PPT_MAX_PAGES)을 넘어 뒤쪽을 버리거나, 쪽 글을
                                            PAGE_MAX_CHARS로 자름
파일 형식은 확장자가 아니라 앞 바이트로 정합니다: zip(PK\\x03\\x04) → pptx, OLE → ppt.
  pptx  python-pptx로 쪽 순서대로 도형 글(텍스트 상자 · 자리 표시자 · 표 셀 · 그룹 안 도형)
  ppt   변환 없이 olefile로 'PowerPoint Document' 스트림을 열고 레코드를 읽음([MS-PPT]).
        SlideListWithText(슬라이드 목록, recInstance 0)의 SlidePersistAtom이 쪽(순서)이고,
        쪽 글은 목록 안 글(자리 표시자)과 그 쪽의 Slide 컨테이너 안 글(텍스트 상자 등 그림 레코드
        속 ClientTextbox) — persist 표로 찾음(ppt_slide_texts). 마스터(1) · 메모(2)는 건너뜀
발표자 메모는 넣지 않습니다(대본과 겹치지 않는 설명이 섞여 요약에 대본 밖 내용이 들어가기 쉬움).
오류 문구 · 로그에 주소(SAS)를 넣지 않습니다.
"""

import io
import logging
import struct
import zipfile
from collections import deque
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Literal, TypedDict

import olefile  # type: ignore[import-untyped]
from pptx import Presentation
from pptx.shapes.base import BaseShape
from pptx.shapes.graphfrm import GraphicFrame
from pptx.shapes.group import GroupShape
from pptx.shapes.shapetree import SlideShapes

from app.clients.docint import TOO_LARGE, DownloadError, download

log = logging.getLogger(__name__)

SLIDES_MAX_BYTES = 50 * 1024 * 1024  # 강의 자료 파일 크기 상한. 그림이 많은 수업 자료도 대개 안쪽
# pptx(zip)를 풀었을 때 크기 합의 상한: 작은 압축 파일이 풀리며 메모리를 다 쓰지 않게(zip 폭탄)
SLIDES_MAX_UNZIPPED_BYTES = 300 * 1024 * 1024
PAGE_MAX_CHARS = 1500  # 쪽 하나의 글. 글이 빽빽한 쪽(약 500~1,000자)도 거의 다 들어감
# 뽑아 두는 전체 글. checkpoint에 함께 저장하므로(한국어 약 300KB) 문서 한도(16MB)와 멀게.
# LLM에는 이 중 MATERIAL_MAX_CHARS(material.py)까지 그대로, 넘으면 창마다 골라서 넣음
SLIDES_MAX_CHARS = 100_000
ZIP_MAGIC = b"PK\x03\x04"
OLE_MAGIC = bytes.fromhex("D0CF11E0A1B11AE1")
PPT_STREAM = "PowerPoint Document"
CURRENT_USER_STREAM = "Current User"
CURRENT_USER_MAX_BYTES = 4096  # CurrentUserAtom은 수십 바이트. 앞부분만 읽음
# [MS-PPT] 레코드 종류
SLIDE_LIST_WITH_TEXT = 0x0FF0
SLIDE_PERSIST_ATOM = 0x03F3
SLIDE_CONTAINER = 0x03EE
PERSIST_DIRECTORY_ATOM = 0x1772
USER_EDIT_ATOM = 0x0FF5
CURRENT_USER_ATOM = 0x0FF6
USER_EDIT_MIN_BYTES = 20  # offsetLastEdit · offsetPersistDirectory · docPersistIdRef까지
PPT_MAX_EDITS = 1000  # 편집(빠른 저장) 사슬 상한. 순환 · 깨진 사슬에서 끝나게
TEXT_CHARS_ATOM = 0x0FA0  # UTF-16LE
TEXT_BYTES_ATOM = 0x0FA8  # 글자마다 UTF-16 아래 바이트(위 바이트 0) → latin-1과 같음
CONTAINER_VER = 0xF
RECORD_HEADER = struct.Struct("<HHI")  # recVer(4비트) · recInstance(12비트), recType, recLen
PPT_MAX_DEPTH = 32  # 컨테이너 중첩 상한. 실제 파일은 10단계 안쪽. 깨진 파일의 깊은 재귀를 막음
# 아래는 조작된 .ppt · .pptx가 시간 · 메모리를 다 쓰지 않게 하는 상한(정상 파일은 닿지 않음)
# 쪽 수. 수업 자료는 수백 쪽 안쪽. 넘는 쪽은 버리고 MATERIAL_TRIMMED
PPT_MAX_PAGES = 2000
# 쪽 하나에서 모으는 글(원문 글자). 공백 · 겹친 글이 정리(clean)로 줄어드는 여유를 둔
# PAGE_MAX_CHARS의 4배
PPT_PAGE_MAX_RAW_CHARS = PAGE_MAX_CHARS * 4
# 모든 쪽의 Slide 컨테이너에서 읽는 레코드 수 합. 실제 쪽은 수백 개(도형마다 수십 개)
PPT_MAX_SLIDE_RECORDS = 1_000_000
# 기억해 두는 슬라이드 목록 수(빠른 저장마다 하나씩 늘어남). 넘으면 오래된 것부터 버림
PPT_MAX_LISTS = 64
# persist 표 항목(머리 · 위치를 하나씩 셈) 수: PersistDirectoryAtom 하나와, 편집 사슬(또는 스트림에
# 나온 것) 전체. 쪽 · 메모 · 마스터 · 기타 객체가 쪽 수의 몇 배
PPT_MAX_DIRECTORY_ENTRIES = 4 * PPT_MAX_PAGES
PPT_MAX_PERSIST_ENTRIES = 10 * PPT_MAX_PAGES

type NoSlidesReason = Literal["download", "format", "parse", "empty", "size"]


class Page(TypedDict):
    pageNo: int  # 1부터. 빈 쪽은 빠지지만 번호는 파일의 쪽 순서 그대로
    text: str


class NoSlides(TypedDict):
    code: Literal["NO_SLIDES"]
    reason: NoSlidesReason


class SlidesTrimmed(TypedDict):
    code: Literal["MATERIAL_TRIMMED"]
    reason: Literal["slides"]


type SlidesWarning = NoSlides | SlidesTrimmed


class SlidesError(Exception):
    """자료 파일을 읽지 못함. reason은 경고에 남는 사유."""

    def __init__(self, reason: NoSlidesReason) -> None:
        super().__init__(reason)
        self.reason: NoSlidesReason = reason


def download_slides(url: str) -> bytes:
    """작업 처리기가 쓰는 내려받기(크기 상한 SLIDES_MAX_BYTES)."""
    return download(url, max_bytes=SLIDES_MAX_BYTES)


def read_slides(url: str, fetch: Callable[[str], bytes]) -> tuple[list[Page], list[SlidesWarning]]:
    """주소의 자료 → 쪽 글. 못 쓰면 빈 목록과 경고(예외 없음)."""
    try:
        data = fetch(url)
    except DownloadError as e:
        log.warning("강의 자료를 내려받지 못함: %s", e)  # e에는 주소가 없음
        return [], [_no_slides("size" if str(e) == TOO_LARGE else "download")]
    try:
        texts, cut = read_texts(data)
    except SlidesError as e:
        log.warning("강의 자료를 읽지 못함: %s", e.reason)
        return [], [_no_slides(e.reason)]
    pages, trimmed = limit_pages(texts)
    if not pages:
        return [], [_no_slides("empty")]
    warnings: list[SlidesWarning] = []
    if trimmed or cut:
        warnings.append({"code": "MATERIAL_TRIMMED", "reason": "slides"})
    return pages, warnings


def _no_slides(reason: NoSlidesReason) -> NoSlides:
    return {"code": "NO_SLIDES", "reason": reason}


def clean(text: str) -> str:
    """줄바꿈 · 탭 · 연속 공백을 공백 하나로."""
    return " ".join(text.split())


def limit_pages(texts: list[str]) -> tuple[list[Page], bool]:
    """쪽 글(파일 순서) → 빈 쪽을 뺀 Page 목록. 쪽마다 · 전체 상한. 잘라 낸 글이 있으면 True."""
    pages: list[Page] = []
    total = 0
    cut = False
    for i, raw in enumerate(texts, 1):
        whole = clean(raw)
        text = whole[:PAGE_MAX_CHARS]
        if not text:
            continue
        if total + len(text) > SLIDES_MAX_CHARS:
            return pages, True
        cut = cut or len(whole) > PAGE_MAX_CHARS
        pages.append({"pageNo": i, "text": text})
        total += len(text)
    return pages, cut


def slide_texts(data: bytes) -> list[str]:
    """파일 바이트 → 쪽마다 글(빈 쪽 포함, 파일 순서). 못 읽으면 SlidesError."""
    return read_texts(data)[0]


def read_texts(data: bytes) -> tuple[list[str], bool]:
    """slide_texts와 같고, 상한(ppt 쪽 수 · 전체 글)으로 뒤쪽을 버렸으면 True를 함께."""
    if len(data) > SLIDES_MAX_BYTES:
        raise SlidesError("size")
    if data.startswith(ZIP_MAGIC):
        return pptx_texts(data)
    if data.startswith(OLE_MAGIC):
        return ppt_texts(data)
    raise SlidesError("format")


# ---------------------------------------------------------------- pptx


def pptx_texts(data: bytes) -> tuple[list[str], bool]:
    """쪽마다 글과, 상한으로 뒤쪽을 버렸으면 True. 읽는 도중에 상한을 적용(ppt와 같은 기준):
    쪽은 PPT_MAX_PAGES까지, 쪽 글은 PPT_PAGE_MAX_RAW_CHARS까지, limit_pages 기준 전체 글이
    SLIDES_MAX_CHARS를 넘으면 멈춤. 같은 쪽 파일을 여러 쪽이 가리키면 한 번만 읽음."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            unzipped = sum(info.file_size for info in z.infolist())
    except (zipfile.BadZipFile, OSError, ValueError, EOFError):
        raise SlidesError("parse") from None
    if unzipped > SLIDES_MAX_UNZIPPED_BYTES:
        raise SlidesError("size")
    try:
        prs = Presentation(io.BytesIO(data))
        texts: list[str] = []
        total = 0
        read: dict[str, str] = {}  # 쪽 파일 이름 → 글
        for n, slide in enumerate(prs.slides):
            if n >= PPT_MAX_PAGES:
                return texts, True
            name = str(slide.part.partname)
            if (text := read.get(name)) is None:
                text = read[name] = _capped(_shape_texts(slide.shapes))
            kept = len(clean(text)[:PAGE_MAX_CHARS])  # limit_pages와 같은 셈
            if total + kept > SLIDES_MAX_CHARS:
                return texts, True
            texts.append(text)
            total += kept
        return texts, False
    except Exception:  # 사용자가 올린 파일: 라이브러리 안의 어떤 오류든 '읽지 못함'
        log.debug("pptx 읽기 오류", exc_info=True)
        raise SlidesError("parse") from None


def _capped(pieces: Iterator[str]) -> str:
    """조각을 공백으로 이어 PPT_PAGE_MAX_RAW_CHARS까지. 넘으면 남은 조각은 읽지 않음."""
    out: list[str] = []
    size = 0
    for piece in pieces:
        out.append(piece[: PPT_PAGE_MAX_RAW_CHARS - size])
        size += len(out[-1]) + 1
        if size >= PPT_PAGE_MAX_RAW_CHARS:
            break
    return " ".join(out)[:PPT_PAGE_MAX_RAW_CHARS]


def _shape_texts(shapes: SlideShapes | Iterator[BaseShape]) -> Iterator[str]:
    """도형 순서대로 글. 그룹은 안으로 들어가고, 표는 행 · 열 순서로 칸마다."""
    for shape in shapes:
        if isinstance(shape, GroupShape):
            yield from _shape_texts(iter(shape.shapes))
        elif isinstance(shape, GraphicFrame) and shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    yield cell.text
        elif shape.has_text_frame:
            yield shape.text_frame.text  # type: ignore[attr-defined]  # has_text_frame이 보장


# ---------------------------------------------------------------- ppt(옛 형식)


def ppt_texts(data: bytes) -> tuple[list[str], bool]:
    try:
        with olefile.OleFileIO(data) as ole:
            if not ole.exists(PPT_STREAM):
                raise SlidesError("format")  # OLE지만 PPT가 아님(옛 Word · Excel 등)
            stream: bytes = ole.openstream(PPT_STREAM).read()
            current_user: bytes | None = None
            if ole.exists(CURRENT_USER_STREAM):
                current_user = ole.openstream(CURRENT_USER_STREAM).read(CURRENT_USER_MAX_BYTES)
    except SlidesError:
        raise
    except Exception:  # olefile은 깨진 파일에 여러 종류의 오류를 냄
        log.debug("OLE 읽기 오류", exc_info=True)
        raise SlidesError("parse") from None
    return ppt_read(stream, current_user)


class _BrokenError(Exception):
    """레코드 길이 · 오프셋이 맞지 않음."""


class _StopError(Exception):
    """Slide 컨테이너 읽기를 멈춤: 쪽 글이 충분하거나 레코드 예산을 다 씀."""


@dataclass
class _ListPage:
    persist_ref: int | None  # SlidePersistAtom.persistIdRef(이 쪽의 Slide 컨테이너)
    parts: list[str] = field(default_factory=list)  # 목록 안의 글(주로 자리 표시자)
    chars: int = 0  # parts 글자 수 합(PPT_PAGE_MAX_RAW_CHARS까지)


@dataclass
class _SlideList:
    top: int  # 이 목록이 든 맨 위 레코드(문서 컨테이너)의 위치
    pages: list[_ListPage] = field(default_factory=list)
    cut: bool = False  # PPT_MAX_PAGES를 넘는 쪽이 있어 버림


def _text_atom(stream: bytes, rec_type: int, body: int, end: int, limit: int) -> str | None:
    """글 원자면 앞 limit 글자까지 디코드(큰 원자 전체를 풀지 않음), 아니면 None."""
    if rec_type == TEXT_CHARS_ATOM:
        raw = stream[body : min(end, body + 2 * limit)]
        return raw[: len(raw) // 2 * 2].decode("utf-16-le", "replace")
    if rec_type == TEXT_BYTES_ATOM:
        return stream[body : min(end, body + limit)].decode("latin-1")
    return None


def _header(stream: bytes, pos: int, end: int) -> tuple[int, int, int, int]:
    """(recVer|recInstance, recType, 본문 시작, 다음 위치). 범위를 넘으면 _BrokenError."""
    if pos < 0 or end - pos < RECORD_HEADER.size:
        raise _BrokenError
    ver_inst, rec_type, length = RECORD_HEADER.unpack_from(stream, pos)
    body = pos + RECORD_HEADER.size
    if body + length > end:
        raise _BrokenError
    return ver_inst, rec_type, body, body + length


def ppt_slide_texts(stream: bytes, current_user: bytes | None = None) -> list[str]:
    """'PowerPoint Document' 스트림(과 'Current User' 스트림) → 쪽마다 글(ppt_read)."""
    return ppt_read(stream, current_user)[0]


def ppt_read(stream: bytes, current_user: bytes | None = None) -> tuple[list[str], bool]:
    """'PowerPoint Document' 스트림(과 'Current User' 스트림) → (쪽마다 글, 뒤쪽을 버렸는지).

    1. 레코드를 처음부터 읽어 슬라이드 목록(SlideListWithText, recInstance 0)과
       PersistDirectoryAtom을 모음. 쪽 순서는 슬라이드 목록 순서
    2. persistId → 스트림 위치 표: Current User의 offsetToCurrentEdit부터 UserEditAtom 사슬을
       따라감(정식 방법, 새 편집이 옛 편집을 덮음). 못 따라가면 스트림에 나온 PersistDirectoryAtom을
       차례로(뒤에 나온 것이 앞을 덮음)
    3. 쪽마다 SlidePersistAtom.persistIdRef로 Slide 컨테이너를 찾아 그 안(그림 레코드
       ClientTextbox 포함)의 글 원자를 모두 모음. 목록 안 글(자리 표시자)과 같은 글은 한 번만
    Slide 컨테이너를 찾지 못한 쪽(표 없음 · 오프셋이 스트림 밖 · 다른 레코드)은 목록 안 글만 씀.
    빠른 저장으로 슬라이드 목록이 여러 번 있으면 현재 편집의 문서 컨테이너 것, 모르면 마지막 것.
    레코드가 깨졌으면 그 앞까지 찾은 목록을 쓰고, 목록을 찾기 전이면 SlidesError(parse).
    위치는 레코드마다 앞으로만 가고(헤더 8바이트 이상) 중첩은 PPT_MAX_DEPTH, 편집 사슬은 지난
    위치를 다시 가지 않고 PPT_MAX_EDITS까지라 끝나지 않는 반복은 없음.
    조작된 파일 방어(정상 파일은 닿지 않음): 쪽은 PPT_MAX_PAGES까지, 쪽 글은 PPT_PAGE_MAX_RAW_CHARS
    까지만 모으고, 쪽을 차례로 모으다 limit_pages 기준 전체 글이 SLIDES_MAX_CHARS를 넘으면 멈춤
    (둘 다 뒤쪽을 버렸다고 True). Slide 컨테이너는 위치마다 한 번만 읽고(여러 쪽이 같은 컨테이너를
    가리켜도) 모든 쪽을 합해 PPT_MAX_SLIDE_RECORDS 레코드까지. persist 표 항목은
    PPT_MAX_DIRECTORY_ENTRIES · PPT_MAX_PERSIST_ENTRIES까지. 슬라이드 목록 · PersistDirectoryAtom은
    최근 PPT_MAX_LISTS · PPT_MAX_EDITS개만 기억.
    """
    lists: deque[_SlideList] = deque(maxlen=PPT_MAX_LISTS)
    # PersistDirectoryAtom 본문 (시작, 끝). 뒤가 앞을 덮으므로 최근 것만
    directories: deque[tuple[int, int]] = deque(maxlen=PPT_MAX_EDITS)

    def walk(start: int, end: int, depth: int, top: int, slist: _SlideList | None) -> None:
        pos = start
        while pos < end:
            ver_inst, rec_type, body, nxt = _header(stream, pos, end)
            here = pos if depth == 0 else top
            if ver_inst & 0xF == CONTAINER_VER:
                if depth >= PPT_MAX_DEPTH:
                    raise _BrokenError
                if rec_type == SLIDE_LIST_WITH_TEXT:
                    if ver_inst >> 4 == 0:  # 슬라이드(1 마스터 · 2 메모는 건너뜀)
                        inner = _SlideList(here)
                        lists.append(inner)
                        walk(body, nxt, depth + 1, here, inner)
                else:
                    walk(body, nxt, depth + 1, here, slist)
            elif rec_type == PERSIST_DIRECTORY_ATOM:
                directories.append((body, nxt))
            elif slist is not None and not slist.cut:
                pages = slist.pages
                if rec_type == SLIDE_PERSIST_ATOM:
                    if len(pages) >= PPT_MAX_PAGES:
                        slist.cut = True  # 뒤 쪽과 그 글은 버림
                    else:
                        ref = struct.unpack_from("<I", stream, body)[0] if nxt - body >= 4 else None
                        pages.append(_ListPage(ref))
                elif pages and (left := PPT_PAGE_MAX_RAW_CHARS - pages[-1].chars) > 0:
                    if (text := _text_atom(stream, rec_type, body, nxt, left)) is not None:
                        pages[-1].parts.append(text)
                        pages[-1].chars += len(text)
            pos = nxt

    try:
        walk(0, len(stream), 0, 0, None)
    except _BrokenError:
        if not lists:
            raise SlidesError("parse") from None
        log.warning("ppt 레코드가 깨져 그 앞까지 읽음")
    if not lists:
        return [], False
    edits = _edit_chain(stream, current_user)
    if edits is not None:
        table, doc_ref = edits
        doc = table.get(doc_ref)
        chosen = next((s for s in reversed(lists) if s.top == doc), lists[-1])
    else:
        table = _scanned_table(stream, directories)
        chosen = lists[-1]
    containers = _SlideContainers(stream, table)
    texts: list[str] = []
    total = 0
    for page in chosen.pages:
        text = _page_text(page, containers)
        kept = len(clean(text)[:PAGE_MAX_CHARS])  # limit_pages와 같은 셈
        if total + kept > SLIDES_MAX_CHARS:
            return texts, True
        texts.append(text)
        total += kept
    return texts, chosen.cut


def _page_text(page: _ListPage, containers: "_SlideContainers") -> str:
    """목록 안 글 + 그 쪽 Slide 컨테이너 안 글(같은 글은 한 번). PPT_PAGE_MAX_RAW_CHARS까지."""
    parts = list(page.parts)
    size = page.chars
    if page.persist_ref is not None and size < PPT_PAGE_MAX_RAW_CHARS:
        seen = {clean(p) for p in parts}
        for text, key in containers.texts(page.persist_ref):
            if size >= PPT_PAGE_MAX_RAW_CHARS:
                break
            if key not in seen:
                parts.append(text)
                seen.add(key)
                size += len(text)
    return " ".join(parts)[:PPT_PAGE_MAX_RAW_CHARS]


class _SlideContainers:
    """persistId → Slide 컨테이너 안 글. 위치마다 한 번만 읽어 둠(여러 쪽이 같은 컨테이너를
    가리켜도 다시 읽지 않음). 읽는 레코드는 모든 위치를 합해 PPT_MAX_SLIDE_RECORDS까지."""

    def __init__(self, stream: bytes, table: dict[int, int]) -> None:
        self.stream = stream
        self.table = table
        self.records_left = PPT_MAX_SLIDE_RECORDS
        self.cache: dict[int, list[tuple[str, str]]] = {}

    def texts(self, persist_ref: int) -> list[tuple[str, str]]:
        """(글, 정리한 글) 목록. 빈 글 · 겹친 글은 뺌. 못 찾거나 깨졌으면 빈 목록."""
        offset = self.table.get(persist_ref)
        if offset is None:
            return []
        if offset not in self.cache:
            self.cache[offset] = self._read(offset)
        return self.cache[offset]

    def _read(self, offset: int) -> list[tuple[str, str]]:
        stream = self.stream
        out: list[tuple[str, str]] = []
        seen: set[str] = set()
        chars = 0

        def walk(start: int, end: int, depth: int) -> None:
            nonlocal chars
            pos = start
            while pos < end:
                if self.records_left <= 0:
                    log.warning("ppt 쪽 레코드가 너무 많아 남은 쪽은 목록 글만 씀")
                    raise _StopError
                self.records_left -= 1
                ver_inst, rec_type, body, nxt = _header(stream, pos, end)
                if ver_inst & 0xF == CONTAINER_VER:
                    if depth >= PPT_MAX_DEPTH:
                        raise _BrokenError
                    walk(body, nxt, depth + 1)
                elif (
                    text := _text_atom(stream, rec_type, body, nxt, PPT_PAGE_MAX_RAW_CHARS - chars)
                ) is not None:
                    key = clean(text)
                    if key and key not in seen:
                        out.append((text, key))
                        seen.add(key)
                        chars += len(text)
                        if chars >= PPT_PAGE_MAX_RAW_CHARS:
                            raise _StopError  # 이 쪽 글은 충분
                pos = nxt

        if self.records_left <= 0:
            return []
        try:
            self.records_left -= 1
            ver_inst, rec_type, body, nxt = _header(stream, offset, len(stream))
            if rec_type != SLIDE_CONTAINER or ver_inst & 0xF != CONTAINER_VER:
                return []
            walk(body, nxt, 1)
        except _BrokenError:
            log.warning("ppt 쪽 레코드가 깨져 목록 글만 씀")
            return []
        except _StopError:
            pass
        return out


def _directory_entries(
    stream: bytes, body: int, end: int, limit: int
) -> tuple[list[tuple[int, int]], int]:
    """PersistDirectoryAtom 본문 → ((persistId, 위치) 목록, 읽은 수). 항목: persistId 20비트 ·
    수 12비트, 위치들. 머리와 위치를 하나씩 세어 limit개까지만 읽고 나머지는 버림."""
    out: list[tuple[int, int]] = []
    used = 0
    pos = body
    while pos < end and used < limit:
        if end - pos < 4:
            raise _BrokenError
        entry = struct.unpack_from("<I", stream, pos)[0]
        first, count = entry & 0xFFFFF, entry >> 20
        pos += 4
        used += 1
        if end - pos < 4 * count:
            raise _BrokenError
        take = min(count, limit - used)
        offsets = struct.unpack_from(f"<{take}I", stream, pos)
        out += [(first + i, offset) for i, offset in enumerate(offsets)]
        used += take
        pos += 4 * count
    return out, used


def _edit_chain(stream: bytes, current_user: bytes | None) -> tuple[dict[int, int], int] | None:
    """Current User → UserEditAtom 사슬 → (persistId → 위치 표, 문서 persistId). 실패하면 None."""
    if current_user is None:
        return None
    try:
        _, rec_type, body, nxt = _header(current_user, 0, len(current_user))
        if rec_type != CURRENT_USER_ATOM or nxt - body < 12:
            return None
        offset = struct.unpack_from("<I", current_user, body + 8)[0]  # offsetToCurrentEdit
        table: dict[int, int] = {}
        doc_ref: int | None = None
        visited: set[int] = set()
        left = PPT_MAX_PERSIST_ENTRIES  # 사슬 전체 항목 수. 다 쓰면 더 옛 편집은 읽지 않음
        while len(visited) < PPT_MAX_EDITS and left > 0:
            if offset in visited:
                break  # 순환 사슬: 이미 읽은 편집
            visited.add(offset)
            _, rec_type, body, nxt = _header(stream, offset, len(stream))
            if rec_type != USER_EDIT_ATOM or nxt - body < USER_EDIT_MIN_BYTES:
                return None
            last_edit, directory, doc = struct.unpack_from("<III", stream, body + 8)
            if doc_ref is None:
                doc_ref = doc  # 가장 새 편집의 문서
            _, rec_type, d_body, d_end = _header(stream, directory, len(stream))
            if rec_type != PERSIST_DIRECTORY_ATOM:
                return None
            entries, used = _directory_entries(
                stream, d_body, d_end, min(left, PPT_MAX_DIRECTORY_ENTRIES)
            )
            left -= used
            for persist_id, at in entries:
                table.setdefault(persist_id, at)  # 새 편집이 먼저: 옛 값으로 덮지 않음
            if last_edit == 0:
                break
            offset = last_edit
    except _BrokenError:
        return None
    if doc_ref is None or not table:
        return None
    return table, doc_ref


def _scanned_table(stream: bytes, directories: deque[tuple[int, int]]) -> dict[int, int]:
    """스트림에 나온 PersistDirectoryAtom을 차례로(뒤가 앞을 덮음). 깨진 것은 건너뜀.
    뒤(새 것)부터 PPT_MAX_PERSIST_ENTRIES 항목까지 읽고 이미 있는 persistId는 덮지 않음."""
    table: dict[int, int] = {}
    left = PPT_MAX_PERSIST_ENTRIES
    for body, end in reversed(directories):
        if left <= 0:
            break
        try:
            entries, used = _directory_entries(
                stream, body, end, min(left, PPT_MAX_DIRECTORY_ENTRIES)
            )
        except _BrokenError:
            continue
        left -= used
        for persist_id, at in dict(entries).items():  # 한 표 안에서는 뒤 항목이 앞을 덮음
            table.setdefault(persist_id, at)
    return table
