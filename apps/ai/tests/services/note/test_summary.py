import re
from typing import Any

import pytest

from app.clients.llm import CANCELED, LlmError, LlmSetupError, LlmUsageLimitError
from app.core.config import settings
from app.services.note import job as note_job
from app.services.note.models import Chunk
from app.services.note.summary import (
    HEADING_MAX_CHARS,
    INPUT_MAX_CHARS,
    KEYWORDS_MAX,
    POINT_MAX_CHARS,
    POINTS_MAX,
    summarize_note,
)
from tests.fakes import FakeLlm
from tests.services.note.test_job import FakeFetch, FakeOcr, run_direct, two_pages
from tests.services.recording.test_job import FakeVoyage


def chunk(order: int, text: str, title: str | None = None) -> Chunk:
    return {
        "order": order,
        "title": title,
        "path": [],
        "text": text,
        "lines": [],
        "emphasis": {"has": False, "marks": []},
        "uncertainCount": text.count("[?]"),
        "needsLlm": False,
    }


CHUNKS = [
    chunk(1, "주장 √ + that + s + (should) + 동사원형\n요구 / 요청 V", "주장"),
    chunk(2, "P.138 Q.8"),
    chunk(3, "board of directors - 이사회\n복합명사 [?]customer", "복합명사"),
]


def legacy(got: Any) -> dict[str, Any]:
    """양식 이전부터 있던 키만(points · keywords · headings)."""
    return {k: got[k] for k in ("points", "keywords", "headings")}


def answer(
    points: list[dict[str, Any]], keywords: list[Any], headings: list[Any] | None = None
) -> FakeLlm:
    return FakeLlm(
        {"note_summary": [{"points": points, "keywords": keywords, "headings": headings or []}]}
    )


def test_points_and_keywords_come_from_the_note() -> None:
    llm = answer(
        [
            {"text": "주장 · 요구 동사 뒤 that절에는 (should) + 동사원형을 쓴다.", "refs": [1]},
            {"text": "board of directors는 복합명사로 이사회를 뜻한다.", "refs": [3]},
        ],
        ["복합명사", "동사원형", "board of directors"],
    )

    got = summarize_note(llm, "claude-haiku-5-5", CHUNKS)

    assert legacy(got) == {
        "points": [
            "주장 · 요구 동사 뒤 that절에는 (should) + 동사원형을 쓴다.",
            "board of directors는 복합명사로 이사회를 뜻한다.",
        ],
        "keywords": ["복합명사", "동사원형", "board of directors"],
        "headings": [],
    }
    (call,) = llm.named("note_summary")
    assert call.model == "claude-haiku-5-5"
    assert "[1] 주장" in call.user and "[3] 복합명사" in call.user
    assert "[?]" not in call.user  # 흐린 글자 표시는 보내지 않음


def test_points_without_valid_refs_and_made_up_keywords_are_dropped() -> None:
    llm = answer(
        [
            {"text": "근거 없음", "refs": []},
            {"text": "보내지 않은 문단", "refs": [9]},
            {"text": "참거짓 번호", "refs": [True]},
            {"text": "  공백이   많은  [?]요약 ", "refs": [1, 3]},
            {"text": "공백이 많은 요약", "refs": [1]},  # 같은 글은 한 번만
            {"text": "가" * (POINT_MAX_CHARS + 1), "refs": [1]},
            "모양이 다름",
        ],
        ["관계대명사", "이사회", "x", 3, "이사회"],
    )

    got = summarize_note(llm, "m", CHUNKS)

    assert legacy(got) == {"points": ["공백이 많은 요약"], "keywords": ["이사회"], "headings": []}


def test_untitled_paragraphs_get_headings_from_their_own_words() -> None:
    chunks = [
        chunk(1, "주장 동사 뒤에는 동사원형", "주장"),
        chunk(2, "아메바는 위족으로 움직인다\n먹이를 감싸서 먹는다"),
        chunk(3, "짚신벌레는 섬모로 헤엄친다"),
        chunk(4, "세포 분열"),
        chunk(5, "효모는 출아법으로 번식"),
    ]
    llm = answer(
        [],
        [],
        [
            {"ref": 2, "text": " 아메바의  운동 "},
            {"ref": 2, "text": "아메바 두 번째"},  # 문단마다 하나
            {"ref": 1, "text": "주장 동사"},  # 제목이 있는 문단
            {"ref": 3, "text": "광합성"},  # 문단 글에 없는 낱말
            {"ref": 4, "text": "세포" + "가" * HEADING_MAX_CHARS},
            {"ref": 9, "text": "효모"},  # 보내지 않은 문단
            {"ref": True, "text": "효모"},
            "모양이 다름",
            {"ref": 5, "text": "[?]효모 번식"},
        ],
    )

    got = summarize_note(llm, "m", chunks)

    assert legacy(got) == {
        "points": [],
        "keywords": [],
        "headings": [{"order": 2, "text": "아메바의 운동"}, {"order": 5, "text": "효모 번식"}],
    }
    (call,) = llm.named("note_summary")
    assert "[1] 주장" in call.user and "[2]* 아메바" in call.user


def test_english_headings_need_a_whole_word_from_the_paragraph() -> None:
    chunks = [
        chunk(1, "central nervous system controls the body"),
        chunk(2, "Mitosis makes two cells"),
        chunk(3, "그 밖의 내용"),
    ]
    llm = answer(
        [],
        [],
        [
            {"ref": 1, "text": "cell division"},  # 앞 두 글자(ce)만 겹침
            {"ref": 2, "text": "mitosis 과정"},  # 대소문자는 무시
            {"ref": 3, "text": "a b"},  # 한 글자 낱말만
        ],
    )

    got = summarize_note(llm, "m", chunks)

    assert got is not None
    assert got["headings"] == [{"order": 2, "text": "mitosis 과정"}]


def test_no_usable_point_gives_no_summary() -> None:
    assert summarize_note(answer([{"text": "x", "refs": [9]}], ["이사회"]), "m", CHUNKS) is None


def test_at_most_seven_points_and_ten_keywords() -> None:
    words = [f"단어{i}" for i in range(KEYWORDS_MAX + 3)]
    chunks = [chunk(1, " ".join(words))]
    llm = answer([{"text": f"요약 {i}", "refs": [1]} for i in range(POINTS_MAX + 3)], words)

    got = summarize_note(llm, "m", chunks)

    assert got is not None
    assert len(got["points"]) == POINTS_MAX and len(got["keywords"]) == KEYWORDS_MAX


def test_long_notes_send_only_the_first_paragraphs() -> None:
    chunks = [chunk(i, f"{i}번 " + "가" * 5000) for i in range(1, 5)]
    llm = answer([{"text": "뒤 문단 요약", "refs": [4]}, {"text": "앞 문단", "refs": [1]}], [])

    got = summarize_note(llm, "m", chunks)

    (call,) = llm.named("note_summary")
    assert len(call.user) < INPUT_MAX_CHARS + 100
    assert "[1]* 1번" in call.user and "[4]" not in call.user
    # 보내지 않은 문단은 근거가 될 수 없음
    assert legacy(got) == {"points": ["앞 문단"], "keywords": [], "headings": []}


def sent_note(llm: FakeLlm) -> str:
    (call,) = llm.named("note_summary")
    return call.user.split("<note>\n", 1)[1].rsplit("\n</note>", 1)[0]


def test_the_paragraph_that_overflows_fills_the_rest_of_the_limit() -> None:
    first = chunk(1, "1번 " + "가" * 9_990)  # "[1] " 포함 9,997자
    llm = answer([{"text": "뒤 문단 요약", "refs": [2]}], [])

    got = summarize_note(llm, "m", [first, chunk(2, "2번 " + "나" * 5000), chunk(3, "3번")])

    body = sent_note(llm)
    assert len(body) == INPUT_MAX_CHARS
    assert "[2]* 2번 나" in body and "[3]" not in body
    # 잘라 보낸 문단도 근거가 됨
    assert legacy(got) == {"points": ["뒤 문단 요약"], "keywords": [], "headings": []}


def test_a_tiny_rest_is_not_filled_with_a_cut_paragraph() -> None:
    first = chunk(1, "1번 " + "가" * (INPUT_MAX_CHARS - 60))
    llm = answer([{"text": "앞 문단", "refs": [1]}], [])

    summarize_note(llm, "m", [first, chunk(2, "2번 " + "나" * 500), chunk(3, "3번 짧음")])

    body = sent_note(llm)
    assert "[2]" not in body and "[3]" not in body  # 남은 자리가 작으면 거기서 멈춤
    assert len(body) <= INPUT_MAX_CHARS


def test_a_short_note_may_have_fewer_than_three_points() -> None:
    llm = answer([{"text": "주장 동사 뒤 that절은 동사원형", "refs": [1]}], [])

    got = summarize_note(llm, "m", CHUNKS)

    assert legacy(got) == {
        "points": ["주장 동사 뒤 that절은 동사원형"],
        "keywords": [],
        "headings": [],
    }


def test_a_failed_call_gives_no_summary_but_a_cancel_is_raised() -> None:
    llm = FakeLlm({"note_summary": [LlmError("HTTP 503")]})
    assert summarize_note(llm, "m", CHUNKS) is None
    with pytest.raises(LlmError, match=re.escape(CANCELED)):
        summarize_note(FakeLlm({"note_summary": [LlmError(CANCELED)]}), "m", CHUNKS)


@pytest.mark.parametrize(
    "error",
    [LlmSetupError("HTTP 401"), LlmSetupError("키 없음", retry=False), LlmUsageLimitError("402")],
)
def test_a_setup_error_gives_no_summary(error: LlmSetupError) -> None:
    assert summarize_note(FakeLlm({"note_summary": [error]}), "m", CHUNKS) is None


def test_the_note_job_finishes_when_the_summary_hits_a_setup_error() -> None:
    split = FakeLlm({"note_summary": [LlmSetupError("HTTP 401")]})

    result = note_job.run(
        FakeLlm(),
        FakeOcr,
        FakeVoyage(),
        two_pages(),
        lambda *a: None,
        fetch=FakeFetch(),
        split_llm=split,
    )

    assert result["summary"] is None
    assert result["chunks"]


def test_empty_note_calls_no_llm() -> None:
    llm = FakeLlm({"note_summary": []})
    assert summarize_note(llm, "m", [chunk(1, "  [?] ")]) is None
    assert llm.calls == []


def test_the_note_job_returns_the_summary_from_the_split_llm() -> None:
    llm = FakeLlm()
    split = FakeLlm(
        {"note_summary": [{"points": [{"text": "아메바 두 종류", "refs": [1, 2]}], "keywords": []}]}
    )

    result = note_job.run(
        llm,
        FakeOcr,
        FakeVoyage(),
        two_pages(),
        lambda *a: None,
        fetch=FakeFetch(),
        split_llm=split,
    )

    assert legacy(result["summary"]) == {
        "points": ["아메바 두 종류"],
        "keywords": [],
        "headings": [],
    }
    assert split.named("note_summary")[0].model == settings.note_split_model
    assert llm.calls == []


def test_the_note_job_result_has_no_summary_when_none_is_made() -> None:
    assert run_direct(two_pages())["summary"] is None


# ── 양식(FR-19) ─────────────────────────────


def formatted(fmt: str, points: list[dict[str, Any]], keywords: list[Any] | None = None) -> Any:
    llm = FakeLlm(
        {"note_summary": [{"points": points, "keywords": keywords or [], "headings": []}]}
    )
    return llm, summarize_note(llm, "m", CHUNKS, fmt)


def test_points_format_items_have_no_head() -> None:
    llm, got = formatted("points", [{"text": "동사원형을 쓴다.", "refs": [1]}])

    assert got["format"] == "points"
    assert got["items"] == [{"head": None, "text": "동사원형을 쓴다."}]
    assert got["points"] == ["동사원형을 쓴다."]
    (call,) = llm.named("note_summary")
    assert "head" not in call.schema["properties"]["points"]["items"]["properties"]


def test_qa_items_flatten_to_question_dash_answer() -> None:
    llm, got = formatted(
        "qa",
        [
            {"head": "이사회는 영어로?", "text": "board of directors다.", "refs": [3]},
            {"head": "근거 없는 질문", "text": "답", "refs": [9]},
            {"head": "질" * 31, "text": "앞말이 너무 김", "refs": [1]},
        ],
    )

    assert got["format"] == "qa"
    assert got["items"] == [{"head": "이사회는 영어로?", "text": "board of directors다."}]
    assert got["points"] == ["이사회는 영어로? — board of directors다."]
    (call,) = llm.named("note_summary")
    assert "질문" in call.system
    assert "head" in call.schema["properties"]["points"]["items"]["required"]


def test_terms_head_must_appear_in_the_note() -> None:
    _, got = formatted(
        "terms",
        [
            {"head": "board of directors", "text": "이사회.", "refs": [3]},
            {"head": "지어낸 용어", "text": "노트에 없음.", "refs": [3]},
        ],
    )

    assert got["items"] == [{"head": "board of directors", "text": "이사회."}]
    assert got["points"] == ["board of directors: 이사회."]


def test_brief_keeps_at_most_three() -> None:
    _, got = formatted("brief", [{"text": f"{i}번째 줄", "refs": [1]} for i in range(6)])

    assert [i["text"] for i in got["items"]] == ["0번째 줄", "1번째 줄", "2번째 줄"]


def test_unknown_format_falls_back_to_points() -> None:
    _, got = formatted("table", [{"text": "동사원형", "refs": [1]}])

    assert got["format"] == "points"


def test_no_items_keeps_headings_and_keywords() -> None:
    llm = FakeLlm(
        {
            "note_summary": [
                {
                    "points": [],
                    "keywords": ["이사회"],
                    "headings": [{"ref": 2, "text": "P.138 문제"}],
                }
            ]
        }
    )
    chunks = [chunk(1, "주장 동사", "주장"), chunk(2, "P.138 문제 풀이")]

    got = summarize_note(llm, "m", chunks, "qa")

    assert got is not None and got["items"] == [] and got["points"] == []
