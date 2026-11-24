"""moov가 파일 끝에 있는 MP4(m4a) 녹음을 moov를 앞으로 옮긴 사본으로 전사.

Azure Speech 알려진 문제 1006: moov가 끝에 있으면 디코딩이 실패함(특히 10MB 넘는 파일, 422
InvalidAudioFormat). 아이폰 음성 메모가 이 구조. 소리 데이터는 다시 인코딩하지 않고 위치표(stco ·
co64)만 고침. 사본은 Blob 서버 안에서 바이트 범위를 복사해 만들고(AI 서버는 moov만 받음), 전사가
끝나면 지움. 사본을 만들지 못하면 원본 주소로 전사함(지금과 같음). 일시 오류만 다시 시도로 올림.
"""

import logging
import struct
from collections.abc import Callable
from dataclasses import dataclass
from typing import Protocol

from app.clients.audio_store import AudioUnavailableError, Bytes, Copy, Part, Range
from app.clients.speech import SpeechUnavailableError, Transcript

log = logging.getLogger(__name__)

HEAD = 16  # atom 머리(크기 4 · 종류 4 · 64비트 크기 8)
ATOMS_MAX = 64  # 최상위 atom 수 상한. 넘으면 MP4로 보지 않음
MOOV_MAX = 32 * 1024 * 1024  # 내려받는 moov 상한(2시간 녹음도 수 MB)
_CONTAINERS = {b"moov", b"trak", b"mdia", b"minf", b"stbl"}


class NotFixableError(ValueError):
    """고칠 수 없는 구조. 원본 그대로 전사."""


@dataclass(frozen=True)
class Atom:
    kind: bytes
    start: int
    size: int


class AudioStore(Protocol):
    def size(self, url: str) -> int: ...

    def read(self, url: str, start: int, length: int) -> bytes: ...

    def copy(self, source_url: str, parts: list[Part]) -> Copy: ...

    def delete(self, name: str) -> None: ...


class Transcriber(Protocol):
    def transcribe(self, audio_url: str) -> Transcript: ...


def atom_at(head: bytes, start: int, total: int) -> Atom:
    """start에서 읽은 머리 → 최상위 atom. 크기 0은 파일 끝까지."""
    if len(head) < 8:
        raise NotFixableError("atom 머리가 짧음")
    size, kind = struct.unpack(">I4s", head[:8])
    if size == 1:
        if len(head) < 16:
            raise NotFixableError("64비트 크기 머리가 짧음")
        size = struct.unpack(">Q", head[8:16])[0]
    elif size == 0:
        size = total - start
    if size < 8 or start + size > total:
        raise NotFixableError("atom 크기가 파일 밖")
    return Atom(kind, start, size)


def top_atoms(store: AudioStore, url: str) -> list[Atom]:
    """MP4(첫 atom이 ftyp)가 아니면 빈 목록."""
    total = store.size(url)
    first = store.read(url, 0, min(HEAD, total))
    if first[4:8] != b"ftyp":
        return []
    atoms: list[Atom] = []
    pos = 0
    while pos < total:
        if len(atoms) >= ATOMS_MAX:
            raise NotFixableError("atom이 너무 많음")
        head = first if pos == 0 else store.read(url, pos, min(HEAD, total - pos))
        atom = atom_at(head, pos, total)
        atoms.append(atom)
        pos += atom.size
    return atoms


def needs_fix(atoms: list[Atom]) -> bool:
    """MP4이고 moov가 첫 mdat보다 뒤에 있음."""
    if not atoms or atoms[0].kind != b"ftyp":
        return False
    moov = [a for a in atoms if a.kind == b"moov"]
    mdat = [a for a in atoms if a.kind == b"mdat"]
    if len(moov) != 1 or not mdat:
        return False
    return moov[0].start > mdat[0].start


def front_order(atoms: list[Atom]) -> list[Atom]:
    """ftyp 다음에 moov, 나머지는 원래 순서."""
    moov = next(a for a in atoms if a.kind == b"moov")
    rest = [a for a in atoms if a is not moov]
    return [rest[0], moov, *rest[1:]]


def fixed_moov(moov: bytes, atoms: list[Atom], order: list[Atom]) -> bytes:
    """새 순서에 맞게 moov 안 stco · co64 위치를 고친 moov."""
    moved: dict[int, int] = {}
    pos = 0
    for a in order:
        moved[a.start] = pos - a.start
        pos += a.size

    def shift(offset: int) -> int:
        for a in atoms:
            if a.start <= offset < a.start + a.size:
                return offset + moved[a.start]
        raise NotFixableError("소리 위치가 파일 밖")

    buf = bytearray(moov)
    size = struct.unpack(">I", buf[:4])[0]
    if size == 0:  # 파일 끝까지: 앞으로 옮기면 뒤 atom까지 덮으므로 실제 크기를 적음
        buf[:4] = struct.pack(">I", len(buf))
    _fix(buf, 16 if size == 1 else 8, len(buf), shift)
    return bytes(buf)


def _fix(buf: bytearray, start: int, end: int, shift: Callable[[int], int]) -> None:
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack(">I4s", buf[pos : pos + 8])
        if size < 8 or pos + size > end:
            raise NotFixableError("moov 안 atom 크기가 틀림")
        if kind in _CONTAINERS:
            _fix(buf, pos + 8, pos + size, shift)
        elif kind in (b"stco", b"co64"):
            width, fmt = (4, ">I") if kind == b"stco" else (8, ">Q")
            count = struct.unpack(">I", buf[pos + 12 : pos + 16])[0]
            if 16 + count * width > size:
                raise NotFixableError("위치표 길이가 틀림")
            for k in range(count):
                at = pos + 16 + k * width
                value = shift(struct.unpack(fmt, buf[at : at + width])[0])
                if value >= 1 << (8 * width):
                    raise NotFixableError("위치가 표 칸을 넘음")
                buf[at : at + width] = struct.pack(fmt, value)
        pos += size


def plan(store: AudioStore, url: str) -> list[Part] | None:
    """moov가 끝에 있으면 새 파일 조각 목록, 고칠 필요가 없으면 None."""
    atoms = top_atoms(store, url)
    if not needs_fix(atoms):
        return None
    moov = next(a for a in atoms if a.kind == b"moov")
    if moov.size > MOOV_MAX:
        raise NotFixableError("moov가 너무 큼")
    data = store.read(url, moov.start, moov.size)
    if len(data) != moov.size:
        raise NotFixableError("moov를 다 받지 못함")
    order = front_order(atoms)
    fixed = fixed_moov(data, atoms, order)
    return [Bytes(fixed) if a is moov else Range(a.start, a.size) for a in order]


class FaststartSpeech:
    """전사 전에 moov 위치를 고친 사본을 만들어 넘기고, 끝나면 지움."""

    def __init__(self, inner: Transcriber, store: AudioStore) -> None:
        self._inner, self._store = inner, store

    def transcribe(self, audio_url: str) -> Transcript:
        copy = self._copy(audio_url)
        try:
            return self._inner.transcribe(copy.url if copy else audio_url)
        finally:
            if copy is not None:
                self._delete(copy)

    def _copy(self, audio_url: str) -> Copy | None:
        try:
            parts = plan(self._store, audio_url)
            if parts is None:
                return None
            copy = self._store.copy(audio_url, parts)
        except AudioUnavailableError as e:
            raise SpeechUnavailableError(f"녹음 사본 {e}") from None
        except NotFixableError as e:
            log.warning("moov를 옮기지 못해 원본으로 전사함: %s", e)
            return None
        except Exception as e:  # 저장소 거절(4xx) 등: 원본으로 전사(지금과 같음)
            log.warning("녹음 사본을 만들지 못해 원본으로 전사함: %s", type(e).__name__)
            return None
        log.info("moov를 앞으로 옮긴 사본으로 전사함")
        return copy

    def _delete(self, copy: Copy) -> None:
        try:
            self._store.delete(copy.name)
        except Exception as e:  # 전사 결과는 그대로 돌려줌
            log.warning("녹음 사본을 지우지 못함: %s", type(e).__name__)
