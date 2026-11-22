import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest

from app.services.note import terms
from app.services.note.terms import (
    TermDict,
    is_common,
    is_noun_like,
    letters_alike,
    similarity,
    syllables,
)

TERMS = TermDict(["포낭형", "구흡반", "흡반", "이핵아메바", "이질아메바", "회충", "요충"])


def test_syllables_count_hangul_only() -> None:
    assert syllables("이책 아메바") == 5
    assert syllables("B창원(1)") == 2


def test_similarity_by_jamo() -> None:
    assert similarity("포남형", "포낭형") > 0.85  # 받침 하나 차이
    assert similarity("로꼬가과훌륭", "폐흡충") < 0.2


def test_letters_alike_needs_a_shared_jamo_in_every_letter() -> None:
    assert letters_alike("랄불편오통", "람블편모충")
    assert not letters_alike("구강편모충", "파동편모충")  # 구 · 파는 겹치는 자모 없음
    assert not letters_alike("요통", "요충류")  # 글자 수 다름


def test_near_gives_only_terms_with_the_same_syllable_count() -> None:
    assert TERMS.near("포남형") == ["포낭형"]
    # 실험: 오타는 글자 수가 같음 → 2글자 '흡반'은 3글자 '구흡난'의 후보가 아님
    assert TERMS.near("구흡난") == ["구흡반"]
    assert TERMS.near("전혀다른말") == []


def test_contains_ignores_spaces() -> None:
    assert "이질 아메바" in TERMS
    assert "포남형" not in TERMS
    assert len(TERMS) == 7


def test_found_in_text_longest_first() -> None:
    assert TERMS.found_in("구흡반 · 흡반, 이질 아메바") == ["이질아메바", "구흡반", "흡반"]


def test_kiwi_marks_known_words_and_non_nouns() -> None:
    assert is_common("성숙") and is_common("영양분")  # 이미 있는 낱말은 오타 후보가 아님
    assert not is_common("포남형")
    assert not is_noun_like("신속한") and not is_noun_like("함께")
    assert is_noun_like("포남형")
    assert is_noun_like("두직")  # 관형사(두) + 명사로 읽히는 오타도 후보


def test_kiwi_gives_the_same_answers_from_many_threads() -> None:
    # 노트 정리가 동시에 돌 때(AI_JOB_HEAVY_LANES=2) 같은 Kiwi를 함께 씀
    words = ["성숙", "영양분", "포남형", "신속한", "함께", "두직"] * 20
    alone = [(is_common(w), is_noun_like(w)) for w in words]
    with ThreadPoolExecutor(8) as pool:
        together = list(pool.map(lambda w: (is_common(w), is_noun_like(w)), words))
    assert together == alone


def test_kiwi_is_built_once_when_threads_call_it_first_together(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import kiwipiepy  # type: ignore[import-untyped]

    real, built = kiwipiepy.Kiwi, []

    def slow_kiwi() -> Any:
        built.append(1)
        time.sleep(0.2)  # 만드는 동안 다른 스레드가 들어오게
        return real()

    terms._kiwi.cache_clear()
    monkeypatch.setattr(kiwipiepy, "Kiwi", slow_kiwi)
    start = threading.Barrier(8)

    def call(word: str) -> bool:
        start.wait()
        return is_common(word)

    try:
        with ThreadPoolExecutor(8) as pool:
            assert all(pool.map(call, ["성숙"] * 8))
        assert len(built) == 1
    finally:
        terms._kiwi.cache_clear()  # 다음 시험은 진짜 Kiwi로 다시 만듦
