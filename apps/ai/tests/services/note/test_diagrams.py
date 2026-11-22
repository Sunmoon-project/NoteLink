from typing import Any

import pytest

from app.clients.llm import CANCELED, LlmError, LlmSetupError
from app.services.note.diagrams import (
    DIAGRAMS_MAX,
    drop_diagram_lines,
    find_diagrams,
    place_diagrams,
)
from app.services.note.models import Chunk
from tests.fakes import FakeLlm
from tests.services.note.helpers import line

SEQ = {"kind": "sequence", "terms": ["해당과정", "TCA 회로"], "relations": [[1, 2]]}


def answer(*diagrams: dict[str, Any]) -> FakeLlm:
    return FakeLlm(answers={"note_diagrams": [{"diagrams": list(diagrams)}]})


def found(top: float, bottom: float, **d: Any) -> dict[str, Any]:
    return {**SEQ, **d, "top": top, "bottom": bottom}


# ---------- find_diagrams ----------


def test_the_photo_goes_with_the_call_and_good_diagrams_come_back() -> None:
    llm = answer(found(0.2, 0.6))
    out = find_diagrams(llm, "m", b"jpg")
    assert llm.calls[0].image == b"jpg"
    assert out == [
        {
            "top": 0.2,
            "bottom": 0.6,
            "diagram": {
                "kind": "sequence",
                "terms": ["해당과정", "TCA 회로"],
                "relations": [[0, 1]],
            },
        }
    ]


def test_bad_diagrams_are_dropped_like_recording_slides() -> None:
    llm = answer(
        found(0.1, 0.2, terms=["하나"]),  # 핵심어 1개
        found(0.3, 0.4, kind="tree"),  # 모르는 종류
        found(0.5, 0.4),  # 위아래가 뒤집힘
        found(0.6, 1.4),  # 쪽 밖
        found(0.7, 0.8, relations=[[1, 9], [1, 2]]),  # 범위 밖 관계만 버림
    )
    out = find_diagrams(llm, "m", b"jpg")
    assert [(d["top"], d["diagram"]["relations"]) for d in out] == [(0.7, [[0, 1]])]


def test_at_most_three_diagrams_a_page_from_the_top() -> None:
    llm = answer(*(found(t, t + 0.05) for t in (0.5, 0.1, 0.3, 0.2)))
    assert [d["top"] for d in find_diagrams(llm, "m", b"jpg")] == [0.1, 0.2, 0.3]
    assert DIAGRAMS_MAX == 3


@pytest.mark.parametrize("error", [LlmError("응답 없음"), LlmSetupError("키")])
def test_a_failed_call_means_no_diagrams(error: Exception) -> None:
    llm = FakeLlm(answers={"note_diagrams": [error]})
    assert find_diagrams(llm, "m", b"jpg") == []


def test_a_cancel_is_raised() -> None:
    llm = FakeLlm(answers={"note_diagrams": [LlmError(CANCELED)]})
    with pytest.raises(LlmError):
        find_diagrams(llm, "m", b"jpg")


# ---------- drop_diagram_lines ----------


def test_only_lines_of_kept_terms_inside_the_diagram_are_dropped() -> None:
    lines = [
        line("포도당 분해", 0.1, 0.5, 0.1, lid=1),
        line("해당 과정", 0.3, 0.6, 0.25, lid=2),  # 띄어쓰기가 달라도 같은 글
        line("[?]TCA 회로", 0.3, 0.6, 0.45, lid=3),  # 흐린 글 표시는 보지 않음
        line("피루브산 산화", 0.3, 0.6, 0.35, lid=4),  # 도식이 담지 못한 칸 → 본문에 남김
        line("TCA 회로", 0.1, 0.5, 0.8, lid=5),  # 도식 밖 같은 글 → 남김
    ]
    kept = drop_diagram_lines(lines, [{"top": 0.2, "bottom": 0.6, "diagram": dict(SEQ)}])  # type: ignore[typeddict-item]
    assert [ln["id"] for ln in kept] == [1, 4, 5]


def test_lines_just_outside_the_reported_range_are_still_checked() -> None:
    # 시험 사진에서 모델이 준 아래끝이 마지막 칸보다 0.05 안쪽일 때가 있었음(MARGIN)
    lines = [line("본문", 0.1, 0.5, 0.05, lid=1), line("TCA 회로", 0.3, 0.6, 0.63, lid=2)]
    kept = drop_diagram_lines(lines, [{"top": 0.2, "bottom": 0.6, "diagram": dict(SEQ)}])  # type: ignore[typeddict-item]
    assert [ln["id"] for ln in kept] == [1]


def test_a_line_holding_two_terms_is_dropped() -> None:
    lines = [line("본문", 0.1, 0.5, 0.05, lid=1), line("해당과정  TCA 회로", 0.1, 0.9, 0.3, lid=2)]
    kept = drop_diagram_lines(lines, [{"top": 0.2, "bottom": 0.6, "diagram": dict(SEQ)}])  # type: ignore[typeddict-item]
    assert [ln["id"] for ln in kept] == [1]


def test_a_page_with_only_the_diagram_keeps_its_lines() -> None:
    lines = [line("해당과정", 0.3, 0.6, 0.25, lid=1), line("TCA 회로", 0.3, 0.6, 0.45, lid=2)]
    kept = drop_diagram_lines(lines, [{"top": 0.2, "bottom": 0.6, "diagram": dict(SEQ)}])  # type: ignore[typeddict-item]
    assert kept == lines


# ---------- place_diagrams ----------


def chunk(order: int, text: str, refs: list[tuple[int, list[int]]]) -> Chunk:
    return {
        "order": order,
        "title": None,
        "path": [],
        "text": text,
        "lines": [{"pageNo": p, "lineIds": ids} for p, ids in refs],
        "emphasis": {"has": False, "marks": []},
        "uncertainCount": 0,
        "needsLlm": False,
    }


def test_a_diagram_goes_after_the_last_line_above_it_in_reading_order() -> None:
    lines = [
        line("1쪽 위", 0.1, 0.5, 0.1, lid=1, page=1),
        line("1쪽 아래", 0.1, 0.5, 0.8, lid=2, page=1),
        line("2쪽 아래", 0.1, 0.5, 0.9, lid=1, page=2),
    ]
    chunks = [
        chunk(1, "1쪽 위\n1쪽 아래", [(1, [1]), (1, [2])]),
        chunk(2, "2쪽 아래", [(2, [1])]),
    ]
    d1 = {"top": 0.3, "bottom": 0.6, "diagram": dict(SEQ)}
    d2 = {"top": 0.1, "bottom": 0.5, "diagram": {**SEQ, "kind": "list"}}
    d0 = {"top": 0.0, "bottom": 0.05, "diagram": {**SEQ, "kind": "cause"}}
    out = place_diagrams(chunks, lines, [(2, [d2]), (1, [d1, d0])])  # type: ignore[list-item]
    assert [(p["after"], p["diagram"]["kind"]) for p in out] == [
        (None, "cause"),  # 첫 쪽 맨 위: 첫 줄 앞
        ("1쪽 위", "sequence"),
        ("1쪽 아래", "list"),  # 2쪽 맨 위: 앞 쪽 마지막 줄 뒤
    ]
