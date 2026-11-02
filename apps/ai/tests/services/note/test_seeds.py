from dataclasses import dataclass, field

import pytest

from app.clients.llm import LlmError
from app.clients.web_search import Evidence, SearchAnswer, SearchError
from app.services.note.chunking import split_rows
from app.services.note.seeds import (
    TopicSeed,
    listed_terms,
    parse_topics,
    seed_terms,
    verify,
)
from tests.fakes import FakeLlm
from tests.services.note.helpers import rows


@dataclass
class FakeSearch:
    answers: list[SearchAnswer | SearchError]
    asked: list[str] = field(default_factory=list)

    def search(self, system: str, user: str, *, domains: list[str]) -> SearchAnswer:
        self.asked.append(user)
        a = self.answers.pop(0)
        if isinstance(a, SearchError):
            raise a
        return a


def ev(text: str, url: str = "https://a.test") -> Evidence:
    return {"url": url, "text": text}


KNOWN: list[TopicSeed] = [
    {"topic": "흡충류", "terms": [{"term": "간흡충", "url": "u"}, {"term": "폐흡충", "url": "u"}]}
]
NOTE = split_rows(rows("Ⅲ. 흡충류", "1. 간흠충", "- 포남형", "2. 원충", "- 이질 아메바"))


def test_parse_topics_known_by_number_new_by_name() -> None:
    answer = {"topics": [{"choice": 1, "name": ""}, {"choice": 0, "name": " 원충류 "}]}
    assert parse_topics(answer, ["흡충류"]) == ["흡충류", "원충류"]


@pytest.mark.parametrize(
    "item",
    [{"choice": 5, "name": ""}, {"choice": 0, "name": ""}, {"choice": 0, "name": "가" * 31}, "x"],
)
def test_bad_topics_are_ignored(item: object) -> None:
    assert parse_topics({"topics": [item]}, ["흡충류"]) == []


def test_missing_topics_raise() -> None:
    with pytest.raises(LlmError):
        parse_topics({"names": []}, [])


def test_listed_terms_keep_the_term_only() -> None:
    text = (
        "- 간흡충 (Clonorchis sinensis)\n2. 피낭유충: 감염형\n* Taenia\n"
        "- 긴 설명이 붙은 문장은 용어가 아님"
    )
    assert listed_terms(text) == ["간흡충", "피낭유충"]


def test_verify_keeps_only_terms_in_the_source() -> None:
    out = verify(["간흡충", "주혈선모충", "이질 아메바"], [ev("간흡충과 이질아메바", "https://b")])
    assert out == [
        {"term": "간흡충", "url": "https://b"},
        {"term": "이질 아메바", "url": "https://b"},
    ]


def test_seed_terms_reuses_known_and_searches_new_topics_only() -> None:
    llm = FakeLlm(
        {"note_topics": [{"topics": [{"choice": 1, "name": ""}, {"choice": 0, "name": "원충류"}]}]}
    )
    s = FakeSearch([{"text": "- 이질아메바\n- 지어낸충", "evidence": [ev("이질아메바 포낭형")]}])
    terms, new = seed_terms(llm, "m", s, NOTE, "기생충학", KNOWN, [])
    assert len(s.asked) == 1 and "원충류" in s.asked[0]  # 흡충류는 이미 있어 검색 안 함
    assert new == [{"topic": "원충류", "terms": [{"term": "이질아메바", "url": "https://a.test"}]}]
    assert {"간흡충", "폐흡충", "이질아메바"} <= set(terms.terms) and "지어낸충" not in terms
    assert "1. 간흠충" in llm.calls[0].user and "포남형" not in llm.calls[0].user  # 제목만 보냄


def test_search_failure_or_no_searcher_uses_known_seeds_only() -> None:
    answer = {"topics": [{"choice": 1, "name": ""}, {"choice": 0, "name": "원충류"}]}
    for searcher in (FakeSearch([SearchError("refusal")]), None):
        llm = FakeLlm({"note_topics": [answer]})
        terms, new = seed_terms(llm, "m", searcher, NOTE, "기생충학", KNOWN, [])
        assert new == [] and set(terms.terms) == {"간흡충", "폐흡충"}


def test_note_without_headings_sends_first_lines() -> None:
    cs = split_rows(rows("- 간흠충은 민물고기로 감염", "- 피낭유충", "- 세 번째 줄"))
    llm = FakeLlm({"note_topics": [{"topics": [{"choice": 1, "name": ""}]}]})
    terms, _ = seed_terms(llm, "m", None, cs, "기생충학", KNOWN, [])
    user = llm.calls[0].user
    assert "간흠충은 민물고기로 감염" in user and "세 번째 줄" not in user
    assert set(terms.terms) == {"간흡충", "폐흡충"}


def test_no_topics_uses_all_input_seeds() -> None:
    llm = FakeLlm({"note_topics": [{"topics": []}]})
    terms, new = seed_terms(llm, "m", None, NOTE, "기생충학", KNOWN, [])
    assert new == [] and set(terms.terms) == {"간흡충", "폐흡충"}


def test_unverified_seed_is_not_returned() -> None:
    llm = FakeLlm({"note_topics": [{"topics": [{"choice": 0, "name": "원충류"}]}]})
    s = FakeSearch([{"text": "- 지어낸충", "evidence": []}])
    terms, new = seed_terms(llm, "m", s, NOTE, "기생충학", [], [])
    assert new == [] and len(terms) == 0
