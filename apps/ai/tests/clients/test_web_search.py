from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Any

import anthropic
import httpx2
import pytest
from google.genai import errors as genai_errors
from google.genai import types as genai_types
from pydantic import SecretStr

import app.clients.web_search as web_search_module
from app.clients.web_search import (
    FETCH_TOKENS,
    PAGE_CHARS,
    PAGE_SECONDS,
    ClaudeSearch,
    GeminiSearch,
    SearchError,
    answer_of,
    on_domains,
    web_search,
)
from app.core.config import settings
from app.services.note.seeds import search_seed


@dataclass
class Block:
    data: dict[str, Any]

    def model_dump(self) -> dict[str, Any]:
        return self.data


@dataclass
class Res:
    content: list[Block]
    stop_reason: str = "end_turn"


@dataclass
class Messages:
    """준비한 응답을 차례로 돌려주고 보낸 인자를 모음."""

    answers: list[Res | Exception]
    sent: list[dict[str, Any]] = field(default_factory=list)

    def create(self, **kw: Any) -> Res:
        self.sent.append(kw)
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


@dataclass
class Client:
    messages: Messages

    @property
    def beta(self) -> "Client":
        return self


def text(t: str, *cited: tuple[str, str]) -> Block:
    cs = [{"type": "web_search_result_location", "url": u, "cited_text": c} for u, c in cited]
    return Block({"type": "text", "text": t, "citations": cs or None})


FETCH = Block(
    {
        "type": "web_fetch_tool_result",
        "content": {
            "type": "web_fetch_result",
            "url": "https://a.test/glossary",
            "content": {
                "type": "document",
                "source": {"type": "text", "media_type": "text/plain", "data": "간흡충 폐흡충"},
            },
        },
    }
)


def search(*answers: Res | Exception) -> tuple[ClaudeSearch, Messages]:
    m = Messages(list(answers))
    return ClaudeSearch("key", "claude-opus-5-5", client=Client(m)), m


def test_answer_collects_text_and_evidence() -> None:
    a = answer_of(
        [
            text("- 간흡충\n", ("https://b.test", "간흡충은 ...")).data,
            FETCH.data,
            text("- 회충").data,
        ]
    )
    assert a["text"] == "- 간흡충\n- 회충"
    assert a["evidence"] == [
        {"url": "https://b.test", "text": "간흡충은 ..."},
        {"url": "https://a.test/glossary", "text": "간흡충 폐흡충"},
    ]


def test_search_sends_tools_with_domains() -> None:
    s, m = search(Res([text("- 간흡충")]))
    s.search("sys", "q", domains=["a.test"])
    (kw,) = m.sent
    assert [t["type"] for t in kw["tools"]] == ["web_search_20260209", "web_fetch_20260209"]
    assert all(t["allowed_domains"] == ["a.test"] for t in kw["tools"])
    assert kw["tools"][1]["max_content_tokens"] == FETCH_TOKENS  # 긴 페이지 비용 상한
    assert kw["fallbacks"] == "default"


def test_search_without_domains_has_no_filter() -> None:
    s, m = search(Res([text("x")]))
    s.search("sys", "q", domains=[])
    assert all("allowed_domains" not in t for t in m.sent[0]["tools"])


def test_pause_turn_resumes_with_the_paused_turn() -> None:
    first = [FETCH]
    s, m = search(Res(first, "pause_turn"), Res([text("- 간흡충")]))
    a = s.search("sys", "q", domains=[])
    assert m.sent[1]["messages"][1] == {"role": "assistant", "content": first}
    assert a["text"] == "- 간흡충" and len(a["evidence"]) == 1  # 두 응답을 합침


def test_second_pause_resends_every_earlier_turn() -> None:
    first, second = [FETCH], [text("- 간흡충\n")]
    s, m = search(Res(first, "pause_turn"), Res(second, "pause_turn"), Res([text("- 회충")]))
    a = s.search("sys", "q", domains=[])
    assert m.sent[2]["messages"][1] == {"role": "assistant", "content": first + second}
    assert a["text"] == "- 간흡충\n- 회충"


def test_refusal_and_api_errors_raise() -> None:
    s, _ = search(Res([], "refusal"))
    with pytest.raises(SearchError, match="refusal"):
        s.search("sys", "q", domains=[])
    req = httpx2.Request("POST", "https://api.test")
    s, _ = search(anthropic.APIConnectionError(request=req))
    with pytest.raises(SearchError):
        s.search("sys", "q", domains=[])


def test_endless_pause_raises() -> None:
    s, _ = search(*[Res([], "pause_turn") for _ in range(4)])
    with pytest.raises(SearchError, match="pause_turn"):
        s.search("sys", "q", domains=[])


# Gemini(Vertex AI) + 출처 페이지 직접 받기

REDIRECT = "https://grounding.test/r/"


def gemini_res(answer: str | None, *uris: str) -> genai_types.GenerateContentResponse:
    chunks = [genai_types.GroundingChunk(web=genai_types.GroundingChunkWeb(uri=u)) for u in uris]
    parts = [genai_types.Part(text=answer)] if answer is not None else []
    return genai_types.GenerateContentResponse(
        candidates=[
            genai_types.Candidate(
                content=genai_types.Content(role="model", parts=parts),
                grounding_metadata=genai_types.GroundingMetadata(grounding_chunks=chunks),
            )
        ]
    )


@dataclass
class Models:
    answers: list[genai_types.GenerateContentResponse | Exception]
    sent: list[dict[str, Any]] = field(default_factory=list)

    def generate_content(self, **kw: Any) -> genai_types.GenerateContentResponse:
        self.sent.append(kw)
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a


@dataclass
class GenaiClient:
    models: Models


PAGES = {
    "https://a.test/glossary": (
        "text/html; charset=utf-8",
        "<html><script>var x='회충';</script><p>간흡충 &amp; 폐흡충</p></html>",
    ),
    "https://b.test/other": ("text/html", "<p>요충</p>"),
    "https://a.test/file.pdf": ("application/pdf", "%PDF"),
}


def asked(req: httpx2.Request) -> str:
    """연결은 검사한 IP로 가므로, 원래 주소는 Host 헤더로 되살림."""
    return f"{req.url.scheme}://{req.headers['host']}{req.url.raw_path.decode()}"


def web(req: httpx2.Request) -> httpx2.Response:
    url = asked(req)
    if url.startswith(REDIRECT):
        return httpx2.Response(302, headers={"location": url.removeprefix(REDIRECT)})
    if url == "https://down.test/":
        raise httpx2.ConnectError("down", request=req)
    if url not in PAGES:
        return httpx2.Response(404)
    kind, body = PAGES[url]
    return httpx2.Response(200, headers={"content-type": kind}, text=body)


IDN = "한글.test".encode("idna").decode()  # xn--bj0bj06e.test
HOSTS = {"grounding.test", "a.test", "www.a.test", "b.test", "down.test", IDN}


def resolve(host: str) -> list[str]:
    """시험용 DNS: 바깥 사이트는 공인 주소, inside.test는 내부 주소, IP는 그대로."""
    if host in HOSTS:
        return ["93.184.216.34"]
    if host == "inside.test":
        return ["127.0.0.1"]
    if host[0].isdigit():
        return [host]
    raise OSError(host)


def gemini(
    *answers: genai_types.GenerateContentResponse | Exception,
    transport: httpx2.BaseTransport | None = None,
    clock: Callable[[], float] | None = None,
) -> tuple[GeminiSearch, Models]:
    m = Models(list(answers))
    s = GeminiSearch(
        "p",
        "global",
        "gemini-test",
        client=GenaiClient(m),
        transport=transport or httpx2.MockTransport(web),
        resolve=resolve,
        clock=clock,
    )
    return s, m


def test_gemini_reads_source_pages_behind_redirects() -> None:
    glossary = REDIRECT + "https://a.test/glossary"
    s, m = gemini(gemini_res("- 간흡충\n- 가짜충", glossary, glossary))
    a = s.search("sys", "q", domains=[])
    assert a["text"] == "- 간흡충\n- 가짜충"
    assert a["evidence"] == [{"url": "https://a.test/glossary", "text": "간흡충 & 폐흡충"}]
    (kw,) = m.sent
    assert kw["config"].tools[0].google_search is not None
    assert kw["config"].system_instruction == "sys"


def test_gemini_skips_failed_and_non_text_pages() -> None:
    uris = [
        REDIRECT + u
        for u in ("https://a.test/file.pdf", "https://a.test/none", "https://down.test/")
    ]
    s, _ = gemini(gemini_res("- 간흡충", *uris))
    assert s.search("sys", "q", domains=[])["evidence"] == []


def test_gemini_domains_limit_prompt_and_pages() -> None:
    uris = [REDIRECT + "https://a.test/glossary", REDIRECT + "https://b.test/other"]
    s, m = gemini(gemini_res("- 간흡충", *uris))
    a = s.search("sys", "q", domains=["a.test"])
    assert "a.test" in m.sent[0]["contents"]
    assert [e["url"] for e in a["evidence"]] == ["https://a.test/glossary"]


def test_gemini_errors_and_empty_answer_raise() -> None:
    s, _ = gemini(genai_errors.ServerError(503, {"error": {"message": "x"}}))
    with pytest.raises(SearchError):
        s.search("sys", "q", domains=[])
    s, _ = gemini(gemini_res(None))
    with pytest.raises(SearchError, match="빈 응답"):
        s.search("sys", "q", domains=[])


def test_gemini_seed_keeps_only_terms_on_the_fetched_page() -> None:
    s, _ = gemini(gemini_res("- 간흡충\n- 가짜충", REDIRECT + "https://a.test/glossary"))
    seed = search_seed(s, "기생충학", "흡충류", [])
    assert seed["terms"] == [{"term": "간흡충", "url": "https://a.test/glossary"}]


@pytest.mark.parametrize(
    ("url", "ok"),
    [("https://a.test/x", True), ("https://www.a.test/x", True), ("https://ba.test/x", False)],
)
def test_on_domains_matches_subdomains_only(url: str, ok: bool) -> None:
    assert on_domains(url, ["a.test"]) is ok


def test_web_search_picks_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "google_cloud_project", "")
    monkeypatch.setattr(settings, "anthropic_api_key", SecretStr(""))
    assert web_search("gemini") is None and web_search("claude") is None
    monkeypatch.setattr(settings, "google_cloud_project", "p")
    monkeypatch.setattr(settings, "anthropic_api_key", SecretStr("k"))
    monkeypatch.setattr(web_search_module.genai, "Client", lambda **_: object())
    assert isinstance(web_search("gemini"), GeminiSearch)
    assert isinstance(web_search("claude"), ClaudeSearch)


def test_gemini_never_requests_internal_addresses() -> None:
    sent: list[str] = []

    def spy(req: httpx2.Request) -> httpx2.Response:
        sent.append(req.headers["host"])
        return web(req)

    uris = [REDIRECT + "http://inside.test/secret", "http://169.254.169.254/latest"]
    s, _ = gemini(gemini_res("- 간흡충", *uris), transport=httpx2.MockTransport(spy))
    assert s.search("sys", "q", domains=[])["evidence"] == []
    assert sent == ["grounding.test"]  # 리디렉트 목적지(내부 주소)는 요청하지 않음


def test_gemini_stops_reading_large_or_skipped_pages() -> None:
    pulled = {"big": 0, "pdf": 0}

    def body(name: str, chunk: bytes) -> Iterator[bytes]:
        for _ in range(100):
            pulled[name] += 1
            yield chunk

    def big(req: httpx2.Request) -> httpx2.Response:
        if req.url.path == "/big":
            return httpx2.Response(
                200,
                headers={"content-type": "text/html"},
                content=body("big", "가".encode() * 50000),
            )
        return httpx2.Response(
            200, headers={"content-type": "application/pdf"}, content=body("pdf", b"x" * 50000)
        )

    uris = ["https://a.test/big", "https://a.test/file.pdf"]
    s, _ = gemini(gemini_res("- 간흡충", *uris), transport=httpx2.MockTransport(big))
    (page,) = s.search("sys", "q", domains=[])["evidence"]
    assert len(page["text"]) <= PAGE_CHARS
    assert pulled["big"] < 100 and pulled["pdf"] == 0


def test_gemini_connects_to_the_checked_ip() -> None:
    """검사 뒤 DNS 답이 내부 주소로 바뀌어도 연결은 검사한 공인 IP로 감(DNS 재바인딩)."""
    answers = {"a.test": [["93.184.216.34"], ["127.0.0.1"]]}
    sent: list[httpx2.Request] = []

    def rebinding(host: str) -> list[str]:
        return answers[host].pop(0) if host in answers else resolve(host)

    def spy(req: httpx2.Request) -> httpx2.Response:
        sent.append(req)
        return web(req)

    m = Models([gemini_res("- 간흡충", "https://a.test/glossary")])
    s = GeminiSearch(
        "p",
        "global",
        "m",
        client=GenaiClient(m),
        transport=httpx2.MockTransport(spy),
        resolve=rebinding,
    )
    (page,) = s.search("sys", "q", domains=["a.test"])["evidence"]
    assert page["url"] == "https://a.test/glossary"
    (req,) = sent
    assert req.url.host == "93.184.216.34" and req.headers["host"] == "a.test"
    assert req.extensions["sni_hostname"] == "a.test"  # 인증서는 원래 이름으로 확인
    assert answers["a.test"] == [["127.0.0.1"]]  # DNS는 검사할 때 한 번만 봄


def test_gemini_skips_malformed_urls_and_keeps_going() -> None:
    def bad_location(req: httpx2.Request) -> httpx2.Response:
        if asked(req) == "https://b.test/other":
            return httpx2.Response(302, headers={"location": "https://["})
        return web(req)

    uris = ["https://[", "https://b.test/other", REDIRECT + "https://a.test/glossary"]
    s, _ = gemini(gemini_res("- 간흡충", *uris), transport=httpx2.MockTransport(bad_location))
    a = s.search("sys", "q", domains=[])
    assert [e["url"] for e in a["evidence"]] == ["https://a.test/glossary"]


def test_gemini_gives_up_on_slow_pages_and_keeps_going() -> None:
    """조금씩 천천히 보내는 페이지는 PAGE_SECONDS에서 버리고 다음 출처를 받음."""
    now = [0.0]
    pulled = [0]

    def drip() -> Iterator[bytes]:
        for _ in range(100):
            pulled[0] += 1
            now[0] += 10  # 조각마다 10초
            yield "가".encode()

    def slow(req: httpx2.Request) -> httpx2.Response:
        if req.url.path == "/slow":
            return httpx2.Response(200, headers={"content-type": "text/html"}, content=drip())
        return web(req)

    uris = ["https://a.test/slow", "https://a.test/glossary"]
    s, _ = gemini(
        gemini_res("- 간흡충", *uris), transport=httpx2.MockTransport(slow), clock=lambda: now[0]
    )
    a = s.search("sys", "q", domains=[])
    assert [e["url"] for e in a["evidence"]] == ["https://a.test/glossary"]
    assert pulled[0] <= PAGE_SECONDS // 10 + 1


def test_gemini_tries_the_next_checked_ip() -> None:
    sent: list[str] = []

    def two(host: str) -> list[str]:
        return ["93.184.216.34", "93.184.216.35"] if host == "a.test" else resolve(host)

    def first_down(req: httpx2.Request) -> httpx2.Response:
        sent.append(req.url.host)
        if req.url.host == "93.184.216.34":
            raise httpx2.ConnectError("down", request=req)
        return web(req)

    m = Models([gemini_res("- 간흡충", "https://a.test/glossary")])
    s = GeminiSearch(
        "p",
        "global",
        "m",
        client=GenaiClient(m),
        transport=httpx2.MockTransport(first_down),
        resolve=two,
    )
    (page,) = s.search("sys", "q", domains=[])["evidence"]
    assert page["url"] == "https://a.test/glossary"
    assert sent == ["93.184.216.34", "93.184.216.35"]


def test_gemini_reads_hangul_domains() -> None:
    hosts: list[str] = []

    def idn(req: httpx2.Request) -> httpx2.Response:
        hosts.append(req.headers["host"])
        return httpx2.Response(200, headers={"content-type": "text/html"}, text="<p>간흡충</p>")

    s, _ = gemini(
        gemini_res("- 간흡충", "https://한글.test/용어"), transport=httpx2.MockTransport(idn)
    )
    (page,) = s.search("sys", "q", domains=[])["evidence"]
    assert page == {"url": "https://한글.test/용어", "text": "간흡충"}
    assert hosts == [IDN]


def test_gemini_page_requests_carry_contact_user_agent() -> None:
    agents: list[str] = []

    def spy(req: httpx2.Request) -> httpx2.Response:
        agents.append(req.headers["user-agent"])
        return web(req)

    s, _ = gemini(
        gemini_res("- 간흡충", REDIRECT + "https://a.test/glossary"),
        transport=httpx2.MockTransport(spy),
    )
    s.search("sys", "q", domains=[])
    assert len(agents) == 2  # 리디렉트와 목적지 페이지 모두
    assert all("https://github.com/teamNoteLink/NoteLink" in a for a in agents)
