from dataclasses import dataclass, field
from typing import Any

import anthropic
import httpx2
import pytest

from app.clients.claude import FETCH_TOKENS, ClaudeSearch, SearchError, answer_of


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
