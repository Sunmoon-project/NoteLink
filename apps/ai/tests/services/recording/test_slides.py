"""강의 자료(PPT) 글 뽑기(FR-23). 파일은 테스트 안에서 만듦(files.py)."""

import io
import struct
import time
import zipfile

import pytest

from app.clients.docint import TOO_LARGE, DownloadError
from app.services.recording import slides
from app.services.recording.slides import (
    PAGE_MAX_CHARS,
    PPT_MAX_DEPTH,
    PPT_MAX_DIRECTORY_ENTRIES,
    PPT_MAX_PAGES,
    PPT_PAGE_MAX_RAW_CHARS,
    SLIDE_LIST_WITH_TEXT,
    SLIDES_MAX_BYTES,
    SLIDES_MAX_CHARS,
    SLIDES_MAX_UNZIPPED_BYTES,
    SlidesError,
    clean,
    limit_pages,
    ppt_read,
    ppt_slide_texts,
    read_slides,
    slide_texts,
)
from tests.services.recording.files import (
    DOC_REF,
    PERSIST_DIRECTORY,
    SLIDE_CONTAINER,
    PptDoc,
    chars,
    container,
    current_user,
    fast_save,
    latin,
    ole_file,
    persist,
    persist_directory,
    ppt_document,
    ppt_stream,
    pptx_file,
    pptx_repeating,
    pptx_with_table_and_group,
    record,
    slide_container,
    slide_list,
    slide_persist,
    text_box,
    user_edit,
)

URL = "https://blob.example.test/s.pptx?sig=secret-sas"


class Fetch:
    """가짜 내려받기. 받은 주소를 모아 둠."""

    def __init__(self, answer: bytes | Exception) -> None:
        self.answer = answer
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


# ---------- pptx ----------


def test_pptx_pages_follow_slide_order_and_skip_empty_ones() -> None:
    data = pptx_file(["첫 제목", "첫 본문"], [], ["셋째\n줄바꿈   공백"])

    pages, warnings = read_slides(URL, Fetch(data))

    assert pages == [
        {"pageNo": 1, "text": "첫 제목 첫 본문"},
        {"pageNo": 3, "text": "셋째 줄바꿈 공백"},
    ]
    assert warnings == []


def test_pptx_reads_placeholders_tables_and_nested_groups() -> None:
    assert slide_texts(pptx_with_table_and_group()) == [
        "프로토콜 비교 TCP 연결형 UDP 비연결형",
        "바깥 안쪽",
        "",
    ]


def test_pptx_speaker_notes_are_not_used() -> None:
    texts = slide_texts(pptx_file(["본문"], notes="발표자만 보는 메모"))

    assert texts == ["본문"]


def test_zip_that_is_not_a_presentation_is_a_parse_warning() -> None:
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("hello.txt", "안녕")

    assert read_slides(URL, Fetch(out.getvalue())) == (
        [],
        [{"code": "NO_SLIDES", "reason": "parse"}],
    )


def test_broken_zip_is_a_parse_warning() -> None:
    data = pptx_file(["본문"])[:200]

    assert read_slides(URL, Fetch(data))[1] == [{"code": "NO_SLIDES", "reason": "parse"}]


def test_zip_that_unpacks_too_large_is_a_size_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.recording import slides

    data = pptx_file(["본문"])
    unzipped = sum(i.file_size for i in zipfile.ZipFile(io.BytesIO(data)).infolist())
    monkeypatch.setattr(slides, "SLIDES_MAX_UNZIPPED_BYTES", unzipped - 1)

    assert read_slides(URL, Fetch(data))[1] == [{"code": "NO_SLIDES", "reason": "size"}]
    assert unzipped < SLIDES_MAX_UNZIPPED_BYTES


# ---------- 형식 · 내려받기 ----------


@pytest.mark.parametrize(
    "data",
    [b"", b"%PDF-1.7 ...", b"<html>", "슬라이드".encode()],
    ids=["empty", "pdf", "html", "text"],
)
def test_other_formats_are_warnings_not_errors(data: bytes) -> None:
    assert read_slides(URL, Fetch(data)) == ([], [{"code": "NO_SLIDES", "reason": "format"}])


def test_format_is_decided_by_first_bytes_not_by_extension() -> None:
    ppt = ole_file(ppt_stream([chars("옛 형식")]))

    pages, _ = read_slides("https://blob.example.test/s.pptx?sig=x", Fetch(ppt))

    assert pages == [{"pageNo": 1, "text": "옛 형식"}]


@pytest.mark.parametrize(
    ("message", "reason"),
    [("HTTP 403", "download"), ("시간 초과", "download"), (TOO_LARGE, "size")],
)
def test_download_failure_is_a_warning_without_the_address(
    caplog: pytest.LogCaptureFixture, message: str, reason: str
) -> None:
    pages, warnings = read_slides(URL, Fetch(DownloadError(message)))

    assert (pages, warnings) == ([], [{"code": "NO_SLIDES", "reason": reason}])
    assert "secret-sas" not in caplog.text


def test_bytes_over_the_limit_are_a_size_warning() -> None:
    data = b"PK\x03\x04" + bytes(SLIDES_MAX_BYTES)

    assert read_slides(URL, Fetch(data))[1] == [{"code": "NO_SLIDES", "reason": "size"}]


def test_presentation_without_text_is_an_empty_warning() -> None:
    assert read_slides(URL, Fetch(pptx_file([], []))) == (
        [],
        [{"code": "NO_SLIDES", "reason": "empty"}],
    )


# ---------- 상한 ----------


def test_each_page_is_cut_and_total_is_limited_with_warning() -> None:
    long_page = "가" * (PAGE_MAX_CHARS + 50)
    count = SLIDES_MAX_CHARS // PAGE_MAX_CHARS + 3

    pages, trimmed = limit_pages([long_page] * count)

    assert all(len(p["text"]) == PAGE_MAX_CHARS for p in pages)
    assert sum(len(p["text"]) for p in pages) <= SLIDES_MAX_CHARS
    assert len(pages) == SLIDES_MAX_CHARS // PAGE_MAX_CHARS
    assert trimmed


def test_trimmed_pages_give_a_warning_with_the_kept_pages() -> None:
    data = pptx_file(
        *(["가" * PAGE_MAX_CHARS] for _ in range(SLIDES_MAX_CHARS // PAGE_MAX_CHARS + 1))
    )

    pages, warnings = read_slides(URL, Fetch(data))

    assert len(pages) == SLIDES_MAX_CHARS // PAGE_MAX_CHARS
    assert warnings == [{"code": "MATERIAL_TRIMMED", "reason": "slides"}]


# ---------- ppt(옛 형식) ----------


def test_ppt_uses_only_the_slide_list_and_splits_pages_at_persist_atoms() -> None:
    stream = ppt_stream(
        [chars("제목"), chars("본문\r둘째 줄\x0b")],
        [],
        [latin("Caf\xe9 TCP")],
    )

    # 마스터(1) · 메모(2) 목록과 목록 밖(슬라이드 컨테이너) 글은 쓰지 않음
    assert ppt_slide_texts(stream) == ["제목 본문\r둘째 줄\x0b", "", "Caf\xe9 TCP"]
    assert slide_texts(ole_file(stream)) == ["제목 본문\r둘째 줄\x0b", "", "Caf\xe9 TCP"]


def test_ppt_text_bytes_are_low_bytes_of_utf16() -> None:
    # TextBytesAtom: 글자마다 UTF-16 아래 바이트(위 바이트 0). 0x80~0x9F도 cp1252가 아니라 그 코드
    stream = slide_list([record(0x0FA8, bytes([0x41, 0x93, 0xE9]))])

    assert ppt_slide_texts(stream) == ["A\x93\xe9"]


def test_ppt_pages_through_read_slides() -> None:
    data = ole_file(ppt_stream([chars("첫 쪽")], [chars("  ")], [chars("셋째 쪽")]))

    assert read_slides(URL, Fetch(data)) == (
        [{"pageNo": 1, "text": "첫 쪽"}, {"pageNo": 3, "text": "셋째 쪽"}],
        [],
    )


def test_text_before_first_persist_atom_is_ignored() -> None:
    stream = container(0x0FF0, chars("떠 있는 글"), persist(), chars("쪽 글"))

    assert ppt_slide_texts(stream) == ["쪽 글"]


def test_odd_length_utf16_keeps_whole_characters() -> None:
    body = "가나".encode("utf-16-le") + b"\x00"

    assert ppt_slide_texts(slide_list([record(0x0FA0, body)])) == ["가나"]


def test_fast_saved_file_uses_the_last_slide_list() -> None:
    stream = slide_list([chars("옛 글")]) + slide_list([chars("새 글")], [chars("둘째")])

    assert ppt_slide_texts(stream) == ["새 글", "둘째"]


def test_stream_without_slide_list_has_no_pages() -> None:
    stream = container(SLIDE_CONTAINER, chars("목록 밖"))

    assert ppt_slide_texts(stream) == []
    assert read_slides(URL, Fetch(ole_file(stream)))[1] == [
        {"code": "NO_SLIDES", "reason": "empty"}
    ]


@pytest.mark.parametrize(
    "stream",
    [
        struct.pack("<HHI", 0x0F, 0x03E8, 1_000_000),  # 길이가 스트림을 넘음
        record(0x03E8, b"abc")[:6],  # 헤더가 잘림
        container(0x03E8, b"\x0f\x00"),  # 컨테이너 안 헤더가 잘림
        container(0x03E8, record(0x0FA0, b"ab"))[:-1],  # 안쪽 길이가 바깥을 넘음
    ],
    ids=["too-long", "cut-header", "cut-inner-header", "inner-over-outer"],
)
def test_broken_ppt_records_end_with_parse_error_not_a_hang(stream: bytes) -> None:
    with pytest.raises(SlidesError) as e:
        ppt_slide_texts(stream)
    assert e.value.reason == "parse"


def test_broken_ppt_file_is_a_parse_warning() -> None:
    data = ole_file(struct.pack("<HHI", 0x0F, 0x03E8, 1_000_000))

    assert read_slides(URL, Fetch(data)) == ([], [{"code": "NO_SLIDES", "reason": "parse"}])


def test_records_broken_after_the_slide_list_keep_what_was_read() -> None:
    stream = slide_list([chars("읽은 쪽")]) + struct.pack("<HHI", 0, 0x0FA0, 99)

    assert ppt_slide_texts(stream) == ["읽은 쪽"]


def test_too_deep_containers_stop_without_recursion_error() -> None:
    stream = b""
    for _ in range(PPT_MAX_DEPTH + 5):
        stream = container(0x1772, stream)

    with pytest.raises(SlidesError):
        ppt_slide_texts(stream)


def test_many_empty_records_finish() -> None:
    stream = slide_list([chars("끝")]) + record(0x0000) * 50_000

    assert ppt_slide_texts(stream) == ["끝"]


def test_ole_file_that_is_not_powerpoint_is_a_format_warning() -> None:
    data = ole_file(b"\0" * 10, name="WordDocument")

    assert read_slides(URL, Fetch(data))[1] == [{"code": "NO_SLIDES", "reason": "format"}]


def test_broken_ole_container_is_a_parse_warning() -> None:
    data = ole_file(ppt_stream([chars("본문")]))[:700]

    assert read_slides(URL, Fetch(data))[1] == [{"code": "NO_SLIDES", "reason": "parse"}]


# ---------- ppt: persist 표로 Slide 컨테이너 안 텍스트 상자 ----------


def patch_u32(data: bytes, at: int, value: int) -> bytes:
    return data[:at] + struct.pack("<I", value) + data[at + 4 :]


def boxes_doc() -> PptDoc:
    """1쪽: 자리 표시자(목록 · 쪽 양쪽) + 텍스트 상자, 2쪽: 텍스트 상자만(목록에 글 없음)."""
    return ppt_document(
        ([chars("제목")], slide_container(text_box(chars("제목")), text_box(chars("상자 글")))),
        ([], slide_container(text_box(chars("상자만 있는 쪽")), text_box(latin("Box")))),
    )


def test_text_boxes_in_slide_containers_are_read_through_the_edit_chain() -> None:
    doc = boxes_doc()

    assert slide_texts(doc.ole()) == ["제목 상자 글", "상자만 있는 쪽 Box"]


def test_placeholder_text_in_both_places_appears_once() -> None:
    doc = ppt_document(
        ([chars("같은 제목"), chars("본문")], slide_container(text_box(chars("같은  제목\r")))),
    )

    assert ppt_slide_texts(doc.stream, doc.current_user()) == ["같은 제목 본문"]


def test_text_box_only_page_through_read_slides() -> None:
    pages, warnings = read_slides(URL, Fetch(boxes_doc().ole()))

    assert pages == [
        {"pageNo": 1, "text": "제목 상자 글"},
        {"pageNo": 2, "text": "상자만 있는 쪽 Box"},
    ]
    assert warnings == []


def test_page_order_follows_the_slide_list_not_the_stream() -> None:
    doc = ppt_document(
        ([], slide_container(text_box(chars("첫째")))),
        ([], slide_container(text_box(chars("둘째")))),
    )
    # 2쪽 컨테이너를 빠른 저장으로 1쪽보다 뒤에 다시 씀(스트림 순서와 쪽 순서가 다름)
    first = DOC_REF + 1
    saved = fast_save(doc, {first: slide_container(text_box(chars("고친 첫째")))})

    assert slide_texts(saved.ole()) == ["고친 첫째", "둘째"]


def test_without_current_user_stream_the_scanned_persist_table_is_used() -> None:
    doc = fast_save(boxes_doc(), {DOC_REF + 2: slide_container(text_box(chars("새 상자")))})

    # 뒤에 나온 PersistDirectory가 앞을 덮음(빠른 저장)
    assert slide_texts(doc.ole(with_current_user=False)) == ["제목 상자 글", "새 상자"]


def test_edit_chain_ignores_directories_it_does_not_reach() -> None:
    doc = boxes_doc()
    stale = len(doc.stream)
    stream = doc.stream + slide_container(text_box(chars("버린 상자")))
    stream += persist_directory({DOC_REF + 2: stale})  # 어느 편집에도 없는 표(저장 중단 등)

    assert ppt_slide_texts(stream, doc.current_user()) == ["제목 상자 글", "상자만 있는 쪽 Box"]
    assert ppt_slide_texts(stream) == ["제목 상자 글", "버린 상자"]  # 정식 사슬이 없으면 훑은 표


def test_current_edit_decides_which_document_and_slide_list() -> None:
    doc = boxes_doc()
    newer_document = container(
        0x03E8,
        slide_list([chars("새 문서 쪽")]),  # 저장하다 만 새 문서(현재 편집이 아님)
    )
    saved = fast_save(doc, {DOC_REF: newer_document})

    assert ppt_slide_texts(saved.stream, doc.current_user()) == [
        "제목 상자 글",
        "상자만 있는 쪽 Box",
    ]
    assert ppt_slide_texts(saved.stream, saved.current_user()) == ["새 문서 쪽"]


def test_cyclic_edit_chain_ends() -> None:
    doc = boxes_doc()
    saved = fast_save(doc, {DOC_REF + 2: slide_container(text_box(chars("새 상자")))})
    # 첫 편집의 offsetLastEdit가 둘째 편집을 가리킴: 둘째 → 첫째 → 둘째 …
    stream = patch_u32(saved.stream, doc.edit + 8 + 8, saved.edit)

    assert ppt_slide_texts(stream, saved.current_user()) == ["제목 상자 글", "새 상자"]


def test_self_pointing_edit_ends() -> None:
    doc = boxes_doc()
    stream = patch_u32(doc.stream, doc.edit + 8 + 8, doc.edit)

    assert ppt_slide_texts(stream, doc.current_user()) == ["제목 상자 글", "상자만 있는 쪽 Box"]


@pytest.mark.parametrize(
    "where",
    ["outside", "not-a-slide", "middle-of-record"],
)
def test_bad_slide_offset_falls_back_to_slide_list_text(where: str) -> None:
    doc = boxes_doc()
    second = DOC_REF + 2
    bad = {
        "outside": len(doc.stream) + 10_000,
        "not-a-slide": doc.offsets[DOC_REF],  # 문서 컨테이너
        "middle-of-record": doc.offsets[second] + 3,
    }[where]
    directory = len(doc.stream)
    stream = doc.stream + persist_directory({second: bad})  # 새 편집이 2쪽 위치를 잘못 씀
    edit = len(stream)
    stream += user_edit(last_edit=doc.edit, directory=directory)

    texts = ppt_slide_texts(stream, current_user(edit))

    assert texts == ["제목 상자 글", ""]  # 2쪽은 목록 안 글(없음)만


def test_broken_slide_container_falls_back_for_that_page_only() -> None:
    broken = struct.pack("<HHI", 0x0F, 0x03EE, 20) + container(0xF002, chars("깨진"))[:10]
    doc = ppt_document(
        ([chars("목록 글")], slide_container(text_box(chars("상자")))),
        ([chars("둘째 목록")], broken + bytes(30)),
    )

    assert ppt_slide_texts(doc.stream, doc.current_user()) == ["목록 글 상자", "둘째 목록"]


@pytest.mark.parametrize(
    "user",
    [
        b"",
        b"\x00" * 3,
        record(0x0FF5, bytes(20)),  # 다른 레코드
        current_user(10**9),  # 스트림 밖
        current_user(0),  # UserEditAtom이 아닌 곳(문서 컨테이너)
    ],
    ids=["empty", "short", "wrong-record", "outside", "not-an-edit"],
)
def test_broken_current_user_falls_back_to_scanned_table(user: bytes) -> None:
    doc = boxes_doc()

    assert ppt_slide_texts(doc.stream, user) == ["제목 상자 글", "상자만 있는 쪽 Box"]


def test_broken_persist_directories_fall_back_to_slide_list_text() -> None:
    doc = ppt_document(
        ([chars("목록 글")], slide_container(text_box(chars("상자")))),
    )
    # 표 항목 수(12비트)가 본문보다 많음: 정식 사슬도, 훑은 표도 못 씀
    directory = doc.stream.index(struct.pack("<HH", 0, PERSIST_DIRECTORY))
    stream = patch_u32(doc.stream, directory + 8, (4095 << 20) | DOC_REF)

    assert ppt_slide_texts(stream, doc.current_user()) == ["목록 글"]
    assert ppt_slide_texts(stream) == ["목록 글"]


def test_text_outside_any_slide_container_is_not_used() -> None:
    # 기존 ppt_stream: 목록 밖 Slide 컨테이너는 persist 표가 가리키지 않아 쓰지 않음
    assert ppt_slide_texts(ppt_stream([chars("쪽")])) == ["쪽"]


# ---------- ppt: 조작된 파일의 시간 · 메모리 상한 ----------

FAST_SECONDS = 1.0  # 상한이 있으면 수십 ms. 상한이 없을 때(리뷰 실측)는 수 초 · 수백 MB


def kept_chars(texts: list[str]) -> int:
    """limit_pages가 세는 글자 수 합."""
    return sum(len(clean(t)[:PAGE_MAX_CHARS]) for t in texts)


def shared_container_stream(pages: int, slide: bytes) -> bytes:
    """쪽 pages개가 모두 같은 Slide 컨테이너(persistId 2) 하나를 가리킴. 표는 스트림에 나온 것."""
    listing = container(SLIDE_LIST_WITH_TEXT, *(slide_persist(2) for _ in range(pages)))
    document = container(0x03E8, listing)
    return document + slide + persist_directory({2: len(document)})


def test_pages_over_the_limit_are_cut() -> None:
    pages = [[latin("p")]] * PPT_MAX_PAGES + [[latin("dropped")]] * 3
    stream = slide_list(*pages)

    texts, cut = ppt_read(stream)

    assert len(texts) == PPT_MAX_PAGES
    assert "dropped" not in texts[-1]  # 버린 쪽 글이 마지막 쪽에 붙지 않음
    assert cut


def test_page_cut_gives_the_trimmed_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(slides, "PPT_MAX_PAGES", 2)
    data = ole_file(ppt_stream([chars("일")], [chars("이")], [chars("삼")]))

    assert read_slides(URL, Fetch(data)) == (
        [{"pageNo": 1, "text": "일"}, {"pageNo": 2, "text": "이"}],
        [{"code": "MATERIAL_TRIMMED", "reason": "slides"}],
    )


def test_long_page_text_is_collected_only_up_to_the_limit() -> None:
    doc = ppt_document(
        (
            [chars("가" * 50_000), *[chars("x")] * 20_000],
            slide_container(text_box(latin("b" * 200_000))),
        ),
        ([latin("y")] * 20_000, slide_container(*[text_box(latin(f"{i}")) for i in range(5000)])),
    )

    texts = ppt_slide_texts(doc.stream, doc.current_user())

    assert [len(t) for t in texts] == [PPT_PAGE_MAX_RAW_CHARS, PPT_PAGE_MAX_RAW_CHARS]
    assert texts[0].startswith("가" * PAGE_MAX_CHARS)


def test_many_pages_sharing_one_big_container_stop_at_the_total_limit() -> None:
    # 리뷰 실측 상황: 글 200KB 컨테이너 하나를 쪽 2,000개가 가리킴(상한 없으면 약 400MB 문자열)
    stream = shared_container_stream(2000, slide_container(text_box(latin("a" * 200_000))))

    start = time.perf_counter()
    texts, cut = ppt_read(stream)

    assert time.perf_counter() - start < FAST_SECONDS
    assert cut  # 전체 상한을 넘어 뒤쪽을 버림 → MATERIAL_TRIMMED
    assert len(texts) == SLIDES_MAX_CHARS // PAGE_MAX_CHARS
    assert kept_chars(texts) <= SLIDES_MAX_CHARS
    assert all(len(t) <= PPT_PAGE_MAX_RAW_CHARS for t in texts)
    assert len(limit_pages(texts)[0]) == len(texts)  # 같은 셈이라 쪽을 더 버리지 않음


def test_many_pages_sharing_a_container_of_many_records_finish() -> None:
    # 글은 없고 레코드만 많은 컨테이너: 위치마다 한 번만 읽음
    slide = container(SLIDE_CONTAINER, record(0x0000) * 100_000, chars("끝"))
    stream = shared_container_stream(2000, slide)

    start = time.perf_counter()
    texts, cut = ppt_read(stream)

    assert time.perf_counter() - start < FAST_SECONDS
    assert texts == ["끝"] * 2000
    assert not cut


def test_slide_record_budget_is_shared_by_all_pages(monkeypatch: pytest.MonkeyPatch) -> None:
    # Slide 컨테이너 하나 = 레코드 7개(컨테이너 · SlideAtom · 그림 4단 · 글)
    monkeypatch.setattr(slides, "PPT_MAX_SLIDE_RECORDS", 7)
    doc = ppt_document(
        *(([chars(f"목록{i}")], slide_container(text_box(chars(f"상자{i}")))) for i in (1, 2, 3))
    )

    assert ppt_slide_texts(doc.stream, doc.current_user()) == ["목록1 상자1", "목록2", "목록3"]


def big_directory(megabytes: int) -> bytes:
    """항목마다 수 4095(가장 큼)를 되풀이한 큰 PersistDirectoryAtom."""
    entry = struct.pack("<I", 100 | (4095 << 20)) + bytes(4 * 4095)
    return record(PERSIST_DIRECTORY, entry * (megabytes * 1024 * 1024 // len(entry)))


@pytest.mark.parametrize("with_edit", [False, True], ids=["scanned", "edit-chain"])
def test_big_persist_directory_finishes(with_edit: bool) -> None:
    # 리뷰 실측 상황: 40MB 디렉터리(상한 없으면 15.7초 · 약 990MB)
    stream = slide_list([chars("쪽")]) + big_directory(40)
    user = None
    if with_edit:
        user = current_user(len(stream))
        stream += user_edit(last_edit=0, directory=len(slide_list([chars("쪽")])))

    start = time.perf_counter()
    texts = ppt_slide_texts(stream, user)

    assert time.perf_counter() - start < FAST_SECONDS
    assert texts == ["쪽"]


@pytest.mark.parametrize(
    ("junk_first", "expected"), [(False, ["목록 상자"]), (True, ["목록"])], ids=["in", "over"]
)
def test_directory_entries_over_the_limit_are_not_used(
    junk_first: bool, expected: list[str]
) -> None:
    listing = container(SLIDE_LIST_WITH_TEXT, slide_persist(2), chars("목록"))
    document = container(0x03E8, listing)
    slide = slide_container(text_box(chars("상자")))
    real = struct.pack("<II", (1 << 20) | 2, len(document))
    # 머리 · 위치를 합쳐 PPT_MAX_DIRECTORY_ENTRIES를 넘는 쓸모없는 항목
    junk = (struct.pack("<I", 100 | (4095 << 20)) + bytes(4 * 4095)) * (
        PPT_MAX_DIRECTORY_ENTRIES // 4096 + 1
    )
    body = junk + real if junk_first else real + junk
    stream = document + slide + record(PERSIST_DIRECTORY, body)

    assert ppt_slide_texts(stream) == expected


def test_edit_chain_reads_entries_only_up_to_the_total_limit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    doc = fast_save(boxes_doc(), {3: slide_container(text_box(chars("새 상자")))})
    assert ppt_slide_texts(doc.stream, doc.current_user()) == ["제목 상자 글", "새 상자"]

    # 새 편집의 표(머리 1 + 위치 1)만 읽고 옛 편집(1 · 2쪽 위치)은 읽지 않음
    monkeypatch.setattr(slides, "PPT_MAX_PERSIST_ENTRIES", 2)

    assert ppt_slide_texts(doc.stream, doc.current_user()) == ["제목", "새 상자"]


def test_many_slide_lists_and_directories_finish() -> None:
    # 빈 슬라이드 목록 · 빈 PersistDirectoryAtom 10만 개씩: 최근 것만 기억
    stream = (
        container(SLIDE_LIST_WITH_TEXT) * 100_000
        + record(PERSIST_DIRECTORY) * 100_000
        + slide_list([chars("끝")])
    )

    start = time.perf_counter()
    texts = ppt_slide_texts(stream)

    assert time.perf_counter() - start < FAST_SECONDS
    assert texts == ["끝"]


# ---------- pptx 상한 (Codex 리뷰 #412) ----------


def test_pptx_pointing_at_one_big_page_many_times_finishes_within_limits() -> None:
    # 큰 쪽 파일 하나를 쪽 목록이 5,000번 가리킴: 모두 모은 뒤 자르면 1억 자 · 수 초
    data = pptx_repeating("가 " * 10_000, 5_000)

    start = time.perf_counter()
    texts, cut = slides.pptx_texts(data)

    assert time.perf_counter() - start < FAST_SECONDS
    assert cut
    assert len(texts) == SLIDES_MAX_CHARS // PAGE_MAX_CHARS
    assert all(len(t) <= PPT_PAGE_MAX_RAW_CHARS for t in texts)
    assert kept_chars(texts) <= SLIDES_MAX_CHARS


def test_pptx_pages_beyond_the_page_limit_are_dropped() -> None:
    texts, cut = slides.pptx_texts(pptx_repeating("", PPT_MAX_PAGES + 5))
    assert cut
    assert len(texts) == PPT_MAX_PAGES


def test_a_page_cut_to_the_page_limit_is_reported() -> None:
    pages, trimmed = limit_pages(["가" * (PAGE_MAX_CHARS + 1)])
    assert len(pages[0]["text"]) == PAGE_MAX_CHARS
    assert trimmed
    assert limit_pages(["가" * PAGE_MAX_CHARS]) == (
        [{"pageNo": 1, "text": "가" * PAGE_MAX_CHARS}],
        False,
    )
