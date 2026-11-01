"""오늘의 복습: 복습 날짜가 된 문제를 모든 퀴즈 세트에서 모아 한 세트로 (로컬 today.build).

ai_jobs.type = 'today_review' (공용 계약 AiJobType, 11/01 추가).
  코드  날짜가 된 문제 고르기 — 지난번 틀린 문제 → 약한 개념(사용자의 모든 풀이에서 틀린 수) →
        오래된 날짜 순, 같은 낱말(text.same_item)은 하나만 · 사본으로 복습 넘겨주기 · 개념별 진행
  LLM   '정답 둘' 검사(10/22) 전에 만든 문제와 보기가 5개가 아닌 문제(10/26)를 검사하고
        (quality.two_answers), 걸리면 같은 낱말의 새 문제로 바꿈(similar.make_similar)

input — NestJS가 작업을 만들 때 담습니다. ObjectId는 문자열, 날짜는 Date 또는 ISO 문자열
  day       오늘(서울 날짜 YYYY-MM-DD). 다음 날 서울 0시 전에 dueAt이 된 문제를 고릅니다
  size?     세트 문제 수(기본 5, '5문제 다시 보기')
  sets      [{id, materialId, folderId?, questions}] 사용자의 퀴즈 세트(지운 것 제외). 점수가 같은
            문제는 이 순서(만든 순)대로 고릅니다
  attempts  [{id, quizSetId, finishedAt, answers: [{questionId, answer, correct, void?}]}]
            사용자의 모든 풀이. 약한 개념(로컬처럼 기간 없이)과 무효로 할 풀이 찾기에 씁니다
  notes     {materialId: [{pageNo, ocrText}]} 사용자의 노트 전부(오늘의 복습은 노트를 섞음)

result — NestJS가 반영합니다
  questions      새 세트 문제(order 1부터). []이면 세트를 만들지 않음
  title          '오늘의 복습 · MM-DD'
  baseSetId      materialId · folderId를 따올 세트(첫 문제가 나온 세트). sourceSetId는 null
  srsUpdates     [{quizSetId, questionId, srs}] 원래 문제의 복습 상태: 사본으로 넘겨줌(moved,
                 dueBefore에 옛 날짜) · 결함(flawed) · 검사 통과(checked) · 다시 만들 날(flawTries)
  voidAnswers    [{attemptId, questionId, void}] 무효로 할 풀이. void(이유 글)를 그 풀이에 씀
  dropped        [{quizSetId, questionId, flaw, replacedBy, state}] 결함 문제(앱 안내 · 확인용)
  due · merged   날짜가 된 문제 수 · 같은 낱말이라 함께 넘긴 다른 문제 수
  nextReview     고른 문제가 없을 때 다음 복습 날짜(서울 날짜), 남은 복습이 없으면 null
  progress       [{concept, mastered, stopped, active, wrong}] 개념별 진행(틀린 수 많은 순)

되돌리기(로컬 today.undo, NestJS 몫): 하나도 풀지 않고 그만두면 세트를 지우고, movedTo가 이
세트 문제인 moved 문제는 state='active' · dueAt=dueBefore로 돌리고(movedTo · dueBefore 지움),
flawed 문제의 movedTo가 가리키는 새 문제는 그 flawed 문제의 세트 끝에 붙입니다.
"""

from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, cast

from app.clients.llm import JsonObject, Llm, LlmError
from app.services.quiz import quality, similar, srs
from app.services.quiz.checks import Target, seen_question
from app.services.quiz.models import CHOICES, Draft, Notes, Question
from app.services.quiz.review import (
    REVIEW_SET_SIZE,
    SEOUL,
    InputError,
    Progress,
    concept_of,
    judge,
    need,
    need_list,
    new_id,
    parse_notes,
    parse_question,
    seoul_midnight,
    utc_date,
)
from app.services.quiz.text import locate, same_item

TYPE = "today_review"
FLAW_TRIES = 3  # 결함 문제를 새 문제로 바꾸려 해 볼 날 수. 그래도 못 만들면 복습에서 뺌


@dataclass(frozen=True)
class QuizSet:
    id: str
    material_id: str
    questions: list[Question]


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
        void if isinstance(void, str) and void else void is True,
    )


def parse(raw: JsonObject) -> TodayInput:
    """input을 확인해 꺼냅니다. 맞지 않으면 InputError(다시 해도 같으므로 바로 실패)."""
    try:
        day = date.fromisoformat(need(raw, "day", str, "input"))
    except ValueError:
        raise InputError("input.day") from None
    size = raw.get("size", REVIEW_SET_SIZE)
    if not isinstance(size, int) or isinstance(size, bool) or size < 1:
        raise InputError("input.size")
    sets = []
    for i, s in enumerate(need_list(raw, "sets", "input")):
        w = f"input.sets[{i}]"
        qs = [
            parse_question(q, f"{w}.questions[{j}]")
            for j, q in enumerate(need_list(s, "questions", w))
        ]
        sets.append(QuizSet(need(s, "id", str, w), need(s, "materialId", str, w), qs))
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


def seoul_day(t: datetime) -> date:
    """UTC 시각(tzinfo 없음)의 서울 날짜."""
    return t.replace(tzinfo=UTC).astimezone(SEOUL).date()


def weakness(sets: list[QuizSet], attempts: list[Attempt]) -> Counter[str]:
    """개념마다 틀린 수. 사용자의 모든 풀이(무효 풀이 제외)."""
    qmaps = {s.id: {q["id"]: q for q in s.questions} for s in sets}
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


def flaw(llm: Llm, s: QuizSet, q: Question, notes: Notes, hits: list[str]) -> list[str]:
    """저장된 문제에 '정답 둘' 검사(quality.two_answers). 걸린 보기는 hits에 모읍니다."""
    _, text = _page(q, notes, s)
    d: Draft = {
        "stem": q["prompt"],
        "passage": q.get("passage") or "",
        "options": q["choices"] or [],
        "answer": q["answer"],
    }
    return quality.two_answers(llm, d, text, q.get("type"), hits)


def void_flawed(
    attempts: list[Attempt], qmaps: dict[str, dict[str, Question]], q: Question, hits: list[str]
) -> tuple[srs.Srs, list[JsonObject]]:
    """두 번째 정답(hits)을 고른 이 문제(또는 문제 글 · 제시문이 같은 사본)의 풀이를 무효로.

    그 풀이만큼 reviews를 빼고, lastResult는 같은 낱말에서 무효가 아닌 마지막 풀이로 돌립니다.
    """
    voided, last, voids = 0, None, []
    for a in sorted(attempts, key=lambda a: a.finished_at):
        qm = qmaps.get(a.quiz_set_id, {})
        for x in a.answers:
            oq = qm.get(x.question_id)
            if not oq or not same_item(oq["answer"], q["answer"]):
                continue
            if (
                oq.get("passage") == q.get("passage")
                and oq["prompt"] == q["prompt"]
                and x.answer in hits
                and not x.void
            ):
                x.void = f"문제 오류: 정답 둘({x.answer}도 맞음)"
                voids.append({"attemptId": a.id, "questionId": x.question_id, "void": x.void})
                voided += 1
            if not x.void:
                last = "right" if x.correct else "wrong"
    st = cast(srs.Srs, q["srs"])
    out: srs.Srs = {
        **st,
        "reviews": max(0, st["reviews"] - voided),
        "lastResult": cast(Any, last) if voided else st["lastResult"],
    }
    return out, voids


def replace_flawed(
    llm: Llm,
    sets: list[QuizSet],
    s: QuizSet,
    q: Question,
    hits: list[str],
    notes: Notes,
    slot: int,
) -> Question | None:
    """q의 복습을 이어 갈 같은 낱말의 깨끗한 문제. 모델이 못 만들면 None.

    생성 호출이 모두 실패하면(LLM 장애) LlmError: 작업 처리기가 나중에 다시 시도합니다(로컬에는
    없는 처리. 장애를 '못 만듦'으로 세면 flawTries가 늘어 3일 뒤 복습에서 빠지므로).
    """
    page, text = _page(q, notes, s)
    st = cast(srs.Srs, q["srs"])
    seen = [seen_question(x) for y in sets for x in y.questions]
    t = Target("wrong" if st["lastResult"] == "wrong" else "right", q["answer"], concept_of(q))
    avoid = list(dict.fromkeys(hits + quality.group_words(q["answer"], text)))
    m = similar.make_similar(llm, q, t, page, text, slot, seen, avoid)
    if m.llm_down:
        raise LlmError("결함 문제 바꾸기 호출이 모두 실패")
    if m.question is None:
        return None
    g = m.question
    new: Question = {
        **q,
        "id": new_id(),
        "type": "빈칸" if "____" in g["passage"] else m.type,
        "prompt": g["stem"],
        "passage": g["passage"] or None,
        "choices": g["options"],
        "answer": g["answer"],
        "explanation": g.get("explanation"),
        "srs": {**st, "state": "active", "checked": True},
    }
    return new


def run(llm: Llm, raw: JsonObject, report: Progress) -> JsonObject:
    """today_review 작업 하나."""
    inp = parse(raw)
    sets, notes, day = inp.sets, inp.notes, inp.day
    tomorrow = seoul_midnight(day + timedelta(days=1))
    weak = weakness(sets, inp.attempts)
    qmaps = {s.id: {q["id"]: q for q in s.questions} for s in sets}
    changed: dict[tuple[str, str], srs.Srs] = {}  # (quizSetId, questionId) → 바꾼 복습 상태

    # 1. 코드: 날짜가 된 문제 — 지난번 틀린 문제 → 약한 개념 → 오래된 날짜
    due: list[tuple[QuizSet, Question]] = []
    for s in sets:
        for q in s.questions:
            st = q.get("srs")
            if st and st["state"] == "active" and st["dueAt"] and st["dueAt"] < tomorrow:
                due.append((s, q))
    due.sort(
        key=lambda sq: (
            cast(srs.Srs, sq[1]["srs"])["lastResult"] != "wrong",
            -weak[concept_of(sq[1])],
            cast(srs.Srs, sq[1]["srs"])["dueAt"],
        )
    )
    report(15, "복습할 문제 고르기")

    # 2. 같은 낱말은 하나만. 검사 안 한 문제 · 보기가 5개가 아닌 문제는 검사하고 걸리면 바꿈
    picked: list[tuple[QuizSet, Question]] = []
    dropped: list[JsonObject] = []
    voids: list[JsonObject] = []
    made: set[str] = set()
    has_notes = any(notes.values())
    for n, (s, q) in enumerate(due, 1):
        report(15 + 70 * n // len(due), "복습할 문제 고르기")
        if any(same_item(q["answer"], p["answer"]) for _, p in picked):
            continue
        st = cast(srs.Srs, q["srs"])
        choices = q["choices"]
        short = choices is not None and len(choices) != CHOICES
        # 단답형(choices 없음)은 검사 대상이 아니고, 노트 글이 없으면 검사 · 새 문제를 못 함
        if has_notes and choices is not None and (not st.get("checked") or short):
            # '정답 둘' 검사(10/22) 전에 만든 문제는 검사한 적이 없음. 5번째 보기를 못 더한
            # 4지선다(10/26)도 같은 방법으로 다시 만듦
            hits: list[str] = []
            why = flaw(llm, s, q, notes, hits) if not st.get("checked") else []
            if short:
                why.append(f"보기 {len(choices)}개({CHOICES}지선다 아님)")
            new = None
            if why:
                st, found = void_flawed(inp.attempts, qmaps, q, hits)
                voids += found
                q["srs"] = st
                new = replace_flawed(llm, sets, s, q, hits, notes, len(picked))
            tries = st.get("flawTries", 0) + 1
            if why and new:
                st = {**st, "state": "flawed", "dueAt": None, "flaw": "; ".join(why)}
                st["movedTo"] = new["id"]
            elif why and tries < FLAW_TRIES:
                # 아직 깨끗한 새 문제가 없음: 낱말은 복습에 두고 오늘은 빼고 내일 다시 만들어 봄
                st = {**st, "dueAt": tomorrow, "flaw": "; ".join(why), "flawTries": tries}
            elif why:
                # FLAW_TRIES일 동안 못 만듦: 깨끗하게 낼 수 없는 문제는 그만 냄(노트 줄은 남음)
                st = {**st, "state": "flawed", "dueAt": None, "flaw": "; ".join(why)}
            else:
                st = {**st, "checked": True}
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
                new["srs"] = carry
                made.add(new["id"])
                q = new
        picked.append((s, q))
        if len(picked) == inp.size:
            break

    counts = progress(sets)
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
                for s in sets
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
    active = [
        (s, q, cast(srs.Srs, q["srs"])) for s in sets for q in s.questions if _state(q) == "active"
    ]
    for i, (_, q) in enumerate(picked, 1):
        # 결함 문제를 바꾼 새 문제는 id를 그대로 둠: flawed 문제의 movedTo가 이 id를 가리킴
        cid = q["id"] if q["id"] in made else new_id()
        copy: Question = {**q, "id": cid, "order": i, "srs": {**cast(srs.Srs, q["srs"])}}
        questions.append(cast(JsonObject, copy))
        for s2, q2, st2 in active:
            if q2["id"] == q["id"] or same_item(q2["answer"], q["answer"]):
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
