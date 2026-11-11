import pytest

from app.services.quiz import levels, similar
from app.services.quiz.levels import Tally
from app.services.quiz.models import Question

KO = ["정의", "특징", "부정설명", "분류", "조합"]


# ---------- 유형 난이도 (모든 사용자) ----------


def test_without_stats_the_type_levels_are_the_first_values() -> None:
    assert levels.type_levels() == similar.DIFFICULTY
    assert levels.type_levels({}) == similar.DIFFICULTY


@pytest.mark.parametrize(
    ("ty", "answered", "correct", "level"),
    [
        ("조합", 40, 36, "중"),  # 90%: 상 → 중
        ("특징", 40, 34, "하"),  # 85%(경계): 중 → 하
        ("특징", 40, 33, "중"),  # 82.5%: 그대로
        ("정의", 40, 19, "중"),  # 47.5%: 하 → 중
        ("특징", 40, 20, "중"),  # 50%(경계): 그대로
        ("특징", 40, 10, "상"),  # 25%: 중 → 상
        ("정의", 40, 40, "하"),  # 가장 쉬운 값은 그대로
        ("조합", 40, 0, "상"),  # 가장 어려운 값은 그대로
        ("조합", 29, 29, "상"),  # 풀이가 모자라면 그대로
    ],
)
def test_a_type_level_moves_one_step_by_everyones_rate(
    ty: str, answered: int, correct: int, level: str
) -> None:
    assert levels.type_levels({ty: Tally(answered, correct)})[ty] == level


def test_a_type_moves_only_one_step_from_its_first_value_and_unknown_types_are_ignored() -> None:
    got = levels.type_levels({"정의": Tally(100, 0), "단답형": Tally(100, 0)})
    assert got["정의"] == "중"  # 하 → 상으로 두 단계 가지 않음
    assert "단답형" not in got


# ---------- 사용자의 난이도별 정답률 ----------


def question(qid: str, ty: str | None, difficulty: str | None = None) -> Question:
    q: Question = {
        "id": qid,
        "order": 1,
        "type": ty,
        "prompt": "?",
        "choices": ["a", "b"],
        "answer": "a",
    }
    if difficulty is not None:
        q["difficulty"] = difficulty
    return q


def test_a_stored_level_wins_over_the_type() -> None:
    lv = levels.type_levels()
    assert levels.level_of(question("q", "정의", "상"), lv) == "상"
    assert levels.level_of(question("q", "조합"), lv) == "상"
    assert levels.level_of(question("q", "정의", "어려움"), lv) == "하"  # 모르는 값은 유형으로
    assert levels.level_of(question("q", None), lv) is None
    assert levels.level_of(question("q", "단답형"), lv) is None


def test_answers_are_counted_by_level_without_void_or_unknown_ones() -> None:
    qs = {
        "a": question("a", "정의"),
        "b": question("b", "조합"),
        "c": question("c", "특징", "상"),
        "d": question("d", None),
    }
    answers = [
        ("a", True, False),
        ("a", False, False),
        ("b", False, False),
        ("c", False, False),
        ("c", True, True),  # 무효
        ("d", False, False),  # 난이도를 모름
        ("x", False, False),  # 세트에 없는 문제
    ]
    got = levels.level_stats(qs, answers, levels.type_levels())
    assert got == {"하": Tally(2, 1), "상": Tally(2, 2)}


# ---------- 세트 비율 ----------


def test_without_a_weak_level_the_set_follows_the_base_mix() -> None:
    assert levels.level_mix(5, {"하", "중", "상"}, {}) == {"하": 2, "중": 2, "상": 1}
    assert levels.level_mix(4, {"하", "중", "상"}, {}) == {"하": 2, "중": 1, "상": 1}
    assert levels.level_mix(5, {"하", "중"}, {}) == {"하": 3, "중": 2}  # 빠른 모드 용어 과목
    assert levels.level_mix(3, {"상"}, {}) == {"상": 3}
    assert levels.level_mix(0, {"하"}, {}) == {}
    assert levels.level_mix(3, set(), {}) == {}


def test_the_weak_level_gets_more_and_the_others_keep_one() -> None:
    weak = {"상": Tally(5, 3)}  # 5번 중 3번 틀림
    assert levels.level_mix(5, {"하", "중", "상"}, weak) == {"하": 1, "중": 2, "상": 2}
    # 10문제면 2문제(20%)를 더 줌: 틀린 비율이 낮은 난이도부터 뺌
    stats = {"상": Tally(10, 8), "하": Tally(10, 0), "중": Tally(10, 3)}
    assert levels.level_mix(10, {"하", "중", "상"}, stats) == {"하": 2, "중": 4, "상": 4}
    # 다른 난이도가 한 문제씩뿐이면 더 주지 않음
    assert levels.level_mix(3, {"하", "중", "상"}, weak) == {"하": 1, "중": 1, "상": 1}


@pytest.mark.parametrize(
    "stats",
    [
        {"상": Tally(4, 4)},  # 풀이가 모자람
        {"상": Tally(10, 3)},  # 30%만 틀림
        {"상": Tally(10, 9)},  # 쓸 수 없는 난이도(아래 available에 상이 없음)
    ],
)
def test_a_level_is_weak_only_with_enough_answers_and_errors(stats: dict[str, Tally]) -> None:
    available = {"하", "중"} if stats["상"].count == 9 else {"하", "중", "상"}
    assert levels.weak_level(stats, available) is None


def test_the_weakest_level_wins_and_ties_go_to_the_harder_one() -> None:
    stats = {"하": Tally(10, 6), "중": Tally(10, 6), "상": Tally(10, 5)}
    assert levels.weak_level(stats, {"하", "중", "상"}) == "중"


def test_slots_turn_through_the_levels() -> None:
    assert levels.slot_levels({"하": 2, "중": 2, "상": 1}) == ["하", "중", "상", "하", "중"]
    assert levels.slot_levels({"상": 2, "하": 1}) == ["하", "상", "상"]
    assert levels.slot_levels({}) == []


# ---------- 유형 고르기 ----------


def test_types_of_the_wanted_level_come_first_then_the_nearest() -> None:
    lv = levels.type_levels()
    assert levels.order_types(KO, "상", lv, 0) == ["조합", "특징", "부정설명", "정의", "분류"]
    assert levels.order_types(KO, "하", lv, 0) == ["정의", "분류", "특징", "부정설명", "조합"]
    # 같은 거리면 쉬운 쪽 먼저
    assert levels.order_types(KO, "중", lv, 0) == ["특징", "부정설명", "정의", "분류", "조합"]
    # 같은 난이도 안에서는 turn으로 돌림
    assert levels.order_types(KO, "하", lv, 1)[:2] == ["분류", "정의"]


def test_corrected_type_levels_change_the_order() -> None:
    lv = levels.type_levels({"조합": Tally(40, 38)})  # 조합이 중으로
    assert levels.order_types(KO, "중", lv, 0)[:3] == ["특징", "부정설명", "조합"]
    assert levels.order_types(["빈칸", "어휘", "규칙"], "상", lv, 0)[0] == "규칙"
