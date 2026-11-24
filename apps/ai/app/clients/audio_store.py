"""녹음 Blob 읽기 · 사본 만들기 · 지우기(services/recording/faststart.py가 씀).

사본은 조각(Part)을 이어 만듦. Bytes는 직접 올리고, Range는 Put Block From URL로 원본의 그
바이트 범위를 저장소 안에서 복사함. 오류 문구에 주소(SAS)를 넣지 않습니다.
"""

import base64
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from azure.core.exceptions import HttpResponseError, ServiceRequestError, ServiceResponseError
from azure.storage.blob import (
    BlobBlock,
    BlobClient,
    BlobSasPermissions,
    BlobServiceClient,
    ContentSettings,
    generate_blob_sas,
)

PREFIX = "recording-stt/"
BLOCK_MAX = 100 * 1024 * 1024  # 블록 하나에 복사하는 바이트
SAS_MINUTES = 30  # 전사를 시작할 때까지만 쓰임


class AudioUnavailableError(Exception):
    """사본을 만드는 중 일시 오류(연결 · 5xx · 429)."""


@dataclass(frozen=True)
class Bytes:
    data: bytes


@dataclass(frozen=True)
class Range:
    start: int
    length: int


type Part = Bytes | Range


@dataclass(frozen=True)
class Copy:
    url: str
    name: str


class BlobAudioStore:
    def __init__(self, service: BlobServiceClient, container: str) -> None:
        self._service, self._container = service, container

    def size(self, url: str) -> int:
        return _guard(lambda: int(BlobClient.from_blob_url(url).get_blob_properties().size))

    def read(self, url: str, start: int, length: int) -> bytes:
        def go() -> bytes:
            blob = BlobClient.from_blob_url(url)
            return blob.download_blob(offset=start, length=length).readall()

        return _guard(go)

    def copy(self, source_url: str, parts: list[Part]) -> Copy:
        name = f"{PREFIX}{uuid.uuid4().hex}.m4a"
        blob = self._service.get_blob_client(self._container, name)

        def go() -> None:
            ids: list[BlobBlock] = []
            for part in parts:
                if isinstance(part, Bytes):
                    block = _block_id()
                    blob.stage_block(block, part.data)
                    ids.append(BlobBlock(block_id=block))
                    continue
                end = part.start + part.length
                for at in range(part.start, end, BLOCK_MAX):
                    block = _block_id()
                    n = min(BLOCK_MAX, end - at)
                    blob.stage_block_from_url(block, source_url, source_offset=at, source_length=n)
                    ids.append(BlobBlock(block_id=block))
            blob.commit_block_list(ids, content_settings=ContentSettings("audio/mp4"))

        _guard(go)
        try:
            return Copy(self._read_url(name), name)
        except Exception:
            try:
                blob.delete_blob()
            except Exception:  # 처음 오류를 올림
                pass
            raise

    def delete(self, name: str) -> None:
        _guard(lambda: self._service.get_blob_client(self._container, name).delete_blob())

    def _read_url(self, name: str) -> str:
        sas = generate_blob_sas(
            account_name=self._service.account_name or "",
            container_name=self._container,
            blob_name=name,
            account_key=self._service.credential.account_key,
            permission=BlobSasPermissions(read=True),
            expiry=datetime.now(UTC) + timedelta(minutes=SAS_MINUTES),
        )
        return f"{self._service.get_blob_client(self._container, name).url}?{sas}"


def _block_id() -> str:
    return base64.b64encode(uuid.uuid4().bytes).decode()


def _guard[T](call: Callable[[], T]) -> T:
    """연결 · 429 · 5xx는 AudioUnavailableError, 그 밖의 거절은 그대로(원본으로 전사)."""
    try:
        return call()
    except (ServiceRequestError, ServiceResponseError) as e:
        raise AudioUnavailableError(type(e).__name__) from None
    except HttpResponseError as e:
        status = e.status_code
        if status is None or status == 429 or status >= 500:
            raise AudioUnavailableError(f"HTTP {status}") from None
        raise HttpResponseError(f"HTTP {status}") from None
