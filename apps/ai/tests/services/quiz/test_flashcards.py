"""맞춤 퀴즈 끝에 만드는 개념 카드(flashcards.make, #558)."""

import threading
import time
from typing import Any

import pytest

from app.clients.llm import CANCELED, JsonObject, LlmError, LlmSetupError
from app.services.quiz import flashcards
from tests.fakes import FakeLlm

PAGE1 = """Ⅰ. 근족충류
1. 이질 아메바
- 영양형: 위족으로 운동하고 적혈구를 먹는다
- 포낭형: 4핵, 인체 감염형
2. 대장 아메바
- 포낭형: 8핵, 비병원성"""
PAGE2 = """Ⅱ. 편모충류
1. 람블편모충
- 영양형: 서양배 모양, 흡착원판
- 포낭형: 타원형, 4핵
2. 질편모충
- 성 접촉으로 감염된다"""
PAGES = {1: PAGE1, 2: PAGE2}
SCOPE = [
    (1, "이질 아메바"),
    (1, "대장 아메바"),
    (2, "람블편모충"),
    (2, "질편모충"),
    (1, "이질 아메바"),
]


def card(front: str, back: str, page: int = 1, concept: str = "이질 아메바") -> JsonObject:
    return {"front": front, "back": back, "pageNo": page, "concept": concept}


GOOD = [
    card("이질 아메바의 영양형", "위족으로 운동하고 적혈구를 먹는다."),
    card("이질 아메바 포낭형의 핵 수", "4핵이며 인체 감염형이다."),
    card("대장 아메바", "포낭형이 8핵이고 비병원성이다.", concept="대장 아메바"),
    card("람블편모충의 영양형", "서양배 모양이고 흡착원판이 있다.", 2, "람블편모충"),
    card("질편모충의 감염 경로", "성 접촉으로 감염된다.", 2, "질편모충"),
]
# 노트에 없는 뜻(말라리아 · 모기 · 간)
MADE_UP = card("이질 아메바의 매개체", "모기가 옮기며 간에서 증식하는 말라리아 원충이다.")


def make(llm: Any, **more: Any) -> tuple[list[JsonObject], str | None]:
    kw: dict[str, Any] = {"end": float("inf"), **more}
    return flashcards.make(llm, PAGES, SCOPE, **kw)


def test_five_grounded_cards_from_one_call() -> None:
    llm = FakeLlm({flashcards.NAME: [{"cards": GOOD}]})
    cards, why = make(llm)
    assert why is None
    assert [c["front"] for c in cards] == [c["front"] for c in GOOD]
    assert cards[0] == {
        "front": "이질 아메바의 영양형",
        "back": "위족으로 운동하고 적혈구를 먹는다.",
        "pageNo": 1,
        "concept": "이질 아메바",
    }
    assert len(llm.named(flashcards.NAME)) == 1
    # 퀴즈와 같은 쪽 글 · 퀴즈가 물은 개념(겹치면 한 번, 많이 물은 것부터)을 보여 줌
    user = llm.calls[0].user
    assert '<노트 쪽="1">' in user and '<노트 쪽="2">' in user
    assert "이질 아메바, 대장 아메바, 람블편모충, 질편모충" in user


def test_only_pages_of_the_quiz_are_shown() -> None:
    llm = FakeLlm({flashcards.NAME: [{"cards": GOOD[:2]}, {"cards": []}]})
    flashcards.make(llm, {**PAGES, 3: "3쪽 글\n" * 5}, [(1, "이질 아메바")], end=float("inf"))
    assert '<노트 쪽="3">' not in llm.calls[0].user
    item = llm.calls[0].schema["properties"]["cards"]["items"]
    assert item["properties"]["pageNo"]["enum"] == [1]


def test_a_card_whose_back_is_not_in_the_note_is_dropped_and_refilled_once() -> None:
    first = [*GOOD[:4], MADE_UP]
    llm = FakeLlm({flashcards.NAME: [{"cards": first}, {"cards": [GOOD[4]]}]})
    cards, why = make(llm)
    assert why is None
    assert [c["front"] for c in cards] == [c["front"] for c in [*GOOD[:4], GOOD[4]]]
    again = llm.calls[1].user
    assert "1장" in again
    assert flashcards.NOT_IN_NOTE in again  # 앞 카드의 문제점을 알려 줌
    assert "이질 아메바의 영양형" in again  # 이미 만든 앞면은 다시 만들지 않게


def test_refill_is_tried_only_once() -> None:
    llm = FakeLlm({flashcards.NAME: [{"cards": [MADE_UP]}, {"cards": [MADE_UP]}]})
    cards, why = make(llm)
    assert cards == []
    assert why is not None and "0/5장" in why and flashcards.NOT_IN_NOTE in why
    assert len(llm.named(flashcards.NAME)) == 2


def test_shape_page_length_and_duplicate_checks() -> None:
    bad = [
        card("", "위족으로 운동하고 적혈구를 먹는다."),  # 빈 앞면
        card("이질 아메바", "위족으로 운동하고 적혈구를 먹는다.", page=3),  # 퀴즈 쪽이 아님
        {"front": "이질 아메바", "back": 4},  # 모양
        card("이질 아메바의 영양형", "위족으로 운동하고 적혈구를 먹는다. " * 20),  # 너무 김
        card("위족으로 운동하고 적혈구를 먹는다", "위족으로 운동하고 적혈구를 먹는다"),  # 앞뒤 같음
        card("말라리아", "4핵이며 인체 감염형이다."),  # 앞면 낱말이 그 쪽에 없음
        GOOD[0],
        {**GOOD[0], "back": "적혈구를 먹고 위족으로 운동한다."},  # 앞면이 겹침
    ]
    llm = FakeLlm({flashcards.NAME: [{"cards": bad}, {"cards": []}]})
    cards, why = make(llm)
    assert cards == [GOOD[0]]
    assert why is not None and "1/5장" in why


def test_more_than_five_are_cut() -> None:
    llm = FakeLlm({flashcards.NAME: [{"cards": [*GOOD, card("포낭형", "4핵, 인체 감염형")]}]})
    cards, why = make(llm)
    assert len(cards) == flashcards.COUNT and why is None


def test_a_broken_answer_or_call_does_not_raise() -> None:
    broken: list[list[JsonObject | LlmError]] = [
        [{"cards": "없음"}, {"nothing": 1}],
        [LlmError("HTTP 503"), LlmError("HTTP 503")],
    ]
    for answers in broken:
        cards, why = make(FakeLlm({flashcards.NAME: list(answers)}))
        assert cards == [] and why is not None


def test_a_setup_error_or_code_error_does_not_fail_the_quiz() -> None:
    for e in (LlmSetupError("사용 한도"), RuntimeError("버그")):

        def boom(_: str, e: Exception = e) -> JsonObject:
            raise e

        cards, why = make(FakeLlm({flashcards.NAME: boom}))
        assert cards == [] and why is not None and type(e).__name__ in why


def test_the_reason_has_no_note_or_card_text() -> None:
    llm = FakeLlm({flashcards.NAME: [{"cards": [MADE_UP]}, LlmError("HTTP 503")]})
    _, why = make(llm)
    assert why is not None
    for text in ("말라리아", "모기", "아메바", "적혈구"):
        assert text not in why


def test_no_time_left_skips_the_call() -> None:
    llm = FakeLlm({flashcards.NAME: [{"cards": GOOD}]})
    now = [100.0]
    cards, why = make(llm, end=100.0 + flashcards.MIN_SEC - 1, clock=lambda: now[0])
    assert cards == [] and why == f"0/5장만 만듦({flashcards.TIMEOUT})"
    assert llm.calls == []


def test_a_slow_call_is_cut_at_the_end(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(flashcards, "MIN_SEC", 0)
    gate = threading.Event()

    def slow(_: str) -> JsonObject:
        gate.wait(5)
        return {"cards": GOOD}

    try:
        cards, why = make(FakeLlm({flashcards.NAME: slow}), end=time.monotonic() + 0.3)
    finally:
        gate.set()
    assert cards == [] and why is not None and flashcards.TIMEOUT in why


def test_a_slow_refill_keeps_the_cards_already_made(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(flashcards, "MIN_SEC", 0)
    gate = threading.Event()
    answers: list[JsonObject] = [{"cards": GOOD[:3]}]

    def second_is_slow(_: str) -> JsonObject:
        if answers:
            return answers.pop(0)
        gate.wait(5)
        return {"cards": GOOD[3:]}

    try:
        cards, why = make(FakeLlm({flashcards.NAME: second_is_slow}), end=time.monotonic() + 0.3)
    finally:
        gate.set()
    assert [c["front"] for c in cards] == [c["front"] for c in GOOD[:3]]
    assert why is not None and "3/5장" in why


def test_grounded_back_check() -> None:
    assert flashcards.grounded("위족으로 운동하며 적혈구를 먹는 형태", PAGE1)
    assert not flashcards.grounded("모기가 옮기며 간에서 증식한다", PAGE1)
    assert not flashcards.grounded("", PAGE1)


# ---------- code-review 반영 ----------

ENGLISH = """Unit 3 Meetings
postpone: to delay an event until a later time
agenda: a list of items to be discussed at a meeting
minutes: a written record of what was said at a meeting"""


def test_english_backs_are_counted_by_words() -> None:
    assert flashcards.grounded("To delay an event until a later time.", ENGLISH)
    # 글자 2개 묶음으로 세면 'th' · 'in' 같은 묶음이 다 있어 통과하던 지어낸 뜻
    assert not flashcards.grounded("A verb meaning to cancel the whole plan forever.", ENGLISH)
    assert not flashcards.grounded("The thing that he is in there", ENGLISH)


def test_common_korean_pairs_alone_do_not_ground_a_back() -> None:
    page = "- 영양형은 위족으로 운동하는 형태\n- 포낭형은 장에서 감염되고 핵이 있는 것"
    # 흔한 묶음('으로' · '하는' · '에서' · '있는')만 겹쳐 덮는 비율은 1.0이지만 쪽 글에 그대로 있는
    # 4글자 구간이 없음
    assert not flashcards.grounded("으로 하는 에서 있는", page)
    assert flashcards.grounded("위족으로 운동하는 형태이다", page)


def test_a_front_needs_most_of_its_words_in_the_note() -> None:
    llm = FakeLlm(
        {
            flashcards.NAME: [
                {
                    "cards": [
                        card("다음 중 아메바의 주요 특징", "위족으로 운동하고 적혈구를 먹는다.")
                    ]
                },
                {"cards": []},
            ]
        }
    )
    cards, why = make(llm)
    assert cards == [] and why is not None and flashcards.FRONT_NOT_IN_NOTE in why


def test_the_output_limit_fits_five_cards() -> None:
    limits: list[int] = []

    class Capture(FakeLlm):
        def call(self, *a: Any, max_tokens: int = 1500, **k: Any) -> JsonObject:
            limits.append(max_tokens)
            return super().call(*a, max_tokens=max_tokens, **k)

    make(Capture({flashcards.NAME: [{"cards": GOOD}]}))
    # 앞 80자 + 뒤 200자 + 개념 · JSON 키가 5장(한글은 글자당 1토큰 안팎)
    assert limits == [200 + flashcards.CARD_TOKENS * 5]
    assert flashcards.CARD_TOKENS * 1 >= flashcards.FRONT_MAX + flashcards.BACK_MAX + 60


def test_the_refill_prompt_does_not_repeat_call_errors() -> None:
    llm = FakeLlm({flashcards.NAME: [LlmError("HTTP 503"), {"cards": GOOD}]})
    cards, why = make(llm)
    assert len(cards) == 5 and why is None
    again = llm.calls[1].user
    assert "HTTP 503" not in again and "문제점" not in again


def test_a_limit_that_shrinks_while_waiting_cuts_the_call(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(flashcards, "MIN_SEC", 0)
    monkeypatch.setattr(flashcards, "POLL_SEC", 0.05)
    gate = threading.Event()
    asked = threading.Event()
    start = time.monotonic()

    def slow(_: str) -> JsonObject:
        asked.set()
        gate.wait(5)
        return {"cards": GOOD}

    def end() -> float:  # 호출이 나간 뒤 상한이 지금으로 줄어듦(미리 만들기를 이어받음)
        return start if asked.is_set() else start + 60

    try:
        cards, why = make(FakeLlm({flashcards.NAME: slow}), end=end)
    finally:
        gate.set()
    assert cards == [] and why is not None and flashcards.TIMEOUT in why
    assert time.monotonic() - start < 2


def test_a_canceled_job_stops_the_cards_without_a_refill() -> None:
    llm = FakeLlm({flashcards.NAME: [LlmError(CANCELED), {"cards": GOOD}]})
    cards, why = make(llm)
    assert cards == [] and why == "0/5장만 만듦(작업이 취소됨)"
    assert len(llm.calls) == 1


def test_a_back_that_ends_in_da_as_a_word_keeps_it() -> None:
    page = "- 동해: 바다\n- 강수량: 많다\n- 위치: 한반도 동쪽"
    assert flashcards.grounded("바다", page)
    assert flashcards.grounded("많다", page)
    assert flashcards.grounded("한반도 동쪽 바다이다.", page)


def test_a_short_english_back_in_the_note_is_grounded() -> None:
    page = "- 세포는 ATP를 만든다\n- 유전 정보: DNA"
    assert flashcards.grounded("ATP이다", page)
    assert flashcards.grounded("DNA", page)
    assert not flashcards.grounded("RNA", page)
