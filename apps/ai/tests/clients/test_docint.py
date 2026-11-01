from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urlsplit

from azure.storage.blob import BlobServiceClient

from app.clients.docint import SAS_MINUTES, ocr, read_url

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
