import json

import httpx2
import pytest

from app.clients.voyage import BATCH, EmbedError, Voyage


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


def test_embed_does_not_retry_bad_key() -> None:
    s = Server(httpx2.Response(401))
    with pytest.raises(EmbedError, match="401"):
        s.client().embed(["글"], "document")
    assert len(s.requests) == 1


def test_embed_rejects_wrong_vector_count() -> None:
    s = Server(vectors(1))
    with pytest.raises(EmbedError):
        s.client().embed(["가", "나"], "document")


def test_empty_input_sends_nothing() -> None:
    s = Server()
    assert s.client().embed([], "document") == []
