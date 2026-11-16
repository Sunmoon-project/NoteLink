import pytest

from app.clients.llm import LlmError
from app.services.note.chunking import split_rows
from app.services.note.models import Chunk
from app.services.note.tagging import options, parse_items, status, tag_concepts, title_core
from app.services.note.terms import TermDict
from tests.fakes import FakeLlm
from tests.services.note.helpers import row

TERMS = TermDict(["요코가와흡충", "간흡충", "폐흡충", "회충", "요충", "흡충류", "충란", "중간숙주"])


def chunks(*texts: str) -> list[Chunk]:
    return split_rows([row(t, lid=i) for i, t in enumerate(texts, 1)])


@pytest.mark.parametrize(
    ("title", "core"),
    [
        ("3. 로꼬가과 [?]훌륭", "로꼬가과훌륭"),
        ("2. 메닐 편모충 (비병원성)", "메닐편모충"),
        ("Ⅱ. 포자충류", "포자충류"),
        (None, ""),
    ],
)
def test_title_core(title: str | None, core: str) -> None:
    assert title_core(title) == core


def test_options_from_title_and_text() -> None:
    (c,) = chunks("3. 로꼬가과 [?]훌륭", "- 충란: 간흡충과 유사")
    opts = options(c, TERMS)
    assert opts[0] == "요코가와흡충"  # 제목 오타가 심해도 같은 글자 수 후보
    assert {"간흡충", "충란"} <= set(opts)  # 글에 그대로 나온 용어


@pytest.mark.parametrize(
    ("title", "tag", "want"),
    [
        ("1. 최통", "회충", "auto"),  # 글자마다 자모가 겹치는 오타 꼴
        ("2. 부구조통", "무구조충", "auto"),
        ("4. 일본 주혈흡충", "주혈흡충", "auto"),  # 제목에 그대로
        ("1. P. Vivay (삼일열)", "삼일열", "auto"),  # 괄호 안에 그대로
        ("5. 구강 편모충", "파동편모충", "review"),  # 글자 수만 같은 다른 용어 (10/31 시험)
        ("1. 대장심소통", "대장아메바", "review"),
        ("7. 수혈 전 검사", "혈액형검사", "review"),
        ("3. 로꼬가과 [?]훌륭", "간흡충", "review"),
        ("1. ABO", "혈구형", "review"),  # 영문 제목에 없는 태그
    ],
)
def test_status(title: str, tag: str, want: str) -> None:
    (c,) = chunks(title, "- 혈구형 · 충란")
    assert status(c, tag) == want


def test_status_without_title_uses_text() -> None:
    (c,) = split_rows([row("- 회충 충란", lid=1)])
    assert c["title"] is None
    assert status(c, "회충") == "auto" and status(c, "요충") == "review"


def test_tag_concepts_one_call_and_untagged_without_options() -> None:
    cs = chunks("1. 최통", "- 내용", "2. 알 수 없는 말", "- 내용")
    llm = FakeLlm({"note_concepts": [{"items": [{"order": 1, "choice": 1}]}]})
    out = tag_concepts(llm, "gemma-4-26b", cs, TERMS)
    assert len(llm.named("note_concepts")) == 1
    assert "[문단 2]" not in llm.calls[0].user  # 후보 없는 문단은 묻지 않음
    assert (out[0]["concept"], out[0]["conceptStatus"]) == ("회충", "auto")
    assert (out[1]["concept"], out[1]["conceptStatus"]) == (None, None)


@pytest.mark.parametrize(
    "items",
    [
        [{"order": 1, "choice": 0}],
        [{"order": 1, "choice": 5}],
        [{"order": 9, "choice": 1}],
        [{"order": True, "choice": 1}],  # 불리언 번호
        ["x"],
    ],
)
def test_bad_items_are_ignored(items: list[object]) -> None:
    assert parse_items({"items": items}, {1: ["회충"]}) == {}


def test_good_item_after_a_bad_order_survives() -> None:
    items = [{"order": True, "choice": 1}, {"order": 1, "choice": 1}]
    got = parse_items({"items": items}, {1: ["회충"]})
    assert got == {1: "회충"}
    assert all(type(order) is int for order in got)  # True == 1이라 키 타입까지 확인


def test_missing_items_raise() -> None:
    with pytest.raises(LlmError):
        parse_items({"concepts": []}, {1: ["회충"]})
