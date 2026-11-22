import threading
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from functools import partial
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
NEST_TIMEOUT_SEC = 90  # apps/api images.service.ts의 AbortSignal.timeout(90_000)과 같은 값
OCR_SECONDS_PER_FILE = 15  # 파일 한 장을 읽는 데 걸린다고 가정한 시간(가상)
WAIT_SEC = 5  # 시험이 스레드를 기다리는 실제 상한. 넘으면 실패
READABLE = {
    "content": "abc",
    "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": 3}]}],
    "pages": [{"words": [{"confidence": 0.9}]}],
}
BLURRY = {**READABLE, "pages": [{"words": [{"confidence": 0.1}]}]}
TOO_LITTLE_TEXT = {"content": "printed", "styles": []}  # 글자가 거의 없는 사진(풍경 · 간판)
# 손글씨 표시 없이 여러 줄 읽힌 인쇄물 · 한글 필기(#651)
PRINTED_LINES = ["제2장 세포의 구조", "세포막은 인지질 이중층으로 되어 있다."]
PRINTED_PAGE = {
    "content": "\n".join(PRINTED_LINES),
    "styles": [],
    "pages": [
        {
            "lines": [{"content": line} for line in PRINTED_LINES],
            "words": [{"confidence": 0.9}],
        }
    ],
}


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


# 비교용 토큰이 ASCII여도 헤더에 비 ASCII 문자가 오면 compare_digest가 TypeError(500)를 냈다
NON_ASCII_HEADERS = [
    "Bearer 한글토큰",
    f"Bearer {TOKEN}é",
    f"Bearer é{TOKEN}",
    "Bearer \u00ff",  # latin-1 범위(서버가 헤더를 latin-1로 읽을 때 나오는 문자)
    "Bearer 🔑",
]


@pytest.mark.parametrize("header", NON_ASCII_HEADERS)
def test_authorize_rejects_non_ascii_credentials_with_401_instead_of_crashing(
    header: str, internal_token: None
) -> None:
    with pytest.raises(HTTPException) as error:
        _authorize(header)
    assert error.value.status_code == 401


def test_authorize_still_returns_503_for_non_ascii_credentials_when_token_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "ai_internal_token", SecretStr(""))

    with pytest.raises(HTTPException) as error:
        _authorize("Bearer 한글토큰")
    assert error.value.status_code == 503


# ---------- _check ----------


def test_check_maps_each_file_to_its_verdict_in_request_order() -> None:
    reader = FakeReader(
        {"a.jpg": READABLE, "b.jpg": BLURRY, "c.jpg": TOO_LITTLE_TEXT, "d.jpg": PRINTED_PAGE}
    )

    result = _check([file("c.jpg"), file("a.jpg"), file("b.jpg"), file("d.jpg")], make(reader))

    assert [(r.name, r.verdict) for r in result] == [
        ("c.jpg", "not_handwriting"),
        ("a.jpg", "ok"),
        ("b.jpg", "blurry"),
        ("d.jpg", "ok"),
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


def test_check_starts_max_workers_reads_at_the_same_time() -> None:
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


class GatedReader(FakeReader):
    """read()가 시험이 풀어 줄 때까지 멈춘다. OCR 한 번이 걸리는 시간을 시험이 정한다.

    실제로 기다리지 않고, 풀어 주는 한 번을 "OCR 지연 한 번이 지남"으로 센다.
    """

    def __init__(self, outcomes: dict[str, Any], ungated: frozenset[str] = frozenset()) -> None:
        super().__init__(outcomes)
        self.ungated = ungated  # 멈추지 않고 바로 결과나 예외를 돌려주는 파일 이름
        self.cond = threading.Condition()
        self.started = 0  # read()에 들어온 호출 수
        self.waiting = 0  # 들어와서 풀어 주기를 기다리는 호출 수
        self.permits = 0  # 시험이 풀어 준 뒤 아직 지나가지 않은 호출 수

    def read(self, url: str) -> dict[str, Any]:
        with self.cond:
            self.started += 1
            if url.split("?")[0].rsplit("/", 1)[-1] in self.ungated:
                self.cond.notify_all()
                return super().read(url)
            self.waiting += 1
            self.cond.notify_all()
            if not self.cond.wait_for(lambda: self.permits > 0, timeout=WAIT_SEC):
                raise AssertionError("시험이 OCR 호출을 풀어 주지 않았다")
            self.permits -= 1
            self.waiting -= 1
            self.cond.notify_all()  # 시험 스레드가 바뀐 상태를 바로 다시 확인하게 한다
        return super().read(url)

    def at_wave(self, started: int, waiting: int) -> bool:
        """started개가 시작했고 그중 waiting개만 풀어 주기를 기다리는 상태인가."""
        return self.started == started and self.waiting == waiting and self.permits == 0


type BatchCall = Callable[[GatedReader, list[str]], list[str]]


def check_directly(reader: GatedReader, names: list[str]) -> list[str]:
    return [r.name for r in _check([file(name) for name in names], make(reader))]


def check_via_endpoint(monkeypatch: pytest.MonkeyPatch) -> BatchCall:
    """NestJS가 부르는 POST /internal/v1/images/check로 같은 배치를 처리한다."""

    def call(reader: GatedReader, names: list[str]) -> list[str]:
        monkeypatch.setattr(images, "docint", lambda: object())
        monkeypatch.setattr(images, "Ocr", lambda _client: reader)
        files = [{"name": n, "uri": f"https://blob.example.test/{n}?sig=read"} for n in names]
        res = post(TestClient(app), files)
        assert res.status_code == 200
        return [item["name"] for item in res.json()["data"]]

    return call


def run_batch_by_waves(count: int, call: BatchCall = check_directly) -> tuple[list[str], int]:
    """파일 count장을 call로 처리하며 OCR 호출을 한 묶음(동시에 멈춘 호출)씩 풀어 준다.

    돌려주는 값은 (결과 이름 순서, 풀어 준 묶음 수). 묶음 하나가 OCR 지연 한 번이다.
    풀기 전에 정확히 묶음 크기만큼만 시작했는지 확인하므로, 동시 호출이 MAX_WORKERS를 넘거나
    모자라면(순차 포함) 여기서 실패한다.
    """
    names = [f"{i}.jpg" for i in range(count)]
    reader = GatedReader({name: READABLE for name in names})
    outcome: dict[str, Any] = {}

    def run() -> None:
        try:
            outcome["result"] = call(reader, names)
        except BaseException as error:  # 시험 스레드에서 확인하려고 담아 둔다
            outcome["error"] = error

    runner = threading.Thread(target=run, daemon=True)
    runner.start()
    done = waves = 0
    try:
        while done < count:
            size = min(MAX_WORKERS, count - done)
            with reader.cond:
                reached = reader.cond.wait_for(
                    partial(reader.at_wave, done + size, size), timeout=WAIT_SEC
                )
                assert reached, (
                    f"{waves + 1}번째 묶음에서 동시 호출이 {size}개가 아니다 "
                    f"(시작 {reader.started}, 대기 {reader.waiting})"
                )
                reader.permits += size  # OCR 지연 한 번이 지났다
                reader.cond.notify_all()
            done += size
            waves += 1
    finally:
        with reader.cond:  # 실패해도 멈춘 스레드가 남지 않게 모두 풀어 준다
            reader.permits += count
            reader.cond.notify_all()
    runner.join(WAIT_SEC)
    assert not runner.is_alive()
    assert "error" not in outcome, outcome.get("error")
    return outcome["result"], waves


@pytest.mark.parametrize("count", [1, MAX_WORKERS, MAX_WORKERS + 1, MAX_FILES])
def test_check_batch_takes_one_ocr_delay_per_wave_of_max_workers_files(count: int) -> None:
    names, waves = run_batch_by_waves(count)

    assert names == [f"{i}.jpg" for i in range(count)]
    assert waves == -(-count // MAX_WORKERS)  # ceil(count / MAX_WORKERS)


def test_check_full_batch_cumulative_delay_fits_the_nest_timeout() -> None:
    _, waves = run_batch_by_waves(MAX_FILES)

    parallel = waves * OCR_SECONDS_PER_FILE
    sequential = MAX_FILES * OCR_SECONDS_PER_FILE
    assert parallel == 75  # 5묶음 x 15초
    assert parallel <= NEST_TIMEOUT_SEC
    assert sequential > NEST_TIMEOUT_SEC  # 순차였다면 제한을 넘는 지연이다


def test_endpoint_full_batch_takes_one_ocr_delay_per_wave(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "ai_internal_token", SecretStr(TOKEN))

    names, waves = run_batch_by_waves(MAX_FILES, check_via_endpoint(monkeypatch))

    assert names == [f"{i}.jpg" for i in range(MAX_FILES)]
    assert waves == -(-MAX_FILES // MAX_WORKERS)
    assert waves * OCR_SECONDS_PER_FILE <= NEST_TIMEOUT_SEC


class CancelTrackingPool(ThreadPoolExecutor):
    """submit한 작업마다 cancel()이 불렸는지 세어, 모두 취소한 시점을 시험이 알 수 있게 한다."""

    cancel_calls = 0
    all_cancelled = threading.Event()
    submitted = 0

    def submit(self, fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Future[Any]:
        future = super().submit(fn, *args, **kwargs)
        cls = type(self)
        cls.submitted += 1
        cancel = future.cancel

        def tracked() -> bool:
            result = cancel()
            cls.cancel_calls += 1
            if cls.cancel_calls == cls.submitted:
                cls.all_cancelled.set()
            return result

        future.cancel = tracked  # type: ignore[method-assign]
        return future


def test_check_failure_ends_the_batch_without_paying_the_remaining_waves(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """첫 묶음에서 파일 하나가 일시 오류(503)로 끝나면 나머지 묶음의 지연을 치르지 않는다.

    0.jpg는 멈추지 않고 바로 실패하고, 같은 묶음의 나머지 호출은 풀어 주기 전까지 멈춰 있다.
    _check가 남은 작업을 모두 취소한 뒤에 풀어 주므로, 그 뒤로는 새 파일을 읽지 않는다.
    멈춘 호출은 다음 파일을 가져갈 수 없고, 실패한 0.jpg의 작업만 다음 파일 한 건(4.jpg)을
    가져갈 수 있어서 시작한 호출은 MAX_WORKERS + 1을 넘지 않는다.
    """
    CancelTrackingPool.cancel_calls = CancelTrackingPool.submitted = 0
    CancelTrackingPool.all_cancelled = threading.Event()
    monkeypatch.setattr(images, "ThreadPoolExecutor", CancelTrackingPool)
    names = [f"{i}.jpg" for i in range(MAX_FILES)]
    outcomes: dict[str, Any] = {name: READABLE for name in names}
    outcomes["0.jpg"] = OcrUnavailableError("HTTP 503")
    reader = GatedReader(outcomes, ungated=frozenset({"0.jpg"}))
    outcome: dict[str, Any] = {}

    def run() -> None:
        try:
            outcome["result"] = check_directly(reader, names)
        except BaseException as error:
            outcome["error"] = error

    runner = threading.Thread(target=run, daemon=True)
    runner.start()
    try:
        assert CancelTrackingPool.all_cancelled.wait(WAIT_SEC), "남은 작업을 취소하지 않았다"
        started_at_cancel = reader.started
    finally:
        with reader.cond:  # 멈춘 호출이 끝나야 _check가 돌아온다
            reader.permits += MAX_FILES
            reader.cond.notify_all()
    runner.join(WAIT_SEC)

    assert not runner.is_alive()
    error = outcome.get("error")
    assert isinstance(error, HTTPException)
    assert error.status_code == 503
    assert started_at_cancel <= MAX_WORKERS + 1
    assert reader.started == started_at_cancel  # 취소한 뒤로는 새 파일을 읽지 않았다
    assert "result" not in outcome


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


@pytest.mark.parametrize("raw", ["Bearer 한글토큰", f"Bearer {TOKEN}é", "Bearer 🔑"])
def test_endpoint_rejects_non_ascii_authorization_header_with_401(
    raw: str, monkeypatch: pytest.MonkeyPatch, internal_token: None
) -> None:
    created: list[object] = []
    monkeypatch.setattr(images, "docint", lambda: created.append(object()))

    # httpx는 문자열 헤더를 ASCII로만 보내므로, 실제 요청처럼 UTF-8 바이트로 직접 보낸다
    res = TestClient(app).post(
        "/internal/v1/images/check",
        json={"files": [{"name": "a.jpg", "uri": "https://blob.example.test/a.jpg"}]},
        headers={b"authorization": raw.encode()},
    )

    assert res.status_code == 401
    assert res.json() == {"detail": "Unauthorized"}
    assert created == []  # 인증에서 거부되어 OCR 클라이언트를 만들지 않는다


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
