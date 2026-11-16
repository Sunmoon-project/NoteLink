import threading
from typing import Any, cast

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.api.v1 import images
from app.api.v1.images import MAX_FILES, MAX_WORKERS, ImageCheckFile, _authorize, _check
from app.clients.docint import Ocr, OcrError, OcrSetupError, OcrUnavailableError
from app.core.config import settings
from app.main import app

TOKEN = "internal-secret"
READABLE = {
    "content": "abc",
    "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": 3}]}],
    "pages": [{"words": [{"confidence": 0.9}]}],
}
BLURRY = {**READABLE, "pages": [{"words": [{"confidence": 0.1}]}]}
PRINTED = {"content": "printed", "styles": []}


def file(name: str) -> ImageCheckFile:
    return ImageCheckFile.model_validate(
        {"name": name, "uri": f"https://blob.example.test/{name}?sig=read"}
    )


class FakeReader:
    """주소 이름(마지막 경로)마다 준비한 결과나 예외를 돌려주는 가짜 OCR."""

    def __init__(self, outcomes: dict[str, Any]) -> None:
        self.outcomes = outcomes
        self.read_names: list[str] = []
        self._lock = threading.Lock()

    def read(self, url: str) -> dict[str, Any]:
        name = url.split("?")[0].rsplit("/", 1)[-1]
        with self._lock:
            self.read_names.append(name)
        outcome = self.outcomes[name]
        if isinstance(outcome, Exception):
            raise outcome
        return cast(dict[str, Any], outcome)


def make(reader: FakeReader) -> Any:
    return lambda: cast(Ocr, reader)


@pytest.fixture
def internal_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ai_internal_token", SecretStr(TOKEN))


# ---------- _authorize ----------


def test_authorize_accepts_the_matching_bearer_token(internal_token: None) -> None:
    _authorize(f"Bearer {TOKEN}")  # 예외 없이 돌아오면 통과


def test_authorize_returns_503_when_the_internal_token_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ai_internal_token", SecretStr(""))

    # 토큰을 설정하지 않았으면 빈 토큰을 보내도 통과시키지 않는다
    for header in (None, "", "Bearer ", "Bearer anything"):
        with pytest.raises(HTTPException) as error:
            _authorize(header)
        assert error.value.status_code == 503


@pytest.mark.parametrize(
    "header",
    [
        None,
        "",
        TOKEN,  # Bearer 접두어 없음
        f"Basic {TOKEN}",
        f"bearer {TOKEN}",  # 접두어는 대소문자를 구분한다
        f"Bearer  {TOKEN}",
        f"Bearer {TOKEN} ",
        f"Bearer {TOKEN}x",
        f"Bearer {TOKEN[:-1]}",
        "Bearer ",
    ],
)
def test_authorize_rejects_missing_or_wrong_credentials(
    header: str | None, internal_token: None
) -> None:
    with pytest.raises(HTTPException) as error:
        _authorize(header)
    assert error.value.status_code == 401


# ---------- _check ----------


def test_check_maps_each_file_to_its_verdict_in_request_order() -> None:
    reader = FakeReader({"a.jpg": READABLE, "b.jpg": BLURRY, "c.jpg": PRINTED})

    result = _check([file("c.jpg"), file("a.jpg"), file("b.jpg")], make(reader))

    assert [(r.name, r.verdict) for r in result] == [
        ("c.jpg", "not_handwriting"),
        ("a.jpg", "ok"),
        ("b.jpg", "blurry"),
    ]


def test_check_marks_a_file_ocr_rejects_as_not_allowed_and_keeps_checking_the_rest() -> None:
    reader = FakeReader({"bad.jpg": OcrError("HTTP 400"), "good.jpg": READABLE})

    result = _check([file("bad.jpg"), file("good.jpg")], make(reader))

    assert [(r.name, r.verdict) for r in result] == [
        ("bad.jpg", "not_allowed"),
        ("good.jpg", "ok"),
    ]


def test_check_returns_503_when_ocr_is_temporarily_unavailable() -> None:
    # OcrUnavailableError는 OcrError의 하위 클래스라도 not_allowed로 처리하면 안 된다
    reader = FakeReader({"a.jpg": READABLE, "b.jpg": OcrUnavailableError("HTTP 429")})

    with pytest.raises(HTTPException) as error:
        _check([file("a.jpg"), file("b.jpg")], make(reader))

    assert error.value.status_code == 503
    assert error.value.detail == "Image check temporarily unavailable"


def test_check_returns_503_when_ocr_credentials_are_rejected_while_reading() -> None:
    reader = FakeReader({"a.jpg": OcrSetupError("HTTP 401")})

    with pytest.raises(HTTPException) as error:
        _check([file("a.jpg")], make(reader))

    assert error.value.status_code == 503
    assert error.value.detail == "Image check is not configured"


def test_check_returns_503_when_the_ocr_client_cannot_be_created() -> None:
    def broken() -> Ocr:
        raise OcrSetupError("설정 값 누락")

    with pytest.raises(HTTPException) as error:
        _check([file("a.jpg")], broken)

    assert error.value.status_code == 503
    assert error.value.detail == "Image check is not configured"


def test_check_reports_the_first_failed_file_in_request_order() -> None:
    reader = FakeReader(
        {
            "a.jpg": READABLE,
            "b.jpg": OcrSetupError("HTTP 403"),
            "c.jpg": OcrUnavailableError("HTTP 503"),
        }
    )

    with pytest.raises(HTTPException) as error:
        _check([file("a.jpg"), file("b.jpg"), file("c.jpg")], make(reader))

    assert error.value.detail == "Image check is not configured"


def test_check_reads_files_concurrently_so_a_full_batch_stays_within_the_nest_timeout() -> None:
    names = [f"{i}.jpg" for i in range(MAX_FILES)]
    barrier = threading.Barrier(MAX_WORKERS, timeout=5)

    class BarrierReader(FakeReader):
        arrivals = 0

        def read(self, url: str) -> dict[str, Any]:
            # 순차로 읽으면 첫 파일이 다른 파일을 기다리다 BrokenBarrierError가 난다.
            # 처음 MAX_WORKERS개 호출이 동시에 들어와야 통과하고, 그 뒤 파일은 그냥 읽는다.
            with self._lock:
                order = self.arrivals
                self.arrivals += 1
            if order < MAX_WORKERS:
                barrier.wait()
            return super().read(url)

    reader = BarrierReader({name: READABLE for name in names})

    result = _check([file(name) for name in names], make(reader))

    assert [r.name for r in result] == names
    assert {r.verdict for r in result} == {"ok"}
    assert sorted(reader.read_names) == sorted(names)


# ---------- POST /internal/v1/images/check ----------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, internal_token: None) -> TestClient:
    reader = FakeReader({"a.jpg": READABLE})
    monkeypatch.setattr(images, "docint", lambda: object())
    monkeypatch.setattr(images, "Ocr", lambda _client: reader)
    return TestClient(app)


def post(client: TestClient, files: list[dict[str, str]], token: str | None = TOKEN) -> Any:
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    return client.post("/internal/v1/images/check", json={"files": files}, headers=headers)


def test_endpoint_returns_data_envelope_with_verdicts(client: TestClient) -> None:
    res = post(client, [{"name": "a.jpg", "uri": "https://blob.example.test/a.jpg?sig=read"}])

    assert res.status_code == 200
    assert res.json() == {"data": [{"name": "a.jpg", "verdict": "ok"}]}


@pytest.mark.parametrize("token", [None, "wrong"])
def test_endpoint_rejects_bad_token_before_creating_the_ocr_client(
    token: str | None, monkeypatch: pytest.MonkeyPatch, internal_token: None
) -> None:
    created: list[object] = []
    monkeypatch.setattr(images, "docint", lambda: created.append(object()))

    res = post(
        TestClient(app),
        [{"name": "a.jpg", "uri": "https://blob.example.test/a.jpg"}],
        token,
    )

    assert res.status_code == 401
    assert created == []


@pytest.mark.parametrize(
    "files",
    [
        [],
        [{"name": "", "uri": "https://blob.example.test/a.jpg"}],
        [{"name": "a.jpg", "uri": "not a url"}],
        [{"name": "n" * 256, "uri": "https://blob.example.test/a.jpg"}],
        [
            {"name": f"{i}.jpg", "uri": f"https://blob.example.test/{i}.jpg"}
            for i in range(MAX_FILES + 1)
        ],
    ],
)
def test_endpoint_rejects_invalid_file_lists(
    client: TestClient, files: list[dict[str, str]]
) -> None:
    assert post(client, files).status_code == 422
