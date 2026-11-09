from typing import Any

import pytest

from app.clients.llm import LlmError
from app.services.note import ask
from app.services.quiz.review import InputError
from tests.fakes import FakeLlm


def job_input(**over: Any) -> dict[str, Any]:
    return {
        "title": "운영체제 3주차",
        "context": "## 교착 상태\n네 가지 조건이 모두 있어야 생긴다.",
        "history": [
            {"role": "user", "text": "교착 상태가 뭐예요?"},
            {"role": "avatar", "text": "서로 자원을 기다리며 멈춘 상태예요."},
        ],
        "question": "조건 네 가지는요?",
        **over,
    }


def noop(value: int, step: str | None = None) -> None:
    pass


def test_answers_from_the_note_with_history_and_refs() -> None:
    llm = FakeLlm(
        {"note_ask": [{"answer": " 상호 배제 등 네 가지예요. ", "refs": ["교착 상태", ""]}]}
    )
    out = ask.run(llm, job_input(), noop)
    assert out == {"answer": "상호 배제 등 네 가지예요.", "refs": ["교착 상태"]}
    user = llm.named("note_ask")[0].user
    assert '<note title="운영체제 3주차">' in user
    assert "학생: 교착 상태가 뭐예요?" in user
    assert "선생님: 서로 자원을 기다리며" in user
    assert user.endswith("학생 질문: 조건 네 가지는요?")


def test_keeps_only_recent_history_and_cuts_long_text() -> None:
    history = [{"role": "user", "text": f"질문{i}"} for i in range(10)]
    llm = FakeLlm({"note_ask": [{"answer": "네", "refs": []}]})
    ask.run(llm, job_input(history=history, context="가" * 20_000), noop)
    user = llm.named("note_ask")[0].user
    assert "질문3" not in user and "질문4" in user
    assert "가" * ask.MAX_CONTEXT in user and "가" * (ask.MAX_CONTEXT + 1) not in user


@pytest.mark.parametrize(
    "over",
    [
        {"question": "  "},
        {"context": ""},
        {"question": 3},
        {"history": [{"role": "system", "text": "x"}]},
        {"history": "x"},
    ],
)
def test_bad_input_fails_without_calling_llm(over: dict[str, Any]) -> None:
    llm = FakeLlm()
    with pytest.raises(InputError):
        ask.run(llm, job_input(**over), noop)
    assert llm.calls == []


def test_empty_answer_is_retried_as_llm_error() -> None:
    llm = FakeLlm({"note_ask": [{"answer": " ", "refs": []}]})
    with pytest.raises(LlmError):
        ask.run(llm, job_input(), noop)
