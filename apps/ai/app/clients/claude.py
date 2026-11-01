"""Claude API 웹 검색. 시드 용어를 출처와 함께 찾을 때만 씀.

답 글과 함께 출처 원문(인용 문장 · 가져온 페이지 글)을 돌려줘서, 용어가 출처에 실제로 있는지는
부르는 쪽 코드가 검사함.
"""

from typing import Any, Protocol, TypedDict

import anthropic

from app.core.config import settings

PAUSE_MAX = 3  # 서버 쪽 검색이 길어 멈추면(pause_turn) 이어 가는 횟수
FETCH_TOKENS = 10000  # 가져온 페이지 하나에서 읽는 최대 토큰(긴 교재 페이지 비용 막기)


class SearchError(Exception):
    """검색 답을 받지 못함(오류 · 거절 · 멈춤)."""


class Evidence(TypedDict):
    url: str
    text: str  # 출처 원문 일부(인용 문장이나 가져온 페이지 글)


class SearchAnswer(TypedDict):
    text: str
    evidence: list[Evidence]


class Searcher(Protocol):
    def search(self, system: str, user: str, *, domains: list[str]) -> SearchAnswer: ...


class ClaudeSearch:
    def __init__(self, api_key: str, model: str, *, max_uses: int = 5, client: Any = None) -> None:
        self._client = client or anthropic.Anthropic(api_key=api_key)
        self._model = model
        self._max_uses = max_uses

    def search(self, system: str, user: str, *, domains: list[str]) -> SearchAnswer:
        """domains가 있으면 그 사이트만 검색 · 가져오기."""
        limit: dict[str, Any] = {"max_uses": self._max_uses}
        if domains:
            limit["allowed_domains"] = domains
        tools: list[Any] = [
            {"type": "web_search_20260209", "name": "web_search", **limit},
            {
                "type": "web_fetch_20260209",
                "name": "web_fetch",
                "max_content_tokens": FETCH_TOKENS,
                **limit,
            },
        ]
        messages: list[Any] = [{"role": "user", "content": user}]
        blocks: list[Any] = []
        for _ in range(PAUSE_MAX + 1):
            try:
                res = self._client.beta.messages.create(
                    model=self._model,
                    max_tokens=16000,
                    system=system,
                    tools=tools,
                    messages=messages,
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",  # 안전 분류기가 거절하면 다른 모델로 이어 감
                )
            except anthropic.APIError as e:
                raise SearchError(type(e).__name__) from e
            blocks += res.content
            if res.stop_reason == "refusal":
                raise SearchError("refusal")
            if res.stop_reason != "pause_turn":
                return answer_of([b.model_dump() for b in blocks])
            # 지금까지 받은 차례를 모두 붙여 보내면 서버가 이어서 함(두 번째 멈춤에도 앞 검색 유지)
            messages = [messages[0], {"role": "assistant", "content": list(blocks)}]
        raise SearchError("pause_turn")


def claude_search() -> ClaudeSearch | None:
    """키가 없으면 None(시드 검색 없이 있는 시드로만 처리)."""
    key = settings.anthropic_api_key.get_secret_value()
    if not key:
        return None
    return ClaudeSearch(key, settings.seed_search_model, max_uses=settings.seed_search_max_uses)


def answer_of(blocks: list[dict[str, Any]]) -> SearchAnswer:
    """응답 블록 → 답 글 + 출처 원문. 글 블록은 인용 경계에서 나뉘므로 그대로 이어 붙임."""
    text = "".join(b.get("text") or "" for b in blocks if b.get("type") == "text")
    evidence: list[Evidence] = []
    _walk(blocks, "", evidence)
    return {"text": text, "evidence": evidence}


def _walk(obj: object, url: str, out: list[Evidence]) -> None:
    if isinstance(obj, list):
        for x in obj:
            _walk(x, url, out)
        return
    if not isinstance(obj, dict):
        return
    url = obj["url"] if isinstance(obj.get("url"), str) else url
    if isinstance(obj.get("cited_text"), str):
        out.append({"url": url, "text": obj["cited_text"]})
    src = obj.get("source")
    if isinstance(src, dict) and src.get("type") == "text" and isinstance(src.get("data"), str):
        out.append({"url": url, "text": src["data"]})  # web_fetch로 가져온 페이지 글
    for v in obj.values():
        if isinstance(v, (dict, list)):
            _walk(v, url, out)
