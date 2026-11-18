import json
from datetime import UTC, datetime

import httpx2
import pytest

from app.clients.voyage import BATCH, EmbedError, EmbedUnavailableError, Voyage, _retry_after


class Server:
    """보낸 요청을 모아 두고 준비한 응답을 차례로 돌려주는 가짜 서버."""

    def __init__(self, *responses: httpx2.Response) -> None:
        self.responses = list(responses)
        self.requests: list[httpx2.Request] = []
        self.slept: list[float] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        return self.responses.pop(0)

    def client(self) -> Voyage:
        return Voyage(
            "https://example.test/v1/",
            "key",
            "voyage-4",
            transport=httpx2.MockTransport(self.handle),
            sleep=self.slept.append,
        )


def vectors(n: int, dim: int = 3) -> httpx2.Response:
    data = [{"index": i, "embedding": [float(i)] * dim} for i in reversed(range(n))]
    return httpx2.Response(200, json={"data": data})


def test_embed_sends_model_and_input_type_and_keeps_order() -> None:
    s = Server(vectors(2))
    out = s.client().embed(["가", "나"], "document")
    assert out == [[0.0, 0.0, 0.0], [1.0, 1.0, 1.0]]  # index 순서로 정렬
    body = json.loads(s.requests[0].content)
    assert body == {"model": "voyage-4", "input": ["가", "나"], "input_type": "document"}
    assert s.requests[0].url.path == "/v1/embeddings"


def test_embed_splits_into_batches() -> None:
    s = Server(vectors(BATCH), vectors(1))
    assert len(s.client().embed(["글"] * (BATCH + 1), "document")) == BATCH + 1
    assert len(s.requests) == 2


def test_embed_retries_rate_limit_then_succeeds() -> None:
    s = Server(httpx2.Response(429, headers={"retry-after": "3"}), vectors(1))
    assert len(s.client().embed(["글"], "query")) == 1
    assert s.slept == [3.0]


@pytest.mark.parametrize("value", ["Wed, 21 Oct 2026 07:28:00 GMT", "soon", "nan", "inf", ""])
def test_embed_retries_odd_retry_after_instead_of_failing(value: str) -> None:
    # 날짜 형식 · 읽을 수 없는 Retry-After가 ValueError로 작업을 실패시키지 않음(#498)
    s = Server(httpx2.Response(503, headers={"retry-after": value}), vectors(1))
    assert len(s.client().embed(["글"], "query")) == 1
    assert len(s.slept) == 1
    assert s.slept[0] >= 1.0


def test_embed_gives_up_as_unavailable_with_date_retry_after() -> None:
    date = "Wed, 21 Oct 2026 07:28:00 GMT"
    s = Server(*(httpx2.Response(429, headers={"retry-after": date}) for _ in range(3)))
    with pytest.raises(EmbedUnavailableError, match="429"):
        s.client().embed(["글"], "document")


def test_retry_after_reads_seconds_and_http_date() -> None:
    now = datetime(2026, 10, 21, 7, 28, 0, tzinfo=UTC)
    assert _retry_after("3", 2.0) == 3.0
    assert _retry_after("Wed, 21 Oct 2026 07:28:30 GMT", 2.0, now) == 30.0
    assert _retry_after("Wed, 21 Oct 2026 07:28:30 -0000", 2.0, now) == 30.0  # 시간대 없음 → UTC
    assert _retry_after("Wed, 21 Oct 2026 07:27:00 GMT", 2.0, now) == 1.0  # 지난 날짜
    assert _retry_after("0", 2.0) == 1.0
    assert _retry_after(None, 4.0) == 4.0  # 없으면 지금처럼 2 * (시도 + 1)
    assert _retry_after("곧", 4.0) == 4.0
    assert _retry_after("inf", 4.0) == 4.0
    assert _retry_after("nan", 4.0) == 4.0


def test_embed_does_not_retry_bad_key() -> None:
    s = Server(httpx2.Response(401))
    with pytest.raises(EmbedError, match="401"):
        s.client().embed(["글"], "document")
    assert len(s.requests) == 1


@pytest.mark.parametrize("status", [429, 503])
def test_embed_gives_up_on_temporary_error_as_unavailable(status: int) -> None:
    s = Server(*(httpx2.Response(status) for _ in range(3)))
    with pytest.raises(EmbedUnavailableError, match=str(status)):
        s.client().embed(["글"], "document")


def test_embed_gives_up_on_connection_error_as_unavailable() -> None:
    def refuse(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("끊김")

    client = Voyage(
        "https://example.test",
        "key",
        "voyage-4",
        transport=httpx2.MockTransport(refuse),
        sleep=lambda _: None,
    )
    with pytest.raises(EmbedUnavailableError):
        client.embed(["글"], "document")


@pytest.mark.parametrize("status", [400, 401, 403])
def test_permanent_error_is_not_unavailable(status: int) -> None:
    s = Server(httpx2.Response(status))
    with pytest.raises(EmbedError) as e:
        s.client().embed(["글"], "document")
    assert not isinstance(e.value, EmbedUnavailableError)


def test_bad_response_shape_is_not_unavailable() -> None:
    s = Server(httpx2.Response(200, json={"data": "글"}))
    with pytest.raises(EmbedError) as e:
        s.client().embed(["글"], "document")
    assert not isinstance(e.value, EmbedUnavailableError)


def test_embed_rejects_wrong_vector_count() -> None:
    s = Server(vectors(1))
    with pytest.raises(EmbedError):
        s.client().embed(["가", "나"], "document")


def test_empty_input_sends_nothing() -> None:
    s = Server()
    assert s.client().embed([], "document") == []
