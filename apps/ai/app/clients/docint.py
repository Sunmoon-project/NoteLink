"""Azure Document Intelligence(OCR) · Blob 클라이언트. 사진은 Blob 읽기 전용 주소로 OCR에 넘김.

오류 문구에 주소(SAS)를 넣지 않습니다.
"""

import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx2
from azure.ai.documentintelligence import DocumentIntelligenceClient
from azure.ai.documentintelligence.models import AnalyzeDocumentRequest
from azure.core.credentials import AzureKeyCredential
from azure.core.exceptions import HttpResponseError, ServiceRequestError, ServiceResponseError
from azure.storage.blob import BlobSasPermissions, BlobServiceClient, generate_blob_sas

from app.clients.llm import USER_AGENT
from app.core.config import settings

type OcrModel = Literal["prebuilt-read", "prebuilt-layout"]

SAS_MINUTES = 15
IMAGE_MAX_BYTES = 20 * 1024 * 1024  # 색 찾기용으로 내려받는 사진의 최대 크기(20MB)
DOWNLOAD_TIMEOUT_SEC = 60.0  # 내려받기 전체 마감
DOWNLOAD_READ_TIMEOUT_SEC = 10.0  # 연결 · 읽기 한 번의 상한(httpx2 timeout)
# 분석이 끝난 뒤(HTTP 200) 실패로 알려 오는 오류 중 다시 하면 풀릴 수 있는 것
_TRANSIENT_CODES = frozenset(
    {"InternalServerError", "ServiceUnavailable", "Timeout", "TooManyRequests"}
)


class OcrError(Exception):
    """OCR이 이 파일을 거절함. 다시 보내도 같음(파일 · 주소 문제)."""


class OcrUnavailableError(OcrError):
    """일시 오류(429 · 5xx · 연결 실패 · 시간 초과). 나중에 다시 하면 풀릴 수 있음."""


class OcrSetupError(Exception):
    """OCR 설정 오류(키 · 권한 401 · 403, 설정 값 누락). 파일 문제가 아니므로 OcrError가 아님."""


class DownloadError(Exception):
    """사진을 내려받지 못함(네트워크 · HTTP 오류 · 너무 큼)."""


def read_url(
    blobs: BlobServiceClient, container: str, name: str, minutes: int = SAS_MINUTES
) -> str:
    """Blob 하나의 읽기 전용 주소(SAS)."""
    key = blobs.credential.account_key
    sas = generate_blob_sas(
        account_name=blobs.account_name or "",
        container_name=container,
        blob_name=name,
        account_key=key,
        permission=BlobSasPermissions(read=True),
        expiry=datetime.now(UTC) + timedelta(minutes=minutes),
    )
    # 이름의 # · 공백 등은 SDK가 인코딩한 주소를 씀
    return f"{blobs.get_blob_client(container, name).url}?{sas}"


def ocr(
    client: DocumentIntelligenceClient, url: str, model: OcrModel = "prebuilt-read"
) -> dict[str, Any]:
    """사진 · PDF 주소 → OCR 결과(dict). layout.lines_from_read에 그대로 넣습니다.

    일시 오류는 OcrUnavailableError, 키 · 권한 오류(401 · 403)는 OcrSetupError,
    그 밖의 거절(4xx · 분석 실패)은 OcrError. 429 · 5xx는 SDK가 먼저 몇 번 다시 보낸 뒤에
    올라옵니다. 원본 예외는 주소(SAS)를 담을 수 있어 잇지 않습니다(from None): 처리기가
    traceback을 로그에 남겨도 주소가 나오지 않게.
    """
    try:
        poller = client.begin_analyze_document(model, AnalyzeDocumentRequest(url_source=url))
        result: dict[str, Any] = poller.result().as_dict()
    except (ServiceRequestError, ServiceResponseError) as e:  # 연결 실패 · 시간 초과
        raise OcrUnavailableError(type(e).__name__) from None
    except HttpResponseError as e:
        status = e.status_code
        code = getattr(e.error, "code", None) if e.error is not None else None
        why = f"HTTP {status}" + (f" {code}" if code else "")  # 서버 문구는 주소를 담을 수 있어 뺌
        if status is None or status == 429 or status >= 500 or code in _TRANSIENT_CODES:
            raise OcrUnavailableError(why) from None
        if status in (401, 403):
            raise OcrSetupError(why) from None
        raise OcrError(why) from None
    return result


class Ocr:
    """작업 처리기가 쓰는 OCR. 클라이언트 하나를 두고 주소만 받아 읽음."""

    def __init__(
        self, client: DocumentIntelligenceClient, model: OcrModel = "prebuilt-read"
    ) -> None:
        self._client, self._model = client, model

    def read(self, url: str) -> dict[str, Any]:
        return ocr(self._client, url, self._model)


def download(
    url: str,
    *,
    max_bytes: int = IMAGE_MAX_BYTES,
    timeout: float = DOWNLOAD_TIMEOUT_SEC,
    read_timeout: float = DOWNLOAD_READ_TIMEOUT_SEC,
    transport: httpx2.BaseTransport | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> bytes:
    """주소의 파일을 내려받음. 실패는 DownloadError(원본 예외는 주소를 담을 수 있어 잇지 않음).

    max_bytes를 넘거나 시작부터 timeout초가 지나면 다 받기 전에 멈춤. 전체 마감은 조각을 받을
    때마다 보므로, 연결 · 읽기 한 번은 read_timeout초로 따로 끊음. 최악의 경우 걸리는 시간은
    timeout + read_timeout(기본 60 + 10 = 약 70초).
    """
    if urlsplit(url).scheme not in ("http", "https"):
        raise DownloadError("http(s) 주소가 아님")
    deadline = clock() + timeout
    try:
        with (
            httpx2.Client(
                timeout=read_timeout, transport=transport, headers={"User-Agent": USER_AGENT}
            ) as client,
            client.stream("GET", url) as res,
        ):
            if res.status_code != 200:
                raise DownloadError(f"HTTP {res.status_code}")
            size = res.headers.get("content-length", "")
            if size.isdigit() and int(size) > max_bytes:
                raise DownloadError("파일이 너무 큼")
            data = bytearray()
            for part in res.iter_bytes():
                data += part
                if len(data) > max_bytes:
                    raise DownloadError("파일이 너무 큼")
                if clock() > deadline:
                    raise DownloadError("시간 초과")
    except (httpx2.HTTPError, httpx2.InvalidURL) as e:
        raise DownloadError(type(e).__name__) from None
    return bytes(data)


def docint() -> DocumentIntelligenceClient:
    key = settings.azure_docint_key.get_secret_value()
    if not settings.azure_docint_endpoint or not key:
        raise OcrSetupError("AZURE_DOCINT_ENDPOINT · AZURE_DOCINT_KEY가 비어 있음")
    return DocumentIntelligenceClient(settings.azure_docint_endpoint, AzureKeyCredential(key))


def blob_service() -> BlobServiceClient:
    return BlobServiceClient.from_connection_string(
        settings.azure_storage_connection_string.get_secret_value()
    )
