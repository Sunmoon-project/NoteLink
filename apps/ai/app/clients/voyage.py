"""Voyage 임베딩 클라이언트. 문서는 'document', 검색어는 'query'."""

import time
from collections.abc import Callable
from typing import Literal

import httpx2

from app.clients.llm import USER_AGENT
from app.core.config import settings

type InputType = Literal["document", "query"]

BATCH = 64  # 한 번에 보내는 글 수


class EmbedError(Exception):
    """다시 보내도 임베딩을 받지 못함."""


class Voyage:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        model: str,
        *,
        retries: int = 2,
        timeout: float = 60.0,
        transport: httpx2.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._client = httpx2.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}", "User-Agent": USER_AGENT},
            timeout=timeout,
            transport=transport,
        )
        self._model = model
        self._retries = retries
        self._sleep = sleep

    def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        """글마다 벡터 하나(같은 순서). 빈 목록이면 빈 목록."""
        out: list[list[float]] = []
        for i in range(0, len(texts), BATCH):
            out += self._batch(texts[i : i + BATCH], input_type)
        return out

    def _batch(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        body = {"model": self._model, "input": texts, "input_type": input_type}
        err = "retries"
        for attempt in range(self._retries + 1):
            try:
                res = self._client.post("/embeddings", json=body)
            except httpx2.TransportError as e:
                err = type(e).__name__
                self._sleep(2 * (attempt + 1))
                continue
            if res.status_code == 429 or res.status_code >= 500:
                err = f"HTTP {res.status_code}"
                self._sleep(float(res.headers.get("retry-after") or 2 * (attempt + 1)))
                continue
            if res.status_code != 200:
                raise EmbedError(f"HTTP {res.status_code}")  # 키 · 입력 오류는 다시 보내도 같음
            return _vectors(res, len(texts))
        raise EmbedError(err)


def _vectors(res: httpx2.Response, n: int) -> list[list[float]]:
    try:
        data = sorted(res.json()["data"], key=lambda d: d["index"])
        vectors = [[float(x) for x in d["embedding"]] for d in data]
    except (ValueError, KeyError, TypeError) as e:
        raise EmbedError("응답 모양") from e
    if len(vectors) != n:
        raise EmbedError(f"벡터 {len(vectors)}개 (보낸 글 {n}개)")
    return vectors


def voyage() -> Voyage:
    key = settings.voyage_api_key.get_secret_value()
    if not key:
        raise EmbedError("VOYAGE_API_KEY가 비어 있음")
    return Voyage(settings.voyage_base_url, key, settings.voyage_model)
