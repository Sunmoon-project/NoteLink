import re
from typing import Any

import pytest

from app.clients.llm import CANCELED, LlmError, LlmSetupError, LlmUsageLimitError
from app.core.config import settings
from app.services.note import job as note_job
from app.services.note.models import Chunk
from app.services.note.summary import (
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


def answer(points: list[dict[str, Any]], keywords: list[Any]) -> FakeLlm:
    return FakeLlm({"note_summary": [{"points": points, "keywords": keywords}]})


def test_points_and_keywords_come_from_the_note() -> None:
    llm = answer(
        [
            {"text": "주장 · 요구 동사 뒤 that절에는 (should) + 동사원형을 쓴다.", "refs": [1]},
            {"text": "board of directors는 복합명사로 이사회를 뜻한다.", "refs": [3]},
        ],
        ["복합명사", "동사원형", "board of directors"],
    )

    got = summarize_note(llm, "claude-haiku-5-5", CHUNKS)

    assert got == {
        "points": [
            "주장 · 요구 동사 뒤 that절에는 (should) + 동사원형을 쓴다.",
            "board of directors는 복합명사로 이사회를 뜻한다.",
        ],
        "keywords": ["복합명사", "동사원형", "board of directors"],
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

    assert got == {"points": ["공백이 많은 요약"], "keywords": ["이사회"]}


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
    assert "[1] 1번" in call.user and "[4]" not in call.user
    assert got == {"points": ["앞 문단"], "keywords": []}  # 보내지 않은 문단은 근거가 될 수 없음


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

    assert result["summary"] == {"points": ["아메바 두 종류"], "keywords": []}
    assert split.named("note_summary")[0].model == settings.note_split_model
    assert llm.calls == []


def test_the_note_job_result_has_no_summary_when_none_is_made() -> None:
    assert run_direct(two_pages())["summary"] is None
