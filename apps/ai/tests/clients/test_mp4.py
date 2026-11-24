import struct

from app.clients.mp4 import MAX_BOXES, faststart


def box(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(body), kind) + body


def offsets(kind: bytes, values: list[int]) -> bytes:
    fmt = ">Q" if kind == b"co64" else ">I"
    return box(
        kind,
        b"\0\0\0\0"
        + struct.pack(">I", len(values))
        + b"".join(struct.pack(fmt, v) for v in values),
    )


def moov(table: bytes) -> bytes:
    return box(
        b"moov",
        box(b"mvhd", b"\0" * 20) + box(b"trak", box(b"mdia", box(b"minf", box(b"stbl", table)))),
    )


FTYP = box(b"ftyp", b"M4A \0\0\0\0M4A isom")
AUDIO = [b"first-chunk", b"second-chunk"]


def slow_file(kind: bytes = b"stco") -> bytes:
    """moov가 끝에 있는 m4a: 조각 위치가 mdat 안의 두 조각을 가리킴"""
    mdat_at = len(FTYP)
    starts = [mdat_at + 8, mdat_at + 8 + len(AUDIO[0])]
    return FTYP + box(b"mdat", b"".join(AUDIO)) + moov(offsets(kind, starts))


def chunks(data: bytes) -> list[bytes]:
    """옮긴 파일의 조각 위치 표를 읽어 그 자리의 소리 조각들"""
    for kind, fmt, step in ((b"stco", ">I", 4), (b"co64", ">Q", 8)):
        at = data.find(kind)
        if at < 0:
            continue
        (count,) = struct.unpack(">I", data[at + 8 : at + 12])
        values = [
            struct.unpack(fmt, data[at + 12 + k * step : at + 12 + (k + 1) * step])[0]
            for k in range(count)
        ]
        return [data[v : v + len(AUDIO[k])] for k, v in enumerate(values)]
    raise AssertionError("조각 위치 표 없음")


def test_moves_moov_before_mdat_and_shifts_chunk_offsets() -> None:
    for kind in (b"stco", b"co64"):
        out = faststart(slow_file(kind))
        assert out is not None
        assert out.index(b"moov") < out.index(b"mdat")
        assert len(out) == len(slow_file(kind))
        assert chunks(out) == AUDIO


def test_already_fast_or_not_mp4_or_broken_returns_none() -> None:
    fast = faststart(slow_file())
    assert fast is not None
    assert faststart(fast) is None
    assert faststart(b"ID3\x03not an mp4 file at all") is None
    assert faststart(slow_file()[:-5]) is None  # 끝이 잘림
    assert faststart(FTYP + box(b"mdat", b"x")) is None  # moov 없음


def test_moov_not_last_box_returns_none() -> None:
    # mdat → moov → mdat: 뒤 mdat의 조각은 밀리지 않아 다루지 않음
    assert faststart(slow_file() + box(b"mdat", b"tail")) is None


def test_moov_with_size_zero_gets_real_size() -> None:
    data = bytearray(slow_file())
    at = data.index(b"moov") - 4
    data[at : at + 4] = b"\0\0\0\0"  # 크기 0 = 파일 끝까지
    out = faststart(bytes(data))
    assert out is not None
    at = out.index(b"moov") - 4
    (size,) = struct.unpack(">I", out[at : at + 4])
    assert out[at + size + 4 : at + size + 8] == b"mdat"
    assert chunks(out) == AUDIO


def test_too_many_small_boxes_returns_none() -> None:
    free = box(b"free", b"") * (MAX_BOXES + 1)
    assert faststart(FTYP + free + box(b"mdat", b"x") + moov(offsets(b"stco", [0]))) is None


def test_chunk_table_longer_than_its_box_returns_none() -> None:
    broken = box(b"stco", b"\0\0\0\0" + struct.pack(">I", 99) + struct.pack(">I", 1))
    assert faststart(FTYP + box(b"mdat", b"x") + moov(broken)) is None


def test_stco_offset_overflowing_32_bits_returns_none() -> None:
    near_max = offsets(b"stco", [0xFFFFFFFF - 10])
    assert faststart(FTYP + box(b"mdat", b"x") + moov(near_max)) is None
