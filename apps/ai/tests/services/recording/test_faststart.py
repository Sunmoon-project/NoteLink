import struct

import pytest
from azure.core.exceptions import HttpResponseError, ServiceRequestError

from app.clients import audio_store
from app.clients.audio_store import (
    AudioUnavailableError,
    BlobAudioStore,
    Bytes,
    Copy,
    Part,
    Range,
)
from app.clients.speech import SpeechUnavailableError, Transcript
from app.services.recording.faststart import (
    FaststartSpeech,
    NotFixableError,
    fixed_moov,
    plan,
    top_atoms,
)


def box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(body), kind) + body


def big_box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I4sQ", 1, kind, 16 + len(body)) + body


def mp4(
    moov_first: bool,
    *,
    co64: bool = False,
    big_mdat: bool = False,
    free: bool = False,
    moov_head: str = "",
    chunks: int = 3,
) -> tuple[bytes, list[bytes]]:
    """작은 MP4와 소리 조각들. moov 안 위치표는 실제 조각 위치를 가리킴.

    moov_head: big은 64비트 크기 머리, zero는 크기 칸 0(파일 끝까지, moov가 끝일 때만).
    """
    pieces = [bytes([65 + i]) * (10 + i) for i in range(chunks)]
    payload = b"".join(pieces)
    width = 8 if co64 else 4

    def moov(offsets: list[int]) -> bytes:
        fmt = ">Q" if co64 else ">I"
        table = struct.pack(">II", 0, len(offsets)) + b"".join(struct.pack(fmt, o) for o in offsets)
        stbl = box(b"stbl", box(b"stsd", b"\0" * 8) + box(b"co64" if co64 else b"stco", table))
        body = box(b"mvhd", b"\0" * 20) + box(b"trak", box(b"mdia", box(b"minf", stbl)))
        if moov_head == "big":
            return big_box(b"moov", body)
        if moov_head == "zero" and not moov_first:
            return struct.pack(">I4s", 0, b"moov") + body
        return box(b"moov", body)

    ftyp = box(b"ftyp", b"M4A \0\0\0\0M4A isom")
    moov_size = len(moov([0] * chunks))
    head = 16 if big_mdat else 8
    extra = box(b"free", b"\0" * 5) if free else b""
    if moov_first:
        mdat_at = len(ftyp) + moov_size + len(extra)
    else:
        mdat_at = len(ftyp) + len(extra)
    offsets, at = [], mdat_at + head
    for p in pieces:
        offsets.append(at)
        at += len(p)
    mdat = (big_box if big_mdat else box)(b"mdat", payload)
    m = moov(offsets)
    assert len(m) == moov_size and width in (4, 8)
    data = ftyp + m + extra + mdat if moov_first else ftyp + extra + mdat + m
    return data, pieces


class FakeStore:
    def __init__(self, files: dict[str, bytes]) -> None:
        self.files = files
        self.copies: list[list[Part]] = []
        self.deleted: list[str] = []
        self.fail_copy: Exception | None = None
        self.fail_delete: Exception | None = None

    def size(self, url: str) -> int:
        return len(self.files[url])

    def read(self, url: str, start: int, length: int) -> bytes:
        return self.files[url][start : start + length]

    def copy(self, source_url: str, parts: list[Part]) -> Copy:
        if self.fail_copy:
            raise self.fail_copy
        self.copies.append(parts)
        src = self.files[source_url]
        out = b"".join(
            p.data if isinstance(p, Bytes) else src[p.start : p.start + p.length] for p in parts
        )
        name = f"copy-{len(self.copies)}"
        self.files[name] = out
        return Copy(name, name)

    def delete(self, name: str) -> None:
        if self.fail_delete:
            raise self.fail_delete
        self.deleted.append(name)


def build(store: FakeStore, url: str) -> bytes | None:
    parts = plan(store, url)
    if parts is None:
        return None
    src = store.files[url]
    return b"".join(
        p.data if isinstance(p, Bytes) else src[p.start : p.start + p.length] for p in parts
    )


def chunk_offsets(data: bytes) -> list[int]:
    for kind, width, fmt in ((b"stco", 4, ">I"), (b"co64", 8, ">Q")):
        at = data.find(kind)
        if at > 0:
            n = struct.unpack(">I", data[at + 8 : at + 12])[0]
            return [
                struct.unpack(fmt, data[at + 12 + width * k : at + 12 + width * (k + 1)])[0]
                for k in range(n)
            ]
    raise AssertionError("위치표 없음")


@pytest.mark.parametrize(
    "shape",
    [
        {},
        {"co64": True},
        {"big_mdat": True},
        {"free": True},
        {"co64": True, "big_mdat": True, "free": True},
    ],
)
def test_moving_moov_to_the_front_gives_the_file_built_that_way(shape: dict[str, bool]) -> None:
    back, pieces = mp4(False, **shape)
    front, _ = mp4(True, **shape)
    fixed = build(FakeStore({"a": back}), "a")
    assert fixed == front
    assert [
        fixed[o : o + len(p)] for o, p in zip(chunk_offsets(fixed), pieces, strict=True)
    ] == pieces


def test_moov_already_in_front_is_left_alone() -> None:
    front, _ = mp4(True)
    assert build(FakeStore({"a": front}), "a") is None


@pytest.mark.parametrize(
    "head", [b"ID3\x04\0\0\0\0\0\0" + b"\xff" * 40, b"RIFF\x24\0\0\0WAVEfmt " + b"\0" * 40]
)
def test_files_that_are_not_mp4_are_left_alone(head: bytes) -> None:
    store = FakeStore({"a": head})
    assert top_atoms(store, "a") == []
    assert build(store, "a") is None


def test_an_atom_running_past_the_end_is_not_fixable() -> None:
    back, _ = mp4(False)
    with pytest.raises(NotFixableError):
        build(FakeStore({"a": back[:-3]}), "a")


def test_a_chunk_offset_outside_the_file_is_not_fixable() -> None:
    back, _ = mp4(False)
    store = FakeStore({"a": back})
    atoms = top_atoms(store, "a")
    moov = next(a for a in atoms if a.kind == b"moov")
    data = bytearray(back[moov.start :])
    at = data.find(b"stco") + 12
    data[at : at + 4] = struct.pack(">I", len(back) + 100)
    with pytest.raises(NotFixableError):
        fixed_moov(bytes(data), atoms, atoms)


class FakeSpeech:
    def __init__(self, fail: Exception | None = None) -> None:
        self.urls: list[str] = []
        self.fail = fail

    def transcribe(self, audio_url: str) -> Transcript:
        self.urls.append(audio_url)
        if self.fail:
            raise self.fail
        return Transcript(1000, ())


def test_moov_at_the_end_is_transcribed_from_a_fixed_copy_then_deleted() -> None:
    back, _ = mp4(False)
    front, _ = mp4(True)
    store, stt = FakeStore({"a": back}), FakeSpeech()
    assert FaststartSpeech(stt, store).transcribe("a") == Transcript(1000, ())
    assert stt.urls == ["copy-1"] and store.files["copy-1"] == front
    assert store.deleted == ["copy-1"]


def test_the_copy_is_deleted_when_transcription_fails() -> None:
    back, _ = mp4(False)
    store, stt = FakeStore({"a": back}), FakeSpeech(fail=SpeechUnavailableError("HTTP 503"))
    with pytest.raises(SpeechUnavailableError):
        FaststartSpeech(stt, store).transcribe("a")
    assert store.deleted == ["copy-1"]


def test_files_that_need_no_fix_go_as_they_are() -> None:
    front, _ = mp4(True)
    store, stt = FakeStore({"a": front, "b": b"ID3" + b"\0" * 40}), FakeSpeech()
    FaststartSpeech(stt, store).transcribe("a")
    FaststartSpeech(stt, store).transcribe("b")
    assert stt.urls == ["a", "b"] and store.copies == [] and store.deleted == []


def test_a_broken_file_or_a_refused_copy_falls_back_to_the_original() -> None:
    back, _ = mp4(False)
    store, stt = FakeStore({"a": back[:-3], "b": back}), FakeSpeech()
    FaststartSpeech(stt, store).transcribe("a")
    store.fail_copy = HttpResponseError("HTTP 403")
    FaststartSpeech(stt, store).transcribe("b")
    assert stt.urls == ["a", "b"] and store.deleted == []


def test_a_passing_storage_error_is_retried_as_speech_unavailable() -> None:
    back, _ = mp4(False)
    store, stt = FakeStore({"a": back}), FakeSpeech()
    store.fail_copy = AudioUnavailableError("HTTP 503")
    with pytest.raises(SpeechUnavailableError):
        FaststartSpeech(stt, store).transcribe("a")
    assert stt.urls == []


def test_failing_to_delete_the_copy_keeps_the_transcript() -> None:
    back, _ = mp4(False)
    store, stt = FakeStore({"a": back}), FakeSpeech()
    store.fail_delete = HttpResponseError("HTTP 404")
    assert FaststartSpeech(stt, store).transcribe("a") == Transcript(1000, ())


class FakeBlob:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []
        self.url = "https://acct.blob.core.windows.net/processed/x"

    def stage_block(self, block: str, data: bytes) -> None:
        self.calls.append(("bytes", data))

    def stage_block_from_url(
        self, block: str, url: str, *, source_offset: int, source_length: int
    ) -> None:
        self.calls.append(("range", url, source_offset, source_length))

    def commit_block_list(self, ids: list[object], **kw: object) -> None:
        self.calls.append(("commit", len(ids)))

    def delete_blob(self) -> None:
        raise ServiceRequestError("연결 끊김")


class FakeService:
    account_name = "acct"

    class credential:  # noqa: N801
        account_key = "a2V5"

    def __init__(self) -> None:
        self.blob = FakeBlob()
        self.names: list[tuple[str, str]] = []

    def get_blob_client(self, container: str, name: str) -> FakeBlob:
        self.names.append((container, name))
        return self.blob


def test_blob_copy_splits_long_ranges_into_blocks(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(audio_store, "BLOCK_MAX", 10)
    service = FakeService()
    store = BlobAudioStore(service, "processed")  # type: ignore[arg-type]
    copy = store.copy("src", [Range(0, 4), Bytes(b"moov"), Range(4, 25)])
    assert service.blob.calls == [
        ("range", "src", 0, 4),
        ("bytes", b"moov"),
        ("range", "src", 4, 10),
        ("range", "src", 14, 10),
        ("range", "src", 24, 5),
        ("commit", 5),
    ]
    assert service.names[0][0] == "processed" and service.names[0][1].startswith("recording-stt/")
    assert copy.url.startswith(service.blob.url + "?") and "sig=" in copy.url
    with pytest.raises(AudioUnavailableError):
        store.delete(copy.name)


@pytest.mark.parametrize("head", ["zero", "big"])
def test_moov_with_size_to_the_end_or_a_64_bit_size_moves_whole(head: str) -> None:
    back, pieces = mp4(False, moov_head=head)
    front, _ = mp4(True, moov_head="big" if head == "big" else "")
    fixed = build(FakeStore({"a": back}), "a")
    assert fixed == front
    assert [a.kind for a in top_atoms(FakeStore({"f": fixed}), "f")] == [b"ftyp", b"moov", b"mdat"]
    got = [fixed[o : o + len(p)] for o, p in zip(chunk_offsets(fixed), pieces, strict=True)]
    assert got == pieces


def test_the_copy_is_deleted_when_its_read_address_cannot_be_made(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def no_sas(**kw: object) -> str:
        raise ValueError("서명 실패")

    monkeypatch.setattr(audio_store, "generate_blob_sas", no_sas)
    service = FakeService()
    deleted: list[bool] = []
    service.blob.delete_blob = lambda: deleted.append(True)  # type: ignore[method-assign]
    with pytest.raises(ValueError):
        BlobAudioStore(service, "processed").copy("src", [Bytes(b"moov")])  # type: ignore[arg-type]
    assert deleted == [True]
