import pytest

from app.clients.llm import LlmError
from app.services.note.chunking import split_rows
from app.services.note.seeds import (
    TOPIC_SCHEMA,
    TopicSeed,
    parse_topics,
    seed_terms,
)
from tests.fakes import FakeLlm
from tests.services.note.helpers import rows

KNOWN: list[TopicSeed] = [{"topic": "흡충류", "terms": [{"term": "간흡충"}, {"term": "폐흡충"}]}]
NOTE = split_rows(rows("Ⅲ. 흡충류", "1. 간흠충", "- 포남형", "2. 원충", "- 이질 아메바"))


def test_parse_topics_keeps_known_by_number_only() -> None:
    answer = {"topics": [{"choice": 1}, {"choice": 0, "name": " 원충류 "}]}
    assert parse_topics(answer, ["흡충류"]) == ["흡충류"]


@pytest.mark.parametrize(
    "item",
    [
        {"choice": 5},
        {"choice": 0},
        {"choice": 0, "name": "원충류"},
        {"choice": True},
        {"choice": "1"},
        "x",
    ],
)
def test_bad_topics_are_ignored(item: object) -> None:
    assert parse_topics({"topics": [item]}, ["흡충류"]) == []


def test_empty_topics_stays_empty() -> None:
    assert parse_topics({"topics": []}, ["흡충류"]) == []


def test_missing_topics_raise() -> None:
    with pytest.raises(LlmError):
        parse_topics({"names": []}, [])


def test_topic_answer_has_no_new_topic_name() -> None:
    items = TOPIC_SCHEMA["properties"]["topics"]["items"]
    assert list(items["properties"]) == ["choice"]


def test_seed_terms_reuses_known_from_headings_only() -> None:
    llm = FakeLlm({"note_topics": [{"topics": [{"choice": 1}]}]})
    terms = seed_terms(llm, "m", NOTE, "기생충학", KNOWN)
    assert set(terms.terms) == {"간흡충", "폐흡충"}
    assert "1. 간흠충" in llm.calls[0].user and "포남형" not in llm.calls[0].user  # 제목만 보냄
    assert "1) 흡충류" in llm.calls[0].user


def test_seed_terms_uses_picked_topics_only() -> None:
    seeds: list[TopicSeed] = [*KNOWN, {"topic": "선충류", "terms": [{"term": "회충"}]}]
    llm = FakeLlm({"note_topics": [{"topics": [{"choice": 2}]}]})
    assert seed_terms(llm, "m", NOTE, "기생충학", seeds).terms == ["회충"]


def test_unknown_topic_next_to_known_is_not_used() -> None:
    answer = {"topics": [{"choice": 1}, {"choice": 0, "name": "원충류"}, {"choice": 9}]}
    llm = FakeLlm({"note_topics": [answer]})
    terms = seed_terms(llm, "m", NOTE, "기생충학", KNOWN)
    assert set(terms.terms) == {"간흡충", "폐흡충"} and len(llm.calls) == 1


@pytest.mark.parametrize("item", [{"choice": 0}, {"choice": 0, "name": "원충류"}, {"choice": 9}])
def test_note_outside_the_seed_book_gets_no_terms(item: dict[str, object]) -> None:
    # 다른 단원 용어로 고치지 않음(모든 시드로 물러나지 않음)
    llm = FakeLlm({"note_topics": [{"topics": [item]}]})
    assert len(seed_terms(llm, "m", NOTE, "기생충학", KNOWN)) == 0


def test_note_without_headings_sends_first_lines() -> None:
    cs = split_rows(rows("- 간흠충은 민물고기로 감염", "- 피낭유충", "- 세 번째 줄"))
    llm = FakeLlm({"note_topics": [{"topics": [{"choice": 1}]}]})
    terms = seed_terms(llm, "m", cs, "기생충학", KNOWN)
    user = llm.calls[0].user
    assert "간흠충은 민물고기로 감염" in user and "세 번째 줄" not in user
    assert set(terms.terms) == {"간흡충", "폐흡충"}


def test_empty_topic_answer_uses_no_seeds() -> None:
    llm = FakeLlm({"note_topics": [{"topics": []}]})
    assert len(seed_terms(llm, "m", NOTE, "기생충학", KNOWN)) == 0


def test_blank_note_uses_all_input_seeds_without_llm() -> None:
    llm = FakeLlm()
    assert set(seed_terms(llm, "m", [], "기생충학", KNOWN).terms) == {"간흡충", "폐흡충"}
    assert llm.calls == []


@pytest.mark.parametrize(
    "seeds",
    [
        [],
        [{"topic": "흡충류", "terms": []}],
        [{"topic": "흡충류", "terms": [{"term": "Taenia"}]}],  # 사전에 들어가는 한글 용어가 없음
    ],
)
def test_no_usable_seed_skips_the_topic_llm(seeds: list[TopicSeed]) -> None:
    llm = FakeLlm()
    assert len(seed_terms(llm, "m", NOTE, "기생충학", seeds)) == 0
    assert llm.calls == []


def test_empty_seed_is_not_offered_as_a_topic() -> None:
    seeds: list[TopicSeed] = [{"topic": "빈 단원", "terms": []}, *KNOWN]
    llm = FakeLlm({"note_topics": [{"topics": [{"choice": 1}]}]})
    assert set(seed_terms(llm, "m", NOTE, "기생충학", seeds).terms) == {"간흡충", "폐흡충"}
    assert "빈 단원" not in llm.calls[0].user


def test_seed_term_url_is_optional_and_ignored() -> None:
    seeds: list[TopicSeed] = [
        {
            "topic": "흡충류",
            "terms": [{"term": "간흡충", "url": "https://a.test"}, {"term": "폐흡충"}],
        }
    ]
    llm = FakeLlm({"note_topics": [{"topics": [{"choice": 1}]}]})
    assert set(seed_terms(llm, "m", NOTE, "기생충학", seeds).terms) == {"간흡충", "폐흡충"}
