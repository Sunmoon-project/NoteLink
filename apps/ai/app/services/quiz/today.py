"""오늘의 복습: 복습 날짜가 된 문제를 모든 퀴즈 세트에서 모아 한 세트로 (로컬 today.build).

ai_jobs.type = 'today_review' (공용 계약 AiJobType, 11/01 추가).
  코드  날짜가 된 문제 고르기 — 지난번 틀린 문제 → 약한 개념(사용자의 모든 풀이에서 틀린 수) →
        오래된 날짜 순, 같은 낱말(text.same_word)은 하나만 · 사본으로 복습 넘겨주기 · 개념별 진행
  LLM   '정답 둘' 검사(10/22) 전에 만든 문제를 검사하고(quality.screen), 걸리면 같은 낱말의
        새 문제로 바꿈(similar.make_similar)

input — NestJS가 작업을 만들 때 담습니다. ObjectId는 문자열, 날짜는 Date 또는 ISO 문자열
  day       오늘(서울 날짜 YYYY-MM-DD). 다음 날 서울 0시 전에 dueAt이 된 문제를 고릅니다
  size?     세트 문제 수(기본 5, '5문제 다시 보기')
  sets      [{id, materialId, deletedAt?, questions}] 사용자의 퀴즈 세트. 지운 세트(deletedAt
            있음)도 담습니다: 문제는 내지 않지만 그 세트의 풀이를 약한 개념 · 무효 풀이에 셉니다
            (로컬과 같음).
            점수가 같은 문제는 이 순서(만든 순)대로 고릅니다
  attempts  [{id, quizSetId, finishedAt, answers: [{questionId, answer, correct, void?}]}]
            사용자의 모든 풀이. 약한 개념(로컬처럼 기간 없이)과 무효로 할 풀이 찾기에 씁니다.
            void는 true 또는 무효 이유 글(review.is_void)
  notes     {materialId: [{pageNo, ocrText}]} 사용자의 노트 전부(오늘의 복습은 노트를 섞음)

result — NestJS가 반영합니다
  questions      새 세트 문제(order 1부터). []이면 세트를 만들지 않음
  title          '오늘의 복습 · MM-DD'
  baseSetId      materialId · folderId를 따올 세트(첫 문제가 나온 세트). sourceSetId는 null
  srsUpdates     [{quizSetId, questionId, srs}] 원래 문제의 복습 상태: 사본으로 넘겨줌(moved,
                 dueBefore에 옛 날짜) · 결함(flawed) · 검사 통과(checked) · 다시 만들 날
                 (flawTries) · reviews에서 이미 뺀 무효 풀이 수(voidedReviews, 그대로 저장).
                 결함 문제의 무효 풀이를 빼고 다시 세어 연속 정답이 차면 다 익힘(mastered, dueAt
                 null, flaw에 결함 이유): 새 문제로 바꾸지 않고 복습에서 뺌
  voidAnswers    [{attemptId, questionId, void}] 무효로 할 풀이. void(이유 글)를 그 풀이에 씀
  dropped        [{quizSetId, questionId, flaw, replacedBy, state}] 결함 문제(앱 안내 · 확인용).
                 state는 active(내일 다시 만들어 봄) · flawed(새 문제로 바꿈 · 그만 냄) ·
                 mastered(무효 풀이를 빼니 다 익힘, replacedBy null)
  due · merged   날짜가 된 문제 수 · 같은 낱말이라 함께 넘긴 다른 문제 수
  nextReview     고른 문제가 없을 때 다음 복습 날짜(서울 날짜), 남은 복습이 없으면 null
  progress       [{concept, mastered, stopped, active, wrong}] 개념별 진행(틀린 수 많은 순)

되돌리기(로컬 today.undo, NestJS 몫): 하나도 풀지 않고 그만두면 세트를 지우고, movedTo가 이
세트 문제인 moved 문제는 state='active' · dueAt=dueBefore로 돌리고(movedTo · dueBefore 지움),
flawed 문제의 movedTo가 가리키는 새 문제는 그 flawed 문제의 세트 끝에 붙입니다.

LLM 장애(로컬에는 없는 처리): '정답 둘' 검사의 호출이 실패해 판정을 다 받지 못하면(quality.screen의
'검사 못 함': 걸린 보기 없이 호출 실패) 그 문제는 검사하지 않은 그대로 내고 다음에 다시
검사합니다(checked를 남기지 않음). 다만 전날 결함으로 미룬 문제(flaw 있음)는 그대로 내지 않고
flawTries를 늘리지 않은 채 하루 더 미룹니다(dropped에 state 'active'). 미룬 결함 문제도 날마다 다시
검사해 통과하면 flaw · flawTries를 지웁니다(검사 모델이 잘못 걸렀을 수 있음. 전날 무효로 한 풀이는
그대로). 답 모양이 틀린 판정은 전처럼 그 보기를 걸리지 않은 것으로 봅니다. 새 문제 만들기가
LLM 장애(similar.make_similar의 llm_down)로 끝나면 그 문제만 내일로
미루고 flawTries는 늘리지 않습니다.
알려진 한계: 같은 낱말은 text.same_word로 보지만, 새 문제를 만들 때의 겹침 검사(checks.code_check)와
기존 문제 다시 내기(similar.reuse_existing)의 '이미 쓴 답'은 아직 text.same_item입니다(오답 복습
전체 동작이 바뀌므로 따로 다룸). 결함 문제를 바꿀 새 문제는 세트에서 이미 고른 정답과 겹침 검사를
하지 않아, 드물게 같은 답이 한 세트에 두 번 나올 수 있습니다(넓은 same_item으로 막으면 지난번 틀린
낱말과 비슷한 낱말이 이미 있을 때 새 문제를 영영 못 만들어 복습에서 빠짐).
알려진 한계(로컬과 같음): 노트 글이 없는 자료의 문제도 사용자의 다른 노트 쪽(text.locate)으로
검사합니다. 오늘의 복습 세트는 노트를 섞어서 세트의 materialId로 쪽을 가릴 수 없습니다.
"""

import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import cast

from app.clients.llm import JsonObject, Llm
from app.services.quiz import quality, similar, srs
from app.services.quiz.checks import Seen, Target, seen_question
from app.services.quiz.models import Draft, Notes, Question
from app.services.quiz.review import (
    REVIEW_SET_SIZE,
    InputError,
    Progress,
    concept_of,
    is_void,
    judge,
    need,
    need_list,
    new_id,
    parse_notes,
    parse_question,
    seoul_day,
    seoul_midnight,
    utc_date,
)
from app.services.quiz.text import locate, same_word, short_answer

TYPE = "today_review"
FLAW_TRIES = 3  # 결함 문제를 새 문제로 바꾸려 해 볼 날 수. 그래도 못 만들면 복습에서 뺌
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")  # date.fromisoformat은 '20261101' · '2026-W44-7'도 받음


@dataclass(frozen=True)
class QuizSet:
    id: str
    material_id: str
    questions: list[Question]
    deleted: bool = False  # 지운 세트: 문제는 내지 않고 풀이만 셈


@dataclass
class Answer:
    question_id: str
    answer: str | None
    correct: bool
    void: bool | str  # 무효면 True나 이유 글. 이번에 무효로 하면 이유 글을 넣음


@dataclass(frozen=True)
class Attempt:
    id: str
    quiz_set_id: str
    finished_at: datetime
    answers: list[Answer]


@dataclass(frozen=True)
class TodayInput:
    day: date
    size: int
    sets: list[QuizSet]
    attempts: list[Attempt]
    notes: Notes


# ---------------------------------------------------------------- input


def _answer(raw: object, where: str) -> Answer:
    a = raw.get("answer") if isinstance(raw, dict) else None
    if a is not None and not isinstance(a, str):
        raise InputError(f"{where}.answer")
    void = raw.get("void") if isinstance(raw, dict) else None
    return Answer(
        need(raw, "questionId", str, where),
        a,
        need(raw, "correct", bool, where),
        cast(bool | str, void) if is_void(void) else False,
    )


def parse(raw: JsonObject) -> TodayInput:
    """input을 확인해 꺼냅니다. 맞지 않으면 InputError(다시 해도 같으므로 바로 실패)."""
    text = need(raw, "day", str, "input")
    try:
        day = date.fromisoformat(text) if _DAY.fullmatch(text) else None
    except ValueError:
        day = None
    if day is None:
        raise InputError("input.day")
    size = raw.get("size")
    if size is None:  # 없거나 null이면 기본 크기
        size = REVIEW_SET_SIZE
    if not isinstance(size, int) or isinstance(size, bool) or size < 1:
        raise InputError("input.size")
    sets = []
    for i, s in enumerate(need_list(raw, "sets", "input")):
        w = f"input.sets[{i}]"
        qs = [
            parse_question(q, f"{w}.questions[{j}]")
            for j, q in enumerate(need_list(s, "questions", w))
        ]
        deleted = s.get("deletedAt") is not None
        sets.append(QuizSet(need(s, "id", str, w), need(s, "materialId", str, w), qs, deleted))
    attempts = []
    for i, a in enumerate(need_list(raw, "attempts", "input")):
        w = f"input.attempts[{i}]"
        attempts.append(
            Attempt(
                need(a, "id", str, w),
                need(a, "quizSetId", str, w),
                utc_date(need(a, "finishedAt", (str, datetime), w), f"{w}.finishedAt"),
                [_answer(x, f"{w}.answers[{j}]") for j, x in enumerate(need_list(a, "answers", w))],
            )
        )
    notes = parse_notes(need(raw, "notes", dict, "input"))
    return TodayInput(day, size, sets, attempts, notes)


# ---------------------------------------------------------------- code


def weakness(qmaps: dict[str, dict[str, Question]], attempts: list[Attempt]) -> Counter[str]:
    """개념마다 틀린 수. 사용자의 모든 풀이(무효 풀이 제외, 지운 세트 포함)."""
    weak: Counter[str] = Counter()
    for a in attempts:
        qm = qmaps.get(a.quiz_set_id, {})
        for x in a.answers:
            q = qm.get(x.question_id)
            if q and not x.void and judge(x.correct):
                weak[concept_of(q)] += 1
    return weak


def progress(sets: list[QuizSet]) -> defaultdict[str, Counter[str]]:
    """개념마다 다 익힘 / 중단 / 복습 중인 문제 수."""
    out: defaultdict[str, Counter[str]] = defaultdict(Counter)
    for s in sets:
        for q in s.questions:
            st = _state(q)
            if st in ("active", "mastered", "stopped"):
                out[concept_of(q)][str(st)] += 1
    return out


def _state(q: Question) -> str | None:
    st = q.get("srs")
    return st["state"] if st else None


def _page(q: Question, notes: Notes, s: QuizSet) -> tuple[int, str]:
    mid, page = locate(q, notes, s.material_id)
    return page, notes[mid][page]


def flaw(llm: Llm, s: QuizSet, q: Question, notes: Notes, hits: list[str]) -> list[str] | None:
    """저장된 문제에 '정답 둘' 검사(quality.screen). 걸린 보기는 hits에 모읍니다.

    검사 못 함(걸린 보기 없이 판정을 받지 못한 것이 있음)이면 None.
    """
    _, text = _page(q, notes, s)
    d: Draft = {
        "stem": q["prompt"],
        "passage": q.get("passage") or "",
        "options": q["choices"] or [],
        "answer": q["answer"],
    }
    why, unchecked = quality.screen(llm, d, text, q.get("type"), hits)
    return None if unchecked else why


def void_flawed(
    attempts: list[Attempt], qmaps: dict[str, dict[str, Question]], q: Question, hits: list[str]
) -> tuple[srs.Srs, list[JsonObject]]:
    """두 번째 정답(hits)을 고른 이 문제(또는 사본, _copy_of)의 풀이를 무효로.

    이 문제와 사본의 풀이 중 무효 풀이가 하나라도 있으면(이번에 무효로 한 것이 없어도: 예전에
    무효로 하고 복습 상태를 되살리지 않았을 수 있음) 남은 풀이로 복습 상태를 되살립니다(_restored).
    """
    kept, voids, void_count = [], [], 0
    for a in attempts:  # 푼 순서대로
        qm = qmaps.get(a.quiz_set_id, {})
        for x in a.answers:
            oq = qm.get(x.question_id)
            if not oq or not _copy_of(oq, q):
                continue
            if x.answer in hits and not x.void:
                x.void = f"문제 오류: 정답 둘({x.answer}도 맞음)"
                voids.append({"attemptId": a.id, "questionId": x.question_id, "void": x.void})
            if x.void:
                void_count += 1
            else:
                kept.append((a.finished_at, x.correct))
    st = cast(srs.Srs, q["srs"])
    return (_restored(st, kept, void_count) if void_count else st), voids


def _copy_of(oq: Question, q: Question) -> bool:
    """oq가 q 자신이나 그 사본인지: 문제 글 · 제시문 · 답이 같음(오늘의 복습 사본은 셋 다 같음)."""
    return (
        oq["prompt"] == q["prompt"]
        and oq.get("passage") == q.get("passage")
        and same_word(oq["answer"], q["answer"])
    )


def _restored(st: srs.Srs, kept: list[tuple[datetime, bool]], void_count: int) -> srs.Srs:
    """무효 풀이를 뺀 복습 상태(Codex 리뷰 · /code-review 11/02).

    kept는 이 문제와 그 사본의 무효가 아닌 풀이(푼 차례), void_count는 무효 풀이 전체 수(예전에
    무효로 한 것 포함).
    같은 낱말이라도 다른 문제(다른 세트에서 따로 만든 문제)의 풀이는 넣지 않습니다:
    이 문제를 한 번도 맞히지 않았는데 다 익힘이 될 수 있음.
    이 문제가 시작한 상태에서 kept를 srs.update로 다시 풉니다. 시작 상태는 저장값으로
    거꾸로 셉니다: 이어받은 횟수 = 저장된 reviews + voidedReviews − void_count − len(kept)
    (0보다 작으면 0). 저장된 reviews는 푼 풀이 전체에서 voidedReviews(이미 뺀 무효 풀이 수)만큼
    빠진 값이라, 무효 풀이를 모두 빼고 남은 풀이를 빼면 이어받은 횟수가 됩니다. 되살린 뒤
    voidedReviews = void_count로 두므로, 되살린 상태를 다시 넣어도 결과가 같습니다(멱등).
    0이면 처음 낸 문제(srs 없음), 아니면 다시 보기 새 문제(srs.fresh: step 0, 이어받은 횟수).
    이어받은 횟수가 0이면 처음부터 다시 센 streak · step이 정확해서 그 값을 씁니다(첫 풀이인
    오답을 빼면 step이 줄 수 있음: [오답, 정답]은 1, [정답]은 0). 남은 풀이도 없으면(풀이가 모두
    무효) streak · step은 0입니다.
    한계: 이어받은 연속 정답 · 단계는 저장되어 있지 않아 0에서 셉니다. 그래서 이어받은 횟수가
    있으면 streak · step은 다시 센 값과 저장값 중 큰 쪽을 씁니다.
    reviews는 다시 센 값(이어받은 횟수 + 남은 풀이 수). lastResult는 남은
    마지막 풀이(없으면 None). dueAt은 그대로(오늘 날짜가 된 복습)이고, 연속 정답이 차면
    mastered · dueAt 없음입니다. 다른 필드(checked · flawTries 등)는 그대로 둡니다.
    """
    carried = max(0, st["reviews"] + st.get("voidedReviews", 0) - void_count - len(kept))
    replay: srs.Srs | None = None
    if carried:
        replay = {
            "step": 0,
            "dueAt": None,
            "lastResult": None,
            "streak": 0,
            "reviews": carried,
            "state": "active",
        }
    for t, ok in kept:
        replay = srs.update(replay, ok, t)
    streak, step = (replay["streak"], replay["step"]) if replay else (0, 0)
    if carried:  # 이어받은 연속 정답 · 단계를 몰라 저장값보다 낮추지 않음
        streak, step = max(streak, st["streak"]), max(step, st["step"])
    out: srs.Srs = {
        **st,
        "reviews": replay["reviews"] if replay else 0,
        "streak": streak,
        "step": step,
        "lastResult": replay["lastResult"] if kept and replay else None,
        "voidedReviews": void_count,
    }
    if out["streak"] >= srs.MASTER_STREAK:
        out["state"], out["dueAt"] = "mastered", None
    return out


def replace_flawed(
    llm: Llm,
    seen: list[Seen],
    s: QuizSet,
    q: Question,
    hits: list[str],
    notes: Notes,
    slot: int,
) -> tuple[Question | None, bool]:
    """(q의 복습을 이어 갈 같은 낱말의 깨끗한 문제, LLM 장애). 모델이 못 만들면 문제는 None.

    시도마다 생성 · 검사 호출이 실패했으면(장애) 두 번째 값이 True: 장애를 '못 만듦'으로 세면
    flawTries가 늘어 3일 뒤 복습에서 빠지므로 부른 쪽이 따로 처리합니다(로컬에는 없는 처리).
    seen은 run이 한 번 만든 목록: 통과한 새 문제가 더해져 같은 실행의 다음 결함 문제와도 겹침을
    봅니다(review.run과 같음).
    """
    page, text = _page(q, notes, s)
    st = cast(srs.Srs, q["srs"])
    # 지난번 맞혔어도 원래 정답을 다시 물음: 새 문제가 이 낱말의 복습을 이어 가고(carry), 3단계는
    # 새 정답으로 같은 낱말을 넘겨줌
    t = Target(
        "wrong" if st["lastResult"] == "wrong" else "right",
        q["answer"],
        concept_of(q),
        keep_answer=True,
    )
    # 노트 묶음의 유의어는 짧은 답일 때만 피함(review._similar_for와 같음)
    group = quality.group_words(q["answer"], text) if short_answer(q["answer"]) else []
    avoid = list(dict.fromkeys(hits + group))
    m = similar.make_similar(llm, q, t, page, text, slot, seen, avoid)
    if m.question is None:
        return None, m.llm_down
    g = m.question
    new: Question = {
        **q,
        "id": new_id(),
        "type": (ty := "빈칸" if "____" in g["passage"] else m.type),
        "difficulty": similar.difficulty_of(ty),  # 유형으로 정한 처음 난이도(#268)
        "prompt": g["stem"],
        "passage": g["passage"] or None,
        "choices": g["options"],
        "answer": g["answer"],
        "explanation": g.get("explanation"),
        "srs": {**st, "state": "active", "checked": True},
    }
    return new, False


def run(llm: Llm, raw: JsonObject, report: Progress) -> JsonObject:
    """today_review 작업 하나."""
    inp = parse(raw)
    sets, notes, day = inp.sets, inp.notes, inp.day
    live = [s for s in sets if not s.deleted]  # 문제를 내는 세트. 풀이는 지운 세트까지 셈
    tomorrow = seoul_midnight(day + timedelta(days=1))
    qmaps = {s.id: {q["id"]: q for q in s.questions} for s in sets}
    attempts = sorted(inp.attempts, key=lambda a: a.finished_at)
    weak = weakness(qmaps, attempts)
    changed: dict[tuple[str, str], srs.Srs] = {}  # (quizSetId, questionId) → 바꾼 복습 상태

    # 1. 코드: 날짜가 된 문제 — 지난번 틀린 문제 → 약한 개념 → 오래된 날짜
    due: list[tuple[QuizSet, Question]] = []
    for s in live:
        for q in s.questions:
            st = q.get("srs")
            if st and st["state"] == "active" and st["dueAt"] and st["dueAt"] < tomorrow:
                due.append((s, q))
    due.sort(
        key=lambda sq: (
            cast(srs.Srs, sq[1]["srs"]).get("lastResult") != "wrong",
            -weak[concept_of(sq[1])],
            cast(srs.Srs, sq[1]["srs"])["dueAt"],
        )
    )
    report(15, "복습할 문제 고르기")

    # 2. 같은 낱말은 하나만. 검사 안 한 문제는 검사하고 걸리면 바꿈
    picked: list[tuple[QuizSet, Question]] = []
    dropped: list[JsonObject] = []
    voids: list[JsonObject] = []
    made: set[str] = set()
    has_notes = any(notes.values())
    seen = [seen_question(x) for y in sets for x in y.questions]  # 새 문제의 겹침 검사
    shown = 15
    for n, (s, q) in enumerate(due, 1):
        if (value := 15 + 70 * n // len(due)) != shown:  # 진행률은 바뀔 때만 씀(ai_jobs 쓰기)
            report(value, "복습할 문제 고르기")
            shown = value
        if any(same_word(q["answer"], p["answer"]) for _, p in picked):
            continue
        st = cast(srs.Srs, q["srs"])
        choices = q["choices"]
        # 단답형(choices 없음)은 검사 대상이 아니고, 노트 글이 없으면 검사 · 새 문제를 못 함.
        # 보기는 모두 5지선다로 만들어서(models.CHOICES) 보기 수는 보지 않음(로컬에만 있는
        # 10/26 전 4지선다 처리)
        if has_notes and choices is not None and not st.get("checked"):
            # '정답 둘' 검사(10/22) 전에 만든 문제는 검사한 적이 없음
            hits: list[str] = []
            found = flaw(llm, s, q, notes, hits)
            if found is None and st.get("flaw"):
                # 전날 결함으로 미룬 문제는 검사를 못 해도 그대로 내지 않음: 하루 더 미룸
                # (시도 수는 그대로)
                st = {**st, "dueAt": tomorrow}
                q["srs"] = st
                changed[(s.id, q["id"])] = st
                dropped.append(
                    {
                        "quizSetId": s.id,
                        "questionId": q["id"],
                        "flaw": st["flaw"],
                        "replacedBy": None,
                        "state": "active",
                    }
                )
                continue
            if found is None:  # 검사 호출 실패: 검사하지 않은 그대로 내고 다음에 다시 검사
                picked.append((s, q))
                if len(picked) == inp.size:
                    break
                continue
            why = found
            new, down = None, False
            if why:
                st, voided = void_flawed(attempts, qmaps, q, hits)
                voids += voided
                q["srs"] = st
                if st["state"] == "active":  # 무효 오답을 빼니 다 익혔으면 바꿀 필요 없음
                    new, down = replace_flawed(llm, seen, s, q, hits, notes, len(picked))
            tries = st.get("flawTries", 0) + 1
            if why and st["state"] != "active":
                st = {**st, "flaw": "; ".join(why)}
            elif why and down:
                # 생성 모델 장애: 못 만든 날로 세지 않고 내일 다시 만들어 봄
                st = {**st, "dueAt": tomorrow, "flaw": "; ".join(why)}
            elif why and new:
                st = {**st, "state": "flawed", "dueAt": None, "flaw": "; ".join(why)}
                st["movedTo"] = new["id"]
            elif why and tries < FLAW_TRIES:
                # 아직 깨끗한 새 문제가 없음: 낱말은 복습에 두고 오늘은 빼고 내일 다시 만들어 봄
                st = {**st, "dueAt": tomorrow, "flaw": "; ".join(why), "flawTries": tries}
            elif why:
                # FLAW_TRIES일 동안 못 만듦: 깨끗하게 낼 수 없는 문제는 그만 냄(노트 줄은 남음)
                st = {**st, "state": "flawed", "dueAt": None, "flaw": "; ".join(why)}
            else:
                # 전날 결함으로 미룬 문제가 오늘 검사를 통과: 결함 표시 · 시도 수를 지움(검사 모델이
                # 잘못 걸렀을 수 있어 날마다 다시 검사함. 전날 무효로 한 풀이는 그대로 둠)
                st = {**st, "checked": True}
                st.pop("flaw", None)
                st.pop("flawTries", None)
            q["srs"] = st
            changed[(s.id, q["id"])] = st
            if why:
                dropped.append(
                    {
                        "quizSetId": s.id,
                        "questionId": q["id"],
                        "flaw": st["flaw"],
                        "replacedBy": new["id"] if new else None,
                        "state": st["state"],
                    }
                )
            if why and not new:
                continue
            if new:
                carry: srs.Srs = {
                    **st,
                    "state": "active",
                    "checked": True,
                    "dueAt": cast(srs.Srs, new["srs"])["dueAt"],
                }
                carry.pop("flaw", None)
                carry.pop("movedTo", None)
                carry.pop("flawTries", None)  # 새 문제는 결함 시도를 처음부터 셈
                carry.pop("voidedReviews", None)  # 새 문제는 풀이가 따로라 뺀 수도 따로 셈
                new["srs"] = carry
                made.add(new["id"])
                q = new
        picked.append((s, q))
        if len(picked) == inp.size:
            break

    if voids:  # 이번에 무효로 한 오답은 틀린 수에서 뺌(고르는 순서는 처음 센 대로)
        weak = weakness(qmaps, attempts)
    counts = progress(live)
    result: JsonObject = {
        "questions": [],
        "title": None,
        "baseSetId": None,
        "srsUpdates": [],
        "voidAnswers": voids,
        "dropped": dropped,
        "due": len(due),
        "merged": 0,
        "nextReview": None,
        "progress": [
            {
                "concept": c,
                "mastered": n["mastered"],
                "stopped": n["stopped"],
                "active": n["active"],
                "wrong": weak[c],
            }
            for c, n in sorted(counts.items(), key=lambda kv: -weak[kv[0]])
        ],
    }
    if not picked:
        nxt = min(
            (
                st["dueAt"]
                for s in live
                for q in s.questions
                if (st := q.get("srs")) and st["state"] == "active" and st["dueAt"]
            ),
            default=None,
        )
        result["nextReview"] = seoul_day(nxt).isoformat() if nxt else None
        result["srsUpdates"] = _updates(changed)
        report(100, "복습할 문제 없음")
        return result

    # 3. 코드: 사본으로 넘겨줌. 같은 낱말의 다른 복습 중 문제도 함께 넘겨 내일 다시 나오지 않게
    questions: list[JsonObject] = []
    merged = 0
    # 결함으로 다시 만들 복습 중 문제(flaw 있음)는 같은 낱말의 사본으로 넘기지 않음: 결함 처리가
    # 덮임. 오늘 미룬 것(dropped의 active)뿐 아니라 전날 미뤄 오늘 같은 낱말 검사로 건너뛴 것도.
    # 고른 문제 자신은 그 사본으로 넘김(노트가 없으면 결함 문제도 그대로 냄)
    chosen = {(s.id, q["id"]) for s, q in picked}
    active = [
        (s, q, cast(srs.Srs, q["srs"]))
        for s in live
        for q in s.questions
        if _state(q) == "active"
        and (not cast(srs.Srs, q["srs"]).get("flaw") or (s.id, q["id"]) in chosen)
    ]
    for i, (_, q) in enumerate(picked, 1):
        # 결함 문제를 바꾼 새 문제는 id를 그대로 둠: flawed 문제의 movedTo가 이 id를 가리킴
        cid = q["id"] if q["id"] in made else new_id()
        copy: Question = {**q, "id": cid, "order": i, "srs": {**cast(srs.Srs, q["srs"])}}
        questions.append(cast(JsonObject, copy))
        for s2, q2, st2 in active:
            if q2["id"] == q["id"] or same_word(q2["answer"], q["answer"]):
                changed[(s2.id, q2["id"])] = srs.moved(st2, cid)
                merged += q2["id"] != q["id"]
    report(100, "복습 세트 만들기")
    return {
        **result,
        "questions": questions,
        "title": f"오늘의 복습 · {day:%m-%d}",
        "baseSetId": picked[0][0].id,
        "srsUpdates": _updates(changed),
        "merged": merged,
    }


def _updates(changed: dict[tuple[str, str], srs.Srs]) -> list[JsonObject]:
    return [{"quizSetId": sid, "questionId": qid, "srs": st} for (sid, qid), st in changed.items()]
