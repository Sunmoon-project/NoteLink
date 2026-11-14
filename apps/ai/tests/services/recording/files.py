"""테스트용 강의 자료 파일을 테스트 안에서 만듭니다(바이너리를 저장소에 넣지 않음).

pptx  python-pptx로 만듦
ppt   [MS-PPT] 레코드 바이트(record · container)와, olefile이 읽는 최소 OLE(CFB v3) 파일(ole_file)
"""

import io
import math
import struct
from dataclasses import dataclass

from pptx import Presentation
from pptx.util import Inches

from app.services.recording.slides import (
    SLIDE_LIST_WITH_TEXT,
    SLIDE_PERSIST_ATOM,
    TEXT_BYTES_ATOM,
    TEXT_CHARS_ATOM,
)

DOCUMENT_CONTAINER = 0x03E8
SLIDE_CONTAINER = 0x03EE
PERSIST_DIRECTORY = 0x1772
USER_EDIT = 0x0FF5
CURRENT_USER = 0x0FF6
DOC_REF = 1
SECTOR = 512
MINI_CUTOFF = 4096
END_OF_CHAIN = 0xFFFFFFFE
FREE_SECT = 0xFFFFFFFF
FAT_SECT = 0xFFFFFFFD
NO_STREAM = 0xFFFFFFFF


def pptx_file(*slides: list[str], notes: str | None = None) -> bytes:
    """쪽마다 글 상자들. notes가 있으면 첫 쪽에 발표자 메모."""
    prs = Presentation()
    blank = prs.slide_layouts[6]
    for texts in slides:
        slide = prs.slides.add_slide(blank)
        for i, text in enumerate(texts):
            box = slide.shapes.add_textbox(Inches(1), Inches(1 + i), Inches(4), Inches(1))
            box.text_frame.text = text
    if notes is not None:
        prs.slides[0].notes_slide.notes_text_frame.text = notes
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


def pptx_with_table_and_group() -> bytes:
    """1쪽: 제목 자리 표시자 + 2×2 표, 2쪽: 그룹 안의 그룹 안 글 상자, 3쪽: 빈 쪽."""
    prs = Presentation()
    first = prs.slides.add_slide(prs.slide_layouts[5])  # 제목만
    first.shapes.title.text = "프로토콜 비교"
    table = first.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(4), Inches(2)).table
    for r, row in enumerate([["TCP", "연결형"], ["UDP", "비연결형"]]):
        for c, text in enumerate(row):
            table.cell(r, c).text = text
    second = prs.slides.add_slide(prs.slide_layouts[6])
    outer = second.shapes.add_group_shape()
    outer.shapes.add_textbox(Inches(1), Inches(1), Inches(2), Inches(1)).text_frame.text = "바깥"
    inner = outer.shapes.add_group_shape()
    inner.shapes.add_textbox(Inches(1), Inches(2), Inches(2), Inches(1)).text_frame.text = "안쪽"
    prs.slides.add_slide(prs.slide_layouts[6])
    out = io.BytesIO()
    prs.save(out)
    return out.getvalue()


# ---------------------------------------------------------------- ppt 레코드


def record(rec_type: int, body: bytes = b"", *, ver: int = 0, inst: int = 0) -> bytes:
    return struct.pack("<HHI", (inst << 4) | ver, rec_type, len(body)) + body


def container(rec_type: int, *children: bytes, inst: int = 0) -> bytes:
    return record(rec_type, b"".join(children), ver=0xF, inst=inst)


def chars(text: str) -> bytes:
    return record(TEXT_CHARS_ATOM, text.encode("utf-16-le"))


def latin(text: str) -> bytes:
    return record(TEXT_BYTES_ATOM, text.encode("latin-1"))


def persist() -> bytes:
    return record(SLIDE_PERSIST_ATOM, bytes(20))


def slide_list(*pages: list[bytes], inst: int = 0) -> bytes:
    return container(
        SLIDE_LIST_WITH_TEXT, *(persist() + b"".join(atoms) for atoms in pages), inst=inst
    )


def ppt_stream(*pages: list[bytes]) -> bytes:
    """보통 파일 모양: 문서 컨테이너 안에 마스터 · 슬라이드 · 메모 목록, 뒤에 슬라이드 컨테이너."""
    document = container(
        DOCUMENT_CONTAINER,
        slide_list([chars("마스터 제목")], inst=1),
        slide_list(*pages),
        slide_list([chars("발표자 메모")], inst=2),
    )
    drawing = container(SLIDE_CONTAINER, chars("목록 밖 글"))
    return document + drawing


# ---------------------------------------------------------------- 최소 OLE(CFB v3)


def _dir_entry(
    name: str, kind: int, *, child: int, start: int, size: int, left: int = NO_STREAM
) -> bytes:
    raw = (name + "\0").encode("utf-16-le") if name else b""
    return (
        raw.ljust(64, b"\0")
        + struct.pack("<HBB", len(raw), kind, 1)  # 이름 길이 · 종류 · 색(검정)
        + struct.pack("<III", left, NO_STREAM, child)
        + bytes(16 + 4 + 8 + 8)  # CLSID · 상태 · 만든 · 고친 시각
        + struct.pack("<IQ", start, size)
    )


def ole_file(
    stream: bytes, name: str = "PowerPoint Document", *, current_user: bytes | None = None
) -> bytes:
    """스트림 하나(와 'Current User')만 든 OLE 파일. 짧은 스트림은 작은 스트림(mini stream)이
    필요하므로 MINI_CUTOFF 이상으로 채움: 문서 스트림은 끝에 빈 레코드를, Current User는 0을
    붙임(앞의 레코드 읽기 · 오프셋에는 영향 없음)."""
    if len(stream) < MINI_CUTOFF:
        stream += record(0x0000, bytes(MINI_CUTOFF - len(stream)))
    streams = [(name, stream)]
    if current_user is not None:
        streams.append(("Current User", current_user.ljust(MINI_CUTOFF, b"\0")))
    sectors = [math.ceil(len(s) / SECTOR) for _, s in streams]
    n = sum(sectors)
    if n + 2 > SECTOR // 4:
        raise ValueError("테스트 도우미는 FAT 한 섹터(약 63KB)까지만")
    dir_sector, fat_sector = n, n + 1
    fat: list[int] = []
    starts: list[int] = []
    for count in sectors:
        starts.append(len(fat))
        fat += [len(fat) + i + 1 for i in range(count - 1)] + [END_OF_CHAIN]
    fat += [END_OF_CHAIN, FAT_SECT]
    fat += [FREE_SECT] * (SECTOR // 4 - len(fat))
    entries = _dir_entry("Root Entry", 5, child=1, start=END_OF_CHAIN, size=0)
    for i, ((stream_name, data), start) in enumerate(zip(streams, starts, strict=True)):
        left = i + 2 if i + 1 < len(streams) else NO_STREAM  # 다음 항목을 왼쪽 형제로
        entries += _dir_entry(
            stream_name, 2, child=NO_STREAM, start=start, size=len(data), left=left
        )
    entries += _dir_entry("", 0, child=NO_STREAM, start=0, size=0) * (3 - len(streams))
    body = b"".join(
        data.ljust(count * SECTOR, b"\0") for (_, data), count in zip(streams, sectors, strict=True)
    )
    header = (
        bytes.fromhex("D0CF11E0A1B11AE1")
        + bytes(16)
        + struct.pack("<HHHHH", 0x3E, 3, 0xFFFE, 9, 6)
        + bytes(6)
        + struct.pack("<IIII", 0, 1, dir_sector, 0)  # 디렉터리 섹터 수(v3는 0) · FAT 수 · ...
        + struct.pack("<IIIII", MINI_CUTOFF, END_OF_CHAIN, 0, END_OF_CHAIN, 0)
        + struct.pack("<I", fat_sector)
        + struct.pack("<I", FREE_SECT) * 108
    )
    assert len(header) == SECTOR
    return header + body + entries + struct.pack(f"<{SECTOR // 4}I", *fat)


# ---------------------------------------------------------------- persist 표가 있는 ppt


def slide_persist(ref: int) -> bytes:
    """SlidePersistAtom: persistIdRef · 플래그 · 글 수 · slideId · 예약."""
    return record(SLIDE_PERSIST_ATOM, struct.pack("<IIiII", ref, 0, 0, 256 + ref, 0))


def text_box(*atoms: bytes) -> bytes:
    """그림 레코드(OfficeArt) 속 텍스트 상자: 그림 → 도형 묶음 → 도형 → ClientTextbox."""
    return container(0xF002, container(0xF003, container(0xF004, container(0xF00D, *atoms))))


def slide_container(*boxes: bytes) -> bytes:
    return container(SLIDE_CONTAINER, record(0x03EF, bytes(24)), *boxes)


def persist_directory(table: dict[int, int]) -> bytes:
    """persistId마다 항목 하나(수 1)."""
    body = b"".join(struct.pack("<II", (1 << 20) | pid, at) for pid, at in table.items())
    return record(PERSIST_DIRECTORY, body)


def user_edit(*, last_edit: int, directory: int, doc_ref: int = DOC_REF) -> bytes:
    return record(
        USER_EDIT, struct.pack("<IHBBIIIIHH", 0, 0, 0, 3, last_edit, directory, doc_ref, 99, 1, 0)
    )


def current_user(edit_offset: int) -> bytes:
    return record(
        CURRENT_USER, struct.pack("<IIIHHBBH", 0x14, 0xE391C05F, edit_offset, 0, 0x3F4, 3, 0, 0)
    )


@dataclass
class PptDoc:
    """persist 표 · 편집 사슬이 있는 문서 스트림. offsets는 persistId → 위치."""

    stream: bytes
    offsets: dict[int, int]
    edit: int  # 마지막 UserEditAtom 위치

    def current_user(self) -> bytes:
        return current_user(self.edit)

    def ole(self, *, with_current_user: bool = True) -> bytes:
        return ole_file(
            self.stream, current_user=self.current_user() if with_current_user else None
        )


def ppt_document(*pages: tuple[list[bytes], bytes]) -> PptDoc:
    """쪽마다 (목록 안 글 원자들, Slide 컨테이너). 문서 persistId는 DOC_REF, 쪽은 2부터.

    [문서 컨테이너(마스터 · 슬라이드 · 메모 목록)][Slide 컨테이너들][PersistDirectory][UserEdit]
    """
    refs = [DOC_REF + 1 + i for i in range(len(pages))]
    listing = container(
        SLIDE_LIST_WITH_TEXT,
        *(
            slide_persist(ref) + b"".join(atoms)
            for ref, (atoms, _) in zip(refs, pages, strict=True)
        ),
    )
    document = container(
        DOCUMENT_CONTAINER,
        slide_list([chars("마스터 제목")], inst=1),
        listing,
        slide_list([chars("발표자 메모")], inst=2),
    )
    stream = document
    offsets = {DOC_REF: 0}
    for ref, (_, slide) in zip(refs, pages, strict=True):
        offsets[ref] = len(stream)
        stream += slide
    directory = len(stream)
    stream += persist_directory(offsets)
    edit = len(stream)
    stream += user_edit(last_edit=0, directory=directory)
    return PptDoc(stream, offsets, edit)


def fast_save(doc: PptDoc, replaced: dict[int, bytes], *, last_edit: int | None = None) -> PptDoc:
    """빠른 저장: 바뀐 레코드를 끝에 붙이고 새 PersistDirectory · UserEdit(앞 편집을 가리킴)."""
    stream = doc.stream
    offsets = dict(doc.offsets)
    new: dict[int, int] = {}
    for ref, data in replaced.items():
        new[ref] = offsets[ref] = len(stream)
        stream += data
    directory = len(stream)
    stream += persist_directory(new)
    edit = len(stream)
    previous = doc.edit if last_edit is None else last_edit
    stream += user_edit(last_edit=previous, directory=directory)
    return PptDoc(stream, offsets, edit)
