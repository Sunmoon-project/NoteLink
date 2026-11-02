"""복습 상태 계산. 설계에서 Question.srs는 자유 형식이라 아래 필드를 우리가 정해 씁니다.

  step        0, 1, 2 → 다음 복습이 1, 3, 7일 뒤
  dueAt       다음 복습 날짜 (끝난 문제는 None)
  lastResult  'right' | 'wrong' | None
  streak      연속으로 맞힌 횟수
  reviews     푼 횟수 (처음 퀴즈도 1번으로 셈)
  state       'active'    복습 중
              'mastered'  연속 2번 맞힘 → 복습에서 빠짐 (AI 계획 5-1 ③ 끝 조건)
              'stopped'   5번 풀어도 못 익힘 → 더 내지 않고 노트로 안내
              'moved'     새 사본이나 새 유사 문제(movedTo)로 넘어감, 복습은 그쪽이 이어 감
              'flawed'    문제 자체가 잘못됨(정답이 둘 등). 이 문제의 풀이는 무효
  checked     '정답 둘' 검사를 통과함 (새 문제는 만들 때 통과, 예전 문제는 오늘의 복습이 검사)

계산만 하고 저장은 하지 않습니다. 결과는 ai_jobs.result에 담기고 메인 서버가 quiz_sets에 반영합니다.
"""

from datetime import datetime, timedelta
from typing import Literal, NotRequired, TypedDict

REVIEW_STEPS_DAYS = (1, 3, 7)  # 틀리면 다음 날로 돌아감
MASTER_STREAK = 2
MAX_REVIEWS = 5

type SrsStateName = Literal["active", "mastered", "stopped", "moved", "flawed"]


class Srs(TypedDict):
    step: int
    dueAt: datetime | None
    lastResult: Literal["right", "wrong"] | None
    streak: int
    reviews: int
    state: SrsStateName
    checked: NotRequired[bool]
    movedTo: NotRequired[str]
    dueBefore: NotRequired[datetime | None]  # 넘겨주기 전 복습 날짜 (안 푼 오늘의 복습 되돌리기용)
    flaw: NotRequired[str]
    flawTries: NotRequired[int]  # 결함 문제를 새 문제로 바꾸려 해 본 날 수 (오늘의 복습)
    voidedReviews: NotRequired[int]  # 무효 풀이 중 reviews에서 이미 뺀 수 (오늘의 복습)


def fresh(today: datetime, carry: Srs | None = None) -> Srs:
    """복습에 새로 들어가는 문제. carry는 이 문제가 이어받는 이전 문제의 상태."""
    return {
        "step": 0,
        "dueAt": today + timedelta(days=REVIEW_STEPS_DAYS[0]),
        "lastResult": None,
        "streak": carry["streak"] if carry else 0,
        "reviews": carry["reviews"] if carry else 0,
        "state": "active",
        "checked": True,
    }


def update(prev: Srs | None, ok: bool, today: datetime) -> Srs:
    """한 번 풀었을 때. 처음 푸는 문제는 prev가 None."""
    s: Srs = (
        {**prev}
        if prev
        else {
            "step": -1,
            "dueAt": None,
            "lastResult": None,
            "streak": 0,
            "reviews": 0,
            "state": "active",
        }
    )
    s["reviews"] += 1
    if ok:
        s["streak"] += 1
        s["step"] = min(s["step"] + 1, len(REVIEW_STEPS_DAYS) - 1)
        s["dueAt"] = today + timedelta(days=REVIEW_STEPS_DAYS[s["step"]])
        s["lastResult"] = "right"
    else:
        s["streak"], s["step"] = 0, 0
        s["dueAt"] = today + timedelta(days=REVIEW_STEPS_DAYS[0])
        s["lastResult"] = "wrong"
    if s["streak"] >= MASTER_STREAK:
        s["state"], s["dueAt"] = "mastered", None
    elif s["reviews"] >= MAX_REVIEWS:
        s["state"], s["dueAt"] = "stopped", None
    else:
        s["state"] = "active"
    return s


def moved(prev: Srs, new_id: str) -> Srs:
    """다른 문제로 넘겨줌. dueBefore를 남겨 두어 나중에 되돌릴 수 있게 함."""
    return {**prev, "state": "moved", "dueAt": None, "movedTo": new_id, "dueBefore": prev["dueAt"]}
