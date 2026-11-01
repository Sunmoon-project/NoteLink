import pytest

from app.clients.llm import LlmError
from app.services.note.chunking import split_rows
from app.services.note.models import Chunk
from app.services.note.pipeline import (
    cut_chunk,
    embed_texts,
    note_chunks,
    parse_starts,
    split_with_llm,
)
from tests.fakes import FakeLlm
from tests.services.note.helpers import row, rows, word

# ---------- parse_starts ----------


def test_parse_starts_sorts_dedupes_and_keeps_first_row() -> None:
    assert parse_starts({"starts": [3, 3, 5]}, 6) == [1, 3, 5]


@pytest.mark.parametrize(
    "answer",
    [
        {"starts": []},  # 잘린 JSON을 repair하면 빈 목록이 됨
        {},
        {"starts": "1,3"},
        {"starts": [0, 2]},
        {"starts": [1, 9]},
        {"starts": [1, "2"]},
        {"starts": [True]},
    ],
)
def test_parse_starts_rejects_bad_answers(answer: dict[str, object]) -> None:
    with pytest.raises(LlmError):
        parse_starts(answer, 6)


# ---------- cut_chunk · split_with_llm ----------


def long_chunk() -> Chunk:
    r = [
        row("· 초음파 : 음파", lid=1),
        row("· 주파수 : 1~10MHz", lid=2),
        row("· 속도 : 1540 m/sec", lid=3, words=[word("1540", 7, colorDiff=True, color="red")]),
        row("· A-mode : 진폭", lid=4),
    ]
    (c,) = split_rows(r, max_chars=10)
    assert c["needsLlm"]
    return c


def test_cut_chunk_moves_marks_and_lines() -> None:
    first, second = cut_chunk(long_chunk(), [1, 3])
    assert first["text"] == "· 초음파 : 음파\n· 주파수 : 1~10MHz"
    assert second["title"] == "· 속도 : 1540 m/sec"
    (m,) = second["emphasis"]["marks"]
    assert second["text"][m["start"] : m["end"]] == "1540"
    assert [ref["lineIds"] for ref in second["lines"]] == [[3], [4]]
    assert not first["emphasis"]["has"]


def test_cut_chunk_clips_a_mark_across_rows_to_each_piece() -> None:
    # 고치기 전: 앞 조각 강조가 글 길이를 넘고 뒤 조각에서는 사라짐
    chunk: Chunk = {
        "order": 1,
        "title": None,
        "path": [],
        "text": "가나다\n라마바",
        "lines": [{"pageNo": 1, "lineIds": [1]}, {"pageNo": 1, "lineIds": [2]}],
        "emphasis": {
            "has": True,
            "marks": [{"kind": "color", "start": 1, "end": 6, "color": "red"}],
        },
        "uncertainCount": 0,
        "needsLlm": True,
    }
    a, b = cut_chunk(chunk, [1, 2])
    assert a["emphasis"]["marks"] == [{"kind": "color", "start": 1, "end": 3, "color": "red"}]
    assert b["emphasis"]["marks"] == [{"kind": "color", "start": 0, "end": 2, "color": "red"}]


def test_split_with_llm_only_touches_chunks_that_need_it() -> None:
    plain = split_rows(rows("1. 짧은 개념", "내용"))[0]
    llm = FakeLlm({"note_split": [{"starts": [1, 3]}]})
    out = split_with_llm(llm, "gemma-4-26b", [plain, long_chunk()])
    assert [c["order"] for c in out] == [1, 2, 3]
    assert out[0] == {**plain, "order": 1}
    assert len(llm.named("note_split")) == 1
    assert "<note>" in llm.calls[0].user and "3: · 속도" in llm.calls[0].user


def test_split_with_llm_raises_on_truncated_answer() -> None:
    llm = FakeLlm({"note_split": [{"starts": []}]})
    with pytest.raises(LlmError):
        split_with_llm(llm, "gemma-4-26b", [long_chunk()])


# ---------- note_chunks · embed_texts ----------


def test_note_chunks_from_a_small_read_result() -> None:
    content = "1. 이질 아메바\n- 영양형 ★"
    result = {
        "content": content,
        "styles": [{"isHandwritten": True, "spans": [{"offset": 0, "length": len(content)}]}],
        "pages": [
            {
                "pageNumber": 1,
                "width": 100,
                "height": 100,
                "lines": [
                    {
                        "content": "1. 이질 아메바",
                        "polygon": [5, 10, 50, 10, 50, 12, 5, 12],
                        "spans": [{"offset": 0, "length": 9}],
                    },
                    {
                        "content": "- 영양형 ★",
                        "polygon": [5, 15, 50, 15, 50, 17, 5, 17],
                        "spans": [{"offset": 10, "length": 7}],
                    },
                ],
                "words": [],
            }
        ],
    }
    (c,) = note_chunks(result)
    assert c["title"] == "1. 이질 아메바"
    assert c["emphasis"]["has"] and c["emphasis"]["marks"][0].get("text") == "★"


def test_embed_texts_put_parent_titles_first() -> None:
    (c,) = split_rows(rows("I. 근동충류", "1. 이질 아메바", "내용"))
    assert embed_texts([c]) == ["I. 근동충류\n1. 이질 아메바\n내용"]
