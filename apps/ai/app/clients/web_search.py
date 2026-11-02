"""웹 검색 LLM. 시드 용어를 출처와 함께 찾을 때만 씀(Claude 또는 Gemini, 설정으로 고름).

답 글과 함께 출처 원문을 돌려줘서, 용어가 출처에 실제로 있는지는 부르는 쪽 코드가 검사함.
"""

import html
import re
from typing import Any, Literal, Protocol, TypedDict
from urllib.parse import urlparse

import anthropic
import httpx2
from google import genai
from google.genai import errors as genai_errors
from google.genai import types as genai_types

from app.clients.llm import USER_AGENT
from app.core.config import settings

type Provider = Literal["gemini", "claude"]

PAUSE_MAX = 3  # 서버 쪽 검색이 길어 멈추면(pause_turn) 이어 가는 횟수
FETCH_TOKENS = 10000  # 가져온 페이지 하나에서 읽는 최대 토큰(긴 교재 페이지 비용 막기)
PAGES_MAX = 8  # Gemini 답의 출처 페이지를 직접 받는 최대 수
PAGE_CHARS = 40000  # 받은 페이지 하나에서 쓰는 최대 글자 수


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


def answer_of(blocks: list[dict[str, Any]]) -> SearchAnswer:
    """Claude 응답 블록 → 답 글 + 출처 원문. 글 블록은 인용 경계에서 나뉘므로 그대로 이어 붙임."""
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


class GeminiSearch:
    """Vertex AI Gemini + Google 검색. 응답에 출처 원문이 없어 출처 페이지를 직접 받음."""

    def __init__(
        self,
        project: str,
        location: str,
        model: str,
        *,
        client: Any = None,
        transport: httpx2.BaseTransport | None = None,
    ) -> None:
        self._client = client or genai.Client(vertexai=True, project=project, location=location)
        self._model = model
        self._http = httpx2.Client(
            headers={"User-Agent": USER_AGENT},
            timeout=20.0,
            follow_redirects=True,  # 출처 주소는 Google 리디렉트 주소
            transport=transport,
        )

    def search(self, system: str, user: str, *, domains: list[str]) -> SearchAnswer:
        """domains가 있으면 그 사이트만 찾게 하고, 받은 페이지도 그 사이트 것만 씀."""
        if domains:
            user += "\n다음 사이트에서만 찾아라: " + ", ".join(domains)
        config = genai_types.GenerateContentConfig(
            system_instruction=system,
            tools=[genai_types.Tool(google_search=genai_types.GoogleSearch())],
        )
        try:
            res = self._client.models.generate_content(
                model=self._model, contents=user, config=config
            )
        except genai_errors.APIError as e:
            raise SearchError(type(e).__name__) from e
        text = res.text
        if not text:
            raise SearchError("빈 응답")  # 안전 차단 등
        return {"text": text, "evidence": self._pages(grounding_uris(res), domains)}

    def _pages(self, uris: list[str], domains: list[str]) -> list[Evidence]:
        out: list[Evidence] = []
        for uri in uris[:PAGES_MAX]:
            try:
                res = self._http.get(uri)
            except httpx2.HTTPError:
                continue  # 못 받은 출처는 근거에서 뺌
            url = str(res.url)
            kind = res.headers.get("content-type", "")
            if res.status_code != 200 or not kind.startswith("text/"):
                continue
            if domains and not on_domains(url, domains):
                continue
            out.append({"url": url, "text": page_text(res.text)[:PAGE_CHARS]})
        return out


def grounding_uris(res: Any) -> list[str]:
    """Gemini 응답의 검색 출처 주소(중복 없이, 나온 순서)."""
    uris: list[str] = []
    for cand in res.candidates or []:
        meta = cand.grounding_metadata
        for chunk in (meta.grounding_chunks if meta else None) or []:
            if chunk.web and chunk.web.uri:
                uris.append(chunk.web.uri)
    return list(dict.fromkeys(uris))


def on_domains(url: str, domains: list[str]) -> bool:
    host = urlparse(url).hostname or ""
    return any(host == d or host.endswith("." + d) for d in domains)


def page_text(markup: str) -> str:
    """HTML → 글. 스크립트 · 스타일은 버리고 태그 자리는 줄바꿈."""
    t = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1>", " ", markup)
    t = re.sub(r"(?s)<[^>]+>", "\n", t)
    t = html.unescape(t)
    return re.sub(r"\n\s*\n+", "\n", re.sub(r"[ \t\r\f\v]+", " ", t)).strip()


def web_search(provider: Provider | None = None) -> Searcher | None:
    """설정한 검색 LLM. 키 · 프로젝트가 없으면 None(있는 시드로만 처리)."""
    match provider or settings.seed_search_provider:
        case "claude":
            key = settings.anthropic_api_key.get_secret_value()
            if not key:
                return None
            return ClaudeSearch(
                key, settings.seed_search_claude_model, max_uses=settings.seed_search_max_uses
            )
        case "gemini":
            if not settings.google_cloud_project:
                return None
            return GeminiSearch(
                settings.google_cloud_project,
                settings.google_cloud_location,
                settings.seed_search_gemini_model,
            )
