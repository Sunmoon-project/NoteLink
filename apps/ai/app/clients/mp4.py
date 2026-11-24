"""MP4 · M4A 녹음의 재생 정보(moov)를 소리 데이터(mdat) 앞으로 옮기기(faststart).

아이폰 음성 메모 등으로 만든 m4a는 moov가 파일 끝에 있을 때가 있다. Azure 빠른 전사는 이런
파일을 「InvalidAudioFormat(HTTP 422)」로 거절해서(2026-11-24 32분 녹음으로 확인), 앞으로 옮긴
사본을 보낸다.
소리는 다시 인코딩하지 않고 상자 순서와 조각 위치(stco · co64)만 고친다.
"""

import struct

# stco · co64(조각 위치 표)까지 내려가는 길에 있는 상자들
_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}
# 한 단계 상자 수 상한. 정상 녹음은 수십 개뿐이고, 8바이트 상자를 반복한 큰 파일이 튜플 수천만 개를
# 만들지 않게 막음(넘으면 고치지 않고 원래 422)
MAX_BOXES = 10_000


def _boxes(data: bytes | bytearray, start: int, end: int) -> list[tuple[bytes, int, int, int]]:
    """[start, end)의 상자들: (종류, 시작, 머리 길이, 전체 길이). 모양이 깨졌으면 ValueError"""
    out: list[tuple[bytes, int, int, int]] = []
    i = start
    while i < end:
        if end - i < 8:
            raise ValueError("상자 머리가 잘림")
        size, kind = struct.unpack(">I4s", data[i : i + 8])
        head = 8
        if size == 1:
            if end - i < 16:
                raise ValueError("큰 상자 머리가 잘림")
            size = struct.unpack(">Q", data[i + 8 : i + 16])[0]
            head = 16
        elif size == 0:
            size = end - i
        if size < head or i + size > end:
            raise ValueError("상자 길이가 맞지 않음")
        out.append((kind, i, head, size))
        if len(out) > MAX_BOXES:
            raise ValueError("상자가 너무 많음")
        i += size
    return out


def _shift_offsets(moov: bytearray, start: int, end: int, shift: int) -> None:
    for kind, at, head, size in _boxes(moov, start, end):
        if kind in _CONTAINERS:
            _shift_offsets(moov, at + head, at + size, shift)
        elif kind in (b"stco", b"co64"):
            wide = kind == b"co64"
            fmt, step = (">Q", 8) if wide else (">I", 4)
            body = at + head + 4  # 버전 · 플래그
            (count,) = struct.unpack(">I", moov[body : body + 4])
            first = body + 4
            if first + count * step > at + size:
                raise ValueError("조각 위치 표가 상자보다 김")
            for k in range(count):
                o = first + k * step
                (value,) = struct.unpack(fmt, moov[o : o + step])
                value += shift
                if not wide and value > 0xFFFFFFFF:
                    raise ValueError("32비트 위치를 넘음")
                moov[o : o + step] = struct.pack(fmt, value)


def faststart(data: bytes) -> bytes | None:
    """moov가 mdat 뒤에 있으면 앞으로 옮긴 사본.
    이미 앞이거나 MP4가 아니거나 모양이 깨졌으면 None"""
    try:
        top = _boxes(data, 0, len(data))
        kinds = [b[0] for b in top]
        if b"moov" not in kinds or b"mdat" not in kinds or b"moof" in kinds:
            return None  # 조각난(fragmented) MP4는 다루지 않음
        _, mdat_at, _, _ = top[kinds.index(b"mdat")]
        _, moov_at, moov_head, moov_size = top[kinds.index(b"moov")]
        # moov가 맨 끝 상자일 때만 다룸: 뒤에 다른 mdat가 있으면 그 조각은 밀리지 않아 계산이 달라짐
        if moov_at < mdat_at or top[-1][0] != b"moov":
            return None
        moov = bytearray(data[moov_at : moov_at + moov_size])
        if (
            moov_head == 8
        ):  # 크기 0(「파일 끝까지」)이면 옮긴 뒤 뒤 상자까지 먹으므로 실제 크기로 적음
            struct.pack_into(">I", moov, 0, moov_size)
        # moov를 첫 mdat 바로 앞에 넣으면 그 뒤의 소리 데이터가 moov 길이만큼 밀린다
        _shift_offsets(moov, moov_head, moov_size, moov_size)
    except (ValueError, struct.error):
        return None
    return data[:mdat_at] + bytes(moov) + data[mdat_at:moov_at] + data[moov_at + moov_size :]
