from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx2
import pytest
from azure.core.exceptions import (
    HttpResponseError,
    ServiceRequestError,
    ServiceRequestTimeoutError,
    ServiceResponseError,
    ServiceResponseTimeoutError,
)
from azure.storage.blob import BlobServiceClient
from pydantic import SecretStr

from app.clients.docint import (
    SAS_MINUTES,
    DownloadError,
    Ocr,
    OcrError,
    OcrSetupError,
    OcrUnavailableError,
    docint,
    download,
    ocr,
    read_url,
)
from app.core.config import settings

# 시험용 가짜 계정 (네트워크를 쓰지 않음)
CONN = (
    "DefaultEndpointsProtocol=https;AccountName=acct;"
    "AccountKey=" + "a" * 86 + "==;EndpointSuffix=core.windows.net"
)


def test_read_url_encodes_name_and_gives_short_read_only_sas() -> None:
    url = read_url(BlobServiceClient.from_connection_string(CONN), "notes", "chapter#1 a.pdf")
    parts = urlsplit(url)
    # 고치기 전에는 # 뒤가 fragment로 빠져 경로가 /notes/chapter로 잘림
    assert parts.fragment == ""
    assert parts.path == "/notes/chapter%231%20a.pdf"
    q = parse_qs(parts.query)
    assert q["sp"] == ["r"]
    left = datetime.fromisoformat(q["se"][0].replace("Z", "+00:00")) - datetime.now(UTC)
    assert 0 < left.total_seconds() <= SAS_MINUTES * 60


class _Result:
    def as_dict(self) -> dict[str, Any]:
        return {"pages": [{"pageNumber": 1}]}


class _Poller:
    def result(self) -> _Result:
        return _Result()


class _Client:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def begin_analyze_document(self, model: str, body: Any) -> _Poller:
        self.calls.append((model, body.url_source))
        return _Poller()


def test_ocr_sends_url_and_returns_dict() -> None:
    client = _Client()
    out = ocr(client, "https://x/notes/a.jpg?sas", "prebuilt-layout")  # type: ignore[arg-type]
    assert out == {"pages": [{"pageNumber": 1}]}
    assert client.calls == [("prebuilt-layout", "https://x/notes/a.jpg?sas")]


def test_ocr_uses_read_model_by_default() -> None:
    client = _Client()
    ocr(client, "https://x/a.jpg")  # type: ignore[arg-type]
    assert client.calls[0][0] == "prebuilt-read"


# ---------- 오류 나누기 ----------

SAS_URL = "https://blob.example.test/notes/a.jpg?sig=secret-sas"


def http_error(status: int | None, code: str | None = None) -> HttpResponseError:
    e = HttpResponseError(f"Could not download {SAS_URL}")
    e.status_code = status
    e.error = SimpleNamespace(code=code) if code else None  # type: ignore[assignment]
    return e


class _Failing:
    """begin_analyze_document(보낼 때) 또는 poller.result(분석 끝)에서 오류."""

    def __init__(self, error: Exception, *, at_result: bool = False) -> None:
        self.error, self.at_result = error, at_result

    def begin_analyze_document(self, model: str, body: Any) -> Any:
        if not self.at_result:
            raise self.error
        error = self.error

        class Poller:
            def result(self) -> Any:
                raise error

        return Poller()


@pytest.mark.parametrize(
    ("error", "why"),
    [
        (http_error(429), "HTTP 429"),
        (http_error(500), "HTTP 500"),
        (http_error(503, "ServiceUnavailable"), "HTTP 503 ServiceUnavailable"),
        (http_error(None), "HTTP None"),
        (http_error(200, "InternalServerError"), "HTTP 200 InternalServerError"),
        (ServiceRequestError("연결 실패"), "ServiceRequestError"),
        (ServiceResponseError("응답 끊김"), "ServiceResponseError"),
        (ServiceRequestTimeoutError("시간 초과"), "ServiceRequestTimeoutError"),
        (ServiceResponseTimeoutError("시간 초과"), "ServiceResponseTimeoutError"),
    ],
)
@pytest.mark.parametrize("at_result", [False, True])
def test_temporary_errors_become_ocr_unavailable(
    error: Exception, why: str, at_result: bool
) -> None:
    with pytest.raises(OcrUnavailableError) as e:
        ocr(_Failing(error, at_result=at_result), SAS_URL)  # type: ignore[arg-type]
    assert str(e.value) == why
    assert "secret-sas" not in str(e.value)


@pytest.mark.parametrize(
    ("error", "why"),
    [
        (http_error(400, "InvalidRequest"), "HTTP 400 InvalidRequest"),
        (http_error(404), "HTTP 404"),
        (http_error(413), "HTTP 413"),
        (http_error(200, "InvalidContent"), "HTTP 200 InvalidContent"),  # 분석 실패(파일 문제)
    ],
)
@pytest.mark.parametrize("at_result", [False, True])
def test_file_errors_become_ocr_error(error: Exception, why: str, at_result: bool) -> None:
    with pytest.raises(OcrError) as e:
        ocr(_Failing(error, at_result=at_result), SAS_URL)  # type: ignore[arg-type]
    assert not isinstance(e.value, OcrUnavailableError)
    assert str(e.value) == why
    assert "secret-sas" not in str(e.value)


@pytest.mark.parametrize(
    ("error", "why"),
    [
        (http_error(401), "HTTP 401"),
        (http_error(403, "Forbidden"), "HTTP 403 Forbidden"),
    ],
)
@pytest.mark.parametrize("at_result", [False, True])
def test_key_and_permission_errors_are_setup_errors_not_file_errors(
    error: Exception, why: str, at_result: bool
) -> None:
    with pytest.raises(OcrSetupError) as e:
        ocr(_Failing(error, at_result=at_result), SAS_URL)  # type: ignore[arg-type]
    assert not isinstance(e.value, OcrError)
    assert str(e.value) == why
    assert "secret-sas" not in str(e.value)


def test_ocr_wrapper_reads_with_its_client() -> None:
    client = _Client()
    assert Ocr(client).read("https://x/a.jpg") == {"pages": [{"pageNumber": 1}]}  # type: ignore[arg-type]
    assert client.calls == [("prebuilt-read", "https://x/a.jpg")]


def test_missing_settings_fail_before_calling(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "azure_docint_endpoint", "")
    monkeypatch.setattr(settings, "azure_docint_key", SecretStr("k"))
    with pytest.raises(OcrSetupError, match="AZURE_DOCINT_ENDPOINT"):
        docint()


# ---------- 사진 내려받기 ----------


def serve(
    *responses: httpx2.Response | Exception,
) -> tuple[list[httpx2.Request], httpx2.MockTransport]:
    seen: list[httpx2.Request] = []
    queue = list(responses)

    def handle(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        r = queue.pop(0)
        if isinstance(r, Exception):
            raise r
        return r

    return seen, httpx2.MockTransport(handle)


def test_download_returns_the_bytes() -> None:
    seen, transport = serve(httpx2.Response(200, content=b"png"))
    assert download(SAS_URL, transport=transport) == b"png"
    assert str(seen[0].url) == SAS_URL


def test_download_on_the_limit_is_accepted() -> None:
    _, transport = serve(httpx2.Response(200, content=b"a" * 10))
    assert download(SAS_URL, max_bytes=10, transport=transport) == b"a" * 10


def ticking(step: float) -> tuple[list[float], Callable[[], float]]:
    """부를 때마다 step초씩 흐르는 시계. 처음 부른 때(시작)가 0초."""
    calls: list[float] = []

    def clock() -> float:
        calls.append(len(calls) * step)
        return calls[-1]

    return calls, clock


def test_slow_download_stops_at_the_overall_deadline() -> None:
    # 조각 하나는 빨리 와도(읽기 timeout 안) 전체가 마감을 넘으면 멈춤: 0초 시작, 25 · 50 · 75초
    calls, clock = ticking(25.0)
    _, transport = serve(httpx2.Response(200, content=iter([b"a", b"b", b"c", b"d"])))

    with pytest.raises(DownloadError) as e:
        download(SAS_URL, timeout=60.0, transport=transport, clock=clock)

    assert str(e.value) == "시간 초과"
    assert calls == [0.0, 25.0, 50.0, 75.0]  # 넷째 조각은 받지 않음


def test_download_within_the_deadline_is_accepted() -> None:
    _, clock = ticking(20.0)  # 0초 시작, 20 · 40 · 60초: 마감(60초)을 넘지 않음
    _, transport = serve(httpx2.Response(200, content=iter([b"a", b"b", b"c"])))

    assert download(SAS_URL, timeout=60.0, transport=transport, clock=clock) == b"abc"


@pytest.mark.parametrize(
    ("response", "why"),
    [
        (httpx2.Response(403), "HTTP 403"),
        (httpx2.Response(500), "HTTP 500"),
        (httpx2.Response(200, content=b"a" * 11), "파일이 너무 큼"),  # content-length로
        (httpx2.Response(200, content=iter([b"a" * 6, b"a" * 6])), "파일이 너무 큼"),  # 받는 중에
        (httpx2.ConnectError("연결 실패"), "ConnectError"),
        (httpx2.ReadTimeout("시간 초과"), "ReadTimeout"),
    ],
)
def test_download_failures_become_download_error(
    response: httpx2.Response | Exception, why: str
) -> None:
    _, transport = serve(response)
    with pytest.raises(DownloadError) as e:
        download(SAS_URL, max_bytes=10, transport=transport)
    assert str(e.value) == why
    assert "secret-sas" not in str(e.value)


@pytest.mark.parametrize("url", ["file:///etc/passwd", "ftp://x/a.jpg", "주소", ""])
def test_download_only_takes_http_addresses(url: str) -> None:
    seen, transport = serve()
    with pytest.raises(DownloadError):
        download(url, transport=transport)
    assert seen == []
