from datetime import datetime, timedelta

from app.services.quiz import srs

DAY = datetime(2026, 10, 27)


def days(n: int) -> datetime:
    return DAY + timedelta(days=n)


def test_first_right_answer_comes_back_in_one_day() -> None:
    s = srs.update(None, True, DAY)
    assert (s["step"], s["dueAt"], s["lastResult"], s["reviews"]) == (0, days(1), "right", 1)
    assert s["state"] == "active"


def test_right_answers_space_out_1_3_7_days() -> None:
    # 끝 조건(연속 2번 · 5번)에 걸리지 않게 streak · reviews를 0으로 두고 간격만 봄
    s: srs.Srs = {
        "step": -1,
        "dueAt": None,
        "lastResult": None,
        "streak": 0,
        "reviews": 0,
        "state": "active",
    }
    for expected in (1, 3, 7, 7):  # 7일에서 더 늘어나지 않음
        s = srs.update({**s, "streak": 0, "reviews": 0}, True, DAY)
        assert s["dueAt"] == days(expected)


def test_wrong_answer_goes_back_to_next_day() -> None:
    s = srs.update(srs.update(None, True, DAY), False, days(1))
    assert (s["step"], s["streak"], s["dueAt"], s["lastResult"]) == (0, 0, days(2), "wrong")


def test_two_right_in_a_row_is_mastered() -> None:
    s = srs.update(srs.update(None, True, DAY), True, days(1))
    assert (s["state"], s["dueAt"]) == ("mastered", None)


def test_five_reviews_without_mastering_stops() -> None:
    s = None
    for i in range(5):
        s = srs.update(s, i % 2 == 0, days(i))
    assert s is not None
    assert (s["state"], s["dueAt"], s["reviews"]) == ("stopped", None, 5)


def test_fresh_carries_counters_from_replaced_question() -> None:
    old = srs.update(srs.update(None, False, DAY), True, DAY)
    s = srs.fresh(DAY, carry=old)
    assert (s["step"], s["dueAt"], s["streak"], s["reviews"]) == (0, days(1), 1, 2)
    assert s["checked"] is True


def test_moved_keeps_old_due_date_for_undo() -> None:
    old = srs.update(None, False, DAY)
    s = srs.moved(old, "q2")
    assert (s["state"], s["dueAt"], s["movedTo"], s["dueBefore"]) == ("moved", None, "q2", days(1))
    assert old["state"] == "active"  # 원래 값은 바꾸지 않음


def test_ending_keeps_the_time_it_ended() -> None:
    # #113 1번: mastered · stopped가 된 풀이의 시각(at, 없으면 today)을 endedAt에 남김
    first = srs.update(None, True, DAY)
    assert "endedAt" not in first and first["carriedReviews"] == 0
    done = srs.update(first, True, days(1), days(1) + timedelta(hours=10))
    assert (done["state"], done["endedAt"]) == ("mastered", days(1) + timedelta(hours=10))
    s = None
    for i in range(srs.MAX_REVIEWS):
        s = srs.update(s, False, days(i))
    assert s is not None and (s["state"], s["endedAt"]) == ("stopped", days(4))
    # 끝난 문제를 다시 풀면 그 시각(예전처럼 나중에 푼 쪽으로 봄: 멈춘 문제보다 뒤에 다시 익힘)
    again = srs.update(done, True, days(9), days(9) + timedelta(hours=8))
    assert (again["state"], again["endedAt"]) == ("mastered", days(9) + timedelta(hours=8))
    # 틀려서 복습 중으로 돌아가면 지움
    assert "endedAt" not in srs.update(done, False, days(9))


def test_fresh_records_the_reviews_it_carried_and_drops_the_end_time() -> None:
    old = srs.update(srs.update(None, True, DAY), True, days(1))
    s = srs.fresh(days(2), carry=old)
    assert (s["carriedReviews"], s["reviews"]) == (2, 2) and "endedAt" not in s
    assert srs.fresh(DAY)["carriedReviews"] == 0
