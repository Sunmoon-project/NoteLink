"""문제 난이도(하 · 중 · 상)를 정답률로 고치고, 맞춤 퀴즈 세트의 난이도 비율을 정합니다(#268).

난이도는 문제의 객관적인 값이고(모든 사용자의 정답률로 고침), 세트 비율은 그 사용자의 풀이로
정합니다(많이 틀린 난이도를 늘림). 두 결정은 #268에서 정했습니다.

1. 유형 난이도 (type_levels — 모든 사용자)
   처음 값은 유형으로 정함(similar.DIFFICULTY: 정의 · 분류 · 빈칸 · 어휘 하 / 특징 · 부정설명 ·
   묘사 중 / 조합 · 규칙 상). 생성 모델이 붙이는 난이도는 쓰지 않음(#268 실험 1: 요청과 거의 맞지
   않음).
   입력 typeStats {유형: {answered, correct}}는 모든 사용자의 그 유형 풀이 수 · 맞힌 수(NestJS가
   모아 넣음). 풀이가 MIN_TYPE_ANSWERS번 이상인 유형만 고침:
     정답률 EASY_RATE 이상  → 처음 값보다 한 단계 쉽게(상 → 중, 중 → 하)
     정답률 HARD_RATE 미만  → 처음 값보다 한 단계 어렵게(하 → 중, 중 → 상)
   늘 처음 값에서 한 단계까지만: 정답률이 다시 가운데로 오면 처음 값으로 돌아감. typeStats가
   없거나 모자라면 처음 값 그대로.
   고친 값은 새로 만드는 문제의 difficulty와 아래 2 · 3에 씀. 이미 저장한 문제의 difficulty는
   바꾸지 않음(만든 때의 값).

2. 사용자의 난이도별 정답률 (level_stats)
   input의 sets · attempts에서 무효가 아닌 답마다, 그 문제의 난이도(저장된 difficulty, 없으면
   유형으로 1의 값)별로 푼 수 · 틀린 수를 셈. 노트를 가리지 않음(약한 난이도는 노트와 상관없는
   그 사용자의 성향). 유형도 난이도도 모르는 문제는 셈에서 뺌.

3. 세트 비율 (level_mix)
   쓸 수 있는 난이도(이 노트의 쪽 유형에 있는 난이도. 빠른 모드의 용어 과목은 하 · 중뿐) 안에서
   BASE(하 2 : 중 2 : 상 1) 비율로 n문제를 나눔(큰 나머지 순, 같으면 하 → 중 → 상).
   약한 난이도: 푼 수 MIN_LEVEL_ANSWERS 이상이고 틀린 비율 WEAK_RATE 이상인 난이도 중 틀린 비율이
   가장 높은 것(같으면 어려운 쪽). 약한 난이도에 ceil(n × WEAK_SHARE)문제를 더 주고, 그만큼 다른
   난이도에서 뺌(틀린 비율이 낮은 난이도부터, 문제가 많은 쪽부터). 다른 난이도도 1문제는 남김
   (n이 쓸 수 있는 난이도 수보다 적으면 예외).
   자리마다 난이도를 하 · 중 · 상 차례로 돌려 정하고(slot_levels), 그 자리는 그 난이도의 유형부터
   만들며 실패하면 가까운 난이도의 유형으로 넘어감(order_types). 같은 난이도 안의 유형은 난이도마다
   돌림(빠른 모드는 쪽마다, 안정적 모드는 세트 전체에서). 그래서 비율은 목표이고, 초안이 떨어지면
   조금 어긋날 수 있음. 다음 판은 모자란 난이도부터 채움(generate._make_all).
   여분 자리는 먼저 끝난 문제부터 채택되므로, 목표를 이미 채운 난이도의 문제는 남은 자리가 아직
   도는 모자란 난이도 자리의 몫보다 많을 때만 받음(held, Codex 리뷰 #300): 느린 난이도(조합)가
   여분 문제에 밀려 0문제가 되지 않게.
"""

import math
from collections import Counter
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from app.services.quiz import similar
from app.services.quiz.models import Question

LEVELS = ("하", "중", "상")
MIN_TYPE_ANSWERS = 30  # 유형 난이도를 고칠 최소 풀이 수(모든 사용자)
EASY_RATE = 0.85  # 이 정답률 이상이면 한 단계 쉽게
HARD_RATE = 0.5  # 이 정답률 미만이면 한 단계 어렵게
BASE = {"하": 2, "중": 2, "상": 1}  # 기록이 없을 때 세트 비율
MIN_LEVEL_ANSWERS = 5  # 약한 난이도로 볼 최소 풀이 수(그 사용자)
WEAK_RATE = 0.4  # 약한 난이도로 볼 틀린 비율
WEAK_SHARE = 0.2  # 약한 난이도에 더 주는 몫(세트 문제 수 대비)


@dataclass(frozen=True)
class Tally:
    """푼 수와 센 수: 유형별(모든 사용자)은 맞힌 수, 난이도별(그 사용자)은 틀린 수."""

    answered: int
    count: int


def _step(level: str, by: int) -> str:
    return LEVELS[min(max(LEVELS.index(level) + by, 0), len(LEVELS) - 1)]


def type_levels(stats: Mapping[str, Tally] | None = None) -> dict[str, str]:
    """유형마다 난이도(위 1). stats는 유형별 (모든 사용자의 푼 수, 맞힌 수)."""
    out = dict(similar.DIFFICULTY)
    for ty, t in (stats or {}).items():
        if ty not in out or t.answered < MIN_TYPE_ANSWERS:
            continue
        rate = t.count / t.answered
        if rate >= EASY_RATE:
            out[ty] = _step(out[ty], -1)
        elif rate < HARD_RATE:
            out[ty] = _step(out[ty], +1)
    return out


def level_of(q: Question, levels: Mapping[str, str]) -> str | None:
    """저장된 문제의 난이도: 저장된 값, 없으면 유형으로. 둘 다 모르면 None."""
    d = q.get("difficulty")
    if d in LEVELS:
        return str(d)
    return levels.get(q.get("type") or "")


def level_stats(
    questions: Mapping[str, Question],
    answers: Iterable[tuple[str, bool, bool]],
    levels: Mapping[str, str],
) -> dict[str, Tally]:
    """난이도별 (푼 수, 틀린 수)(위 2). answers는 (questionId, correct, void)."""
    seen: Counter[str] = Counter()
    wrong: Counter[str] = Counter()
    for qid, correct, void in answers:
        q = questions.get(qid)
        lv = level_of(q, levels) if q is not None else None
        if lv is None or void:
            continue
        seen[lv] += 1
        wrong[lv] += not correct
    return {lv: Tally(seen[lv], wrong[lv]) for lv in LEVELS if seen[lv]}


def weak_level(stats: Mapping[str, Tally], available: Iterable[str]) -> str | None:
    """약한 난이도(위 3). 없으면 None."""
    cands = [
        (t.count / t.answered, LEVELS.index(lv), lv)
        for lv in available
        if (t := stats.get(lv)) and t.answered >= MIN_LEVEL_ANSWERS
        and t.count / t.answered >= WEAK_RATE
    ]  # fmt: skip
    return max(cands)[2] if cands else None


def level_mix(n: int, available: Iterable[str], stats: Mapping[str, Tally]) -> dict[str, int]:
    """난이도마다 문제 수(위 3). available은 쓸 수 있는 난이도."""
    avail = [lv for lv in LEVELS if lv in set(available)]
    if not avail or n <= 0:
        return {}
    total = sum(BASE[lv] for lv in avail)
    raw = {lv: n * BASE[lv] / total for lv in avail}
    count = {lv: int(raw[lv]) for lv in avail}
    for lv in sorted(avail, key=lambda x: -(raw[x] - count[x]))[: n - sum(count.values())]:
        count[lv] += 1
    weak = weak_level(stats, avail)
    if weak is None or len(avail) == 1:
        return count
    floor = 1 if n >= len(avail) else 0

    def error(lv: str) -> float:
        t = stats.get(lv)
        return t.count / t.answered if t and t.answered else 0.0

    for _ in range(math.ceil(n * WEAK_SHARE)):
        give = [lv for lv in avail if lv != weak and count[lv] > floor]
        if not give:
            break
        lv = min(give, key=lambda x: (error(x), -count[x], LEVELS.index(x)))
        count[lv] -= 1
        count[weak] += 1
    return count


def slot_levels(count: Mapping[str, int]) -> list[str]:
    """자리마다 난이도: 하 · 중 · 상을 차례로 돌려 앞 자리부터 섞이게."""
    left = Counter({lv: c for lv, c in count.items() if c > 0})
    out: list[str] = []
    while left:
        for lv in LEVELS:
            if left[lv] > 0:
                out.append(lv)
                left[lv] -= 1
                if not left[lv]:
                    del left[lv]
    return out


def order_types(types: list[str], want: str, levels: Mapping[str, str], turn: int) -> list[str]:
    """시도할 유형 순서: 원하는 난이도의 유형부터(같은 난이도 안에서는 turn으로 돌림), 그다음
    가까운 난이도 차례. 같은 거리면 쉬운 쪽 먼저(초안이 덜 떨어짐)."""
    target = LEVELS.index(want)

    def dist(ty: str) -> tuple[int, int]:
        i = LEVELS.index(levels.get(ty, "중"))
        return abs(i - target), i

    groups: dict[tuple[int, int], list[str]] = {}
    for ty in types:
        groups.setdefault(dist(ty), []).append(ty)
    out: list[str] = []
    for key in sorted(groups):
        g = groups[key]
        k = turn % len(g)
        out += g[k:] + g[:k]
    return out


def held(
    level: str,
    got: Mapping[str, int],
    target: Mapping[str, int],
    running: Mapping[str, int],
    left: int,
) -> bool:
    """이 난이도의 문제를 받지 않고 자리를 비워 둘지(Codex 리뷰 #300).

    여분 자리는 먼저 끝난 문제부터 채택되므로, 느린 난이도(조합)의 자리가 아직 도는 사이 다른
    난이도의 여분 문제가 남은 자리를 다 차지하면 목표 난이도가 0문제가 됨. 그래서 이 난이도가 이미
    목표만큼 있고, 남은 자리(left)가 아직 도는 자리가 채울 모자란 난이도의 몫보다 많지 않으면 받지
    않음. running은 지금 도는 자리의 목표 난이도별 수(받으려는 자리 자신은 빼고).
    """
    if got.get(level, 0) < target.get(level, 0):
        return False
    owed = sum(
        min(target[lv] - got.get(lv, 0), running.get(lv, 0))
        for lv in target
        if lv != level and target[lv] > got.get(lv, 0)
    )
    return left <= owed
