"""맞춤 퀴즈: 노트로 새 퀴즈 한 세트. 이 사용자가 아직 틀리는 쪽을 더 묻습니다 (로컬 quiz_gen.py).

ai_jobs.type = 'quiz_generate' (공용 계약 AiJobType).
ai_jobs.type = 'quiz_pregen': 노트를 만들 때 NestJS가 넣는 첫 맞춤 퀴즈 미리 만들기(#134). input ·
  result는 quiz_generate와 같고, 처리기는 사용자가 기다리는 작업이 없을 때만 가져갑니다
  (worker/jobs.py).

모드(#274): 바로 요청(quiz_generate)은 빠른 모드(FAST), 미리 만들기는 안정적 모드(STABLE). 안정적
  모드는 한국어 용어 과목 쪽에 유형 둘을 더합니다(#268): 부정설명('옳지 않은 것은?', 정답이 틀린
  설명)과 조합(ㄱ · ㄴ · ㄷ 중 옳은 것을 모두, combo.py가 조립). 미리 만들기를 사용자가 이어받으면
  (report.awaited) 다음 판부터 빠른 모드 유형으로 만듭니다(이미 만든 문제는 그대로).

난이도(#268, 규칙은 levels.py): 세트의 하 · 중 · 상 비율을 이 사용자의 난이도별 정답률로 정합니다
  (기본 2 : 2 : 1, 많이 틀린 난이도를 늘림). 자리마다 난이도를 정해 그 난이도의 유형으로 만들고,
  다음 판은 모자란 난이도부터 채웁니다. 같은 난이도 안의 유형은 빠른 모드는 쪽마다, 안정적 모드는
  세트 전체에서 돌립니다. 유형의 난이도는 모든 사용자의 정답률(input.typeStats)로 고칩니다.

만들기(#512): 초안을 한 판에 모두 만든 뒤 한 번에 검사합니다.
  1. 자리(문제 수)와 여분 자리(모자란 수 × SPARE, 올림)마다 초안 1개를 동시에 만듦(생성 모델 호출
     1번, 조합은 combo.build). 코드 검사(checks.code_check: 보기 모양 · 정답 노출 등)에 걸린
     초안은 버림
  2. 이미 있는 문제 · 이 세트에 넣은 문제와 거의 같은 초안(checks.too_close)은 버림
  3. 남은 초안을 검사 모델이 한 호출로 모두 풂(check_all): 문제마다 고른 답 · 정답이 하나뿐인지 ·
     노트로 정해지는지. 다른 답을 고르거나 정답의 유일성 · 노트 근거가 불확실한 초안은 버림
  4. 통과한 초안을 세트에 넣음. 이미 넣은 문제와 같은 정답을 같은 유형으로 묻거나 한 개념을
     PER_CONCEPT문제 넘게 묻는 초안은 남겨 둠
  5. 모자라면 못 채운 자리만 한 번 더 만들어 검사함(ROUNDS판, 앞 초안의 문제점을 알려 줌). 그래도
     모자라면 검사를 통과했지만 겹침 때문에 남겨 둔 초안으로만 채움
  #512 전에는 문제마다 생성 → 정답 둘 검사 → 검사 모델 풀기(미리 만들기는 생성 모델 2차 풀기도)를
  거치고, 떨어지면 그 자리만 다시 만들기를 5판까지 했습니다. 겹침도 한 개념 1문제 · 같은 정답 ·
  같은 노트 문장 · 거꾸로 묻기를 모두 막아, 1쪽 노트 미리 만들기가 6.3분 뒤 3/5로 실패했습니다
  (11/18 학교 LLM). 이제는 거의 같은 문제만 늘 막고, 같은 노트 문장 · 거꾸로 묻기(checks.same_fact
  · reversed_of)는 보지 않으며, 같은 정답 · 같은 유형과 한 개념 PER_CONCEPT문제 넘게는 모자랄 때만
  허용합니다.
  개념 이름이 없는 노트는 먼저 쪽마다 이름을 뽑습니다(concepts.for_page, 쪽마다 동시에). 뽑은
  이름은 result.concepts로 노트에 저장되어 다음 퀴즈부터는 뽑지 않습니다.

쪽마다 문제 수(코드):
  가중치 = 1 + 1.5 × (그 쪽에서 아직 못 익힌 개념의 틀린 답 수) − 0.7 × (그 쪽의 다 익힌
  개념 수)(0.3 이상), 그다음 큰 나머지 순으로 반올림. 배운 것이 없는 쪽은 가중치 1이라
  새 내용도 나옵니다.
  다 익힌 개념이 있는 쪽이 0문제가 되면 한 문제로 다시 확인합니다(6문제 이상일 때). 그 한
  문제는 문제 수가 가장 많은 쪽에서 빼고, 그 쪽이 한 문제뿐인데 틀린 답이나 다 익힌 개념이
  있으면 다시 확인을 건너뜁니다(아직 틀리는 쪽이 0문제가 되지 않게).
  5줄보다 짧은 쪽은 묻지 않습니다.

노트 조각(희재님 노트 정리 결과 ④ chunks, #52 · #59)이 있으면 쪽 글을 조각 글로 다시 묶어 씁니다.
조각 글에는 OCR 오타 고침(auto)이 들어가고 쪽별 원본 글(ocrText)에는 들어가지 않습니다. 개념
태그(concept)는 auto만 씁니다. 11/04 기생충 노트 3개(10문제씩)에서 원본 글 12문제 · 고친 글 11문제로
생성 수는 같았고, OCR 오타가 든 채 통과한 문제는 줄었습니다(기생충 3: 2 → 0). 조각 하나씩 묻는
방식(같은 단원의 다른 조각에서 오답)은 10 · 11문제로 늘지 않고 '그 용어에 대해 사실인 오답 보기'가
늘어(기생충 2: 1 → 14) 넣지 않았습니다.

input — NestJS가 작업을 만들 때 담습니다. ObjectId는 문자열, 날짜는 Date 또는 ISO 문자열
  day       오늘(서울 날짜 YYYY-MM-DD). 세트 제목에 씁니다
  size?     문제 수(기본 10, 30까지)
  material  {id, title, pages: [{pageNo, ocrText}], concepts?: [이름], chunks?: [노트 조각]}
            퀴즈를 낼 노트. chunks는 [{order, title?, path?, text, lines: [{pageNo}], concept?,
            conceptStatus?}](노트 정리 결과 그대로)
  sets      [{id, materialId, questions}] 사용자의 퀴즈 세트(지운 것 제외). 오늘의 복습 세트는
            노트를 섞으므로 모든 세트의 문제를 낱말로 노트 쪽에 놓습니다(text.locate)
  attempts  [{id, quizSetId, finishedAt, answers: [{questionId, correct, void?}]}] 사용자의 풀이.
            void(true 또는 무효 이유 글)는 없는 풀이로 봅니다
  notes     {materialId: [{pageNo, ocrText}]} 사용자의 다른 노트(세트가 가리키는 노트 포함).
            이 노트는 material로 넣으므로 없어도 됩니다
  typeStats? {유형: {answered, correct}} 모든 사용자의 유형별 풀이 수 · 맞힌 수(levels.type_levels).
            없으면 유형의 처음 난이도. 모양이 틀린 유형은 뺌(퀴즈를 실패시키지 않음)

result — NestJS가 quiz_sets에 새 세트로 저장합니다(materialId · folderId는 노트에서)
  questions  새 세트 문제(order 1부터, srs는 null: 아직 풀지 않음). 늘 size개. difficulty(하 · 중 ·
             상)는 유형으로 정한 처음 난이도(similar.difficulty_of, #268). 저장은 NestJS와 맞춘 뒤
  title      '<노트 제목> 맞춤 퀴즈 · MM-DD'
  concepts   새로 뽑은 개념 이름(materials.concepts에 저장). 노트에 이름이 있었으면 null
  pages      [{pageNo, weight, plain, share, wrong, mastered}] 쪽마다 배분(앱 안내 · 확인용).
             plain은 기록 없이 고르게 나눴을 때, share는 실제로 나눈 문제 수
  failed     [{pageNo, why}] 못 만든 자리(마지막으로 시도한 쪽과 탈락 이유). 다 채우므로 늘 []
  levels     {target: {난이도: 문제 수}, weak: 약한 난이도 또는 null,
             user: {난이도: [푼 수, 틀린 수]}}
             세트의 난이도 비율과 그 근거(앱 안내 · 확인용, #268). 결과 문제의 실제 난이도는
             초안이 떨어지면 target과 조금 다를 수 있음


size개를 다 만들지 못하면 짧은 결과로 끝내지 않습니다(앱은 작업 상태로 성공 화면을 고름,
#175 · #247).
  - 물을 글이 없음: 글이 없거나 MIN_LINES줄 이상인 쪽이 없음. LLM을 부르기 전에 InputError
    (바로 실패)
  - LLM 장애: 첫 판의 생성 호출이 모두 실패했거나(LlmError, 모두 서버가 거절했으면
    LlmRejectedError) 첫 판의 검사 호출이 두 번 실패함. 작업 처리기가 나중에 다시 시도(거절은
    다시 시도 없음). 문제를 받은 뒤 다음 판의 장애는 받은 문제를 버리지 않고 남겨 둔 초안으로 채움
  - 그 밖(초안이 모두 버려짐): NoQuestionsError(바로 실패, 코드 NO_QUESTIONS,
    'k/n문제만 만듦(이유)'). 다시 할지는 앱의 '다시 시도'에 맡김
알려진 한계(로컬과 같음): 새 문제의 srs는 null이라, 처음 푼 뒤 복습 상태에 checked가 없어 오늘의
복습이 '정답 둘' 검사를 한 번 더 합니다.
"""

import logging
import math
import re
import threading
import time
from collections import Counter, defaultdict
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, FIRST_EXCEPTION, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from typing import Any, Literal

from app.clients.llm import (
    STOPPED,
    JsonObject,
    Llm,
    LlmError,
    LlmRejectedError,
    Stopping,
)
from app.core.config import settings
from app.services.quiz import combo, concepts, levels, similar
from app.services.quiz.checks import Seen, Target, code_check, seen_draft, seen_question, too_close
from app.services.quiz.models import CHOICES, LETTERS, Draft, Notes, Page, Question
from app.services.quiz.review import (
    OTHER,
    InputError,
    Progress,
    concept_of,
    is_void,
    judge,
    need,
    need_list,
    new_id,
    parse_notes,
    parse_pages,
    parse_question,
    utc_date,
)
from app.services.quiz.text import (
    clean_pages,
    is_combo,
    locate,
    norm,
    place,
    same_item,
    tidy,
)

log = logging.getLogger(__name__)

TYPE = "quiz_generate"
PREGEN_TYPE = "quiz_pregen"
SET_SIZE = 10
MAX_SIZE = 30  # 한 판에 초안이 최대 30 + 여분: 학교 LLM 하나를 오래 잡지 않게
MIN_LINES = 5  # 이보다 짧은 쪽은 묻지 않음
NO_TEXT = f"노트에 문제를 낼 글이 없음({MIN_LINES}줄 이상인 쪽 없음)"


def askable(text: str) -> bool:
    """문제를 낼 수 있는 쪽 글인지(정리한 글이 MIN_LINES줄 이상). NestJS askable과 같은 기준."""
    return len(text.split("\n")) >= MIN_LINES


class NoQuestionsError(InputError):
    """물을 글은 있는데 size개를 만들지 못함. 작업은 다시 시도하지 않고 code로 실패합니다."""

    code = "NO_QUESTIONS"


TEXT_CAP = 2500  # 생성 모델에 보여 주는 쪽 글
CHECK_CAP = 3000  # 검사 모델에 보여 주는 쪽 글(similar.solved와 같음)
WORKERS = 8  # 동시에 만드는 초안 · 동시에 개념을 뽑는 쪽(호출 간격은 PacedLlm이 지킴)
SPARE = 0.4  # 판마다 여분 초안: 모자란 수 × SPARE(올림). 5문제면 2개
ROUNDS = 2  # 만들고 한 번에 검사하는 판: 첫 판 + 못 채운 자리 한 번 더(#512)
PER_CONCEPT = 2  # 세트에서 한 개념을 물을 수 있는 문제 수(모자라서 채울 때는 넘어도 됨)
CHECK_NAME = "CheckAll"  # 묶은 검사 호출 이름
# 한 판의 초안을 기다리는 상한(초). 미리 만들기는 사용자 작업에 차례를 양보하므로 Mode.patience배
ROUND_SEC = 150
SPARE_WAIT_SEC = 20  # 필요한 초안이 다 나온 뒤 남은 여분 초안을 기다리는 상한(초)
# 만들기 · 검사를 합친 작업 전체 상한(초, 미리 만들기는 Mode.patience배). 사용자가 기다리는 상한
# 5분(#247)과 같음. 넘으면 남은 호출은 보내지 않고 검사 못 한 초안은 쓰지 않음(Codex 재리뷰 #513)
TOTAL_SEC = 300
TIMEOUT = "시간 상한"
_clock = time.monotonic  # 시험에서 바꿔 끼움
CHECK_BATCH = 10  # 묶은 검사 한 호출의 문제 수
CHECK_CHARS = 12000  # 묶은 검사 한 호출의 쪽 글 글자 수(쪽 CHECK_CAP자 4쪽)
BAD_SHAPE = "문제 모양이 맞지 않음"  # 서버 모양 검사(fromWorkerQuestion)에 걸림
NEAR_SAME = "이미 있는 문제와 거의 같음"
SAME_TYPE_ANSWER = "같은 정답을 같은 유형으로 다시 물음"
CONCEPT_FULL = f"한 개념을 {PER_CONCEPT}문제 넘게 물음"
NOT_SURE = "검사 모델: 정답이 하나뿐이 아니거나 노트로 정해지지 않음"
UNCHECKED = "검사 모델의 답 모양이 맞지 않음"
WHY_SHOWN = 5  # 오류 글에 담는 탈락 이유 수(자리가 많아도 ai_jobs.error가 길어지지 않게)
GROUP_TYPE = "분류"
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")

# 영어 기능어: 영어 문장 과목(토익)인지 용어만 영어인 과목인지 가름
FUNC = {
    "the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "on", "at", "for", "with",
    "by", "be", "being", "been", "and", "or", "it", "they", "he", "she", "some", "from", "this",
    "that", "will", "can", "has", "have",
}  # fmt: skip
_PHOTO = re.compile(
    r"^\(?\s*[A-Da-d]\s*\)?.*\b(?:is|are)\s+(?:being\s+)?\w+(?:ing|ed)\b", re.M | re.I
)

# 맞춤 퀴즈는 복습이 아니라 새 퀴즈: '복습용'과 '원래 문제와 같은 문장 금지(⑦)'를 뺌
GEN_SYS = similar.GEN_SYS.replace("복습용 ", "").replace(
    " ⑦ 원래 문제와 같은 문장, 같은 보기 조합을 쓰지 않는다.", ""
)


@dataclass(frozen=True)
class Mode:
    """문제를 만드는 방식(#274).

    extra     더 쓰는 유형(similar.STABLE_TYPES 중). 한국어 용어 과목 쪽에만 붙음(page_types)
    patience  판 시간 상한 배수
    """

    name: str
    extra: tuple[str, ...] = ()
    patience: int = 1  # 판 시간 상한(ROUND_SEC) 배수


# 바로 요청(quiz_generate): 사용자가 기다리므로 지금 유형만
FAST = Mode("fast")
# 미리 만들기(quiz_pregen): 새 유형 부정설명 · 조합(#268). 사용자가 이어받으면 다음 판부터 FAST
STABLE = Mode("stable", similar.STABLE_TYPES, 4)


@dataclass(frozen=True)
class Chunk:
    order: int
    title: str | None
    path: list[str]
    text: str
    page: int | None  # 첫 줄이 있는 쪽
    concept: str | None  # auto 태그만


@dataclass(frozen=True)
class Material:
    id: str
    title: str
    pages: list[Page]
    concepts: list[str]
    chunks: list[Chunk]


@dataclass(frozen=True)
class QuizSet:
    id: str
    material_id: str
    questions: list[Question]


@dataclass(frozen=True)
class Attempt:
    quiz_set_id: str
    finished_at: datetime  # UTC (tzinfo 없음). 개념마다 가장 최근에 푼 문제를 고를 때 씀
    answers: list[tuple[str, bool, bool]]  # (questionId, correct, void)


@dataclass(frozen=True)
class GenerateInput:
    day: date
    size: int
    material: Material
    sets: list[QuizSet]
    attempts: list[Attempt]
    notes: Notes
    # 모든 사용자의 유형별 (푼 수, 맞힌 수): 유형 난이도를 고침(levels.type_levels, #268)
    type_stats: dict[str, levels.Tally] = field(default_factory=dict)


@dataclass
class PageInfo:
    """한 쪽의 학습 기록: 아직 못 익힌 개념의 틀린 답 수 · 다 익힌 개념."""

    wrong: int = 0
    mastered: int = 0
    weak: list[str] = field(default_factory=list)
    done: list[str] = field(default_factory=list)
    # 마지막 단계: 이미 물은 개념 → 그 개념을 물은 유형들. 같은 개념은 다른 유형 · 다른 각도로만
    # 다시 묻는다(#247 · #268)
    angle: dict[str, list[str]] = field(default_factory=dict)


@dataclass
class Made:
    """초안 하나(draft_one의 결과). question이 있으면 코드 검사를 통과한 초안."""

    page: int
    level: str  # 이 자리의 목표 난이도
    # 만들게 한 유형. type은 제시문에 ____가 있으면 빈칸으로 적혀, 같은 유형으로 다시 묻는지는
    # 이것으로 봄(#268)
    asked_as: str
    question: Draft | None = None
    concept: str | None = None
    type: str | None = None
    key: int | None = None  # 정답 보기 위치
    why: list[str] = field(default_factory=list)
    down: bool = False  # 생성 호출이 실패함
    rejected: bool = False  # 서버가 생성 요청을 거절함(LlmRejectedError, #262)
    # 초안 잘못(다음 판에 문제점으로 알림). 호출 실패 · 답 모양 오류는 초안 잘못이 아님
    fault: bool = False


@dataclass(frozen=True)
class Slot:
    """만들 자리 하나: 쪽 · 목표 난이도 · 만들게 할 유형 · 고를 개념 · 쪽 기록 · 앞 문제점."""

    page: int
    level: str
    type: str
    names: list[str]
    info: PageInfo
    notes: str = ""


# ---------------------------------------------------------------- input


def _chunk(raw: object, where: str) -> Chunk:
    text = need(raw, "text", str, where)
    order = need(raw, "order", int, where)
    title = raw.get("title") if isinstance(raw, dict) else None
    path = raw.get("path") if isinstance(raw, dict) else None
    lines = raw.get("lines") if isinstance(raw, dict) else None
    if title is not None and not isinstance(title, str):
        raise InputError(f"{where}.title")
    if path is not None and not (isinstance(path, list) and all(isinstance(p, str) for p in path)):
        raise InputError(f"{where}.path")
    page = None
    if lines is not None:
        if not isinstance(lines, list):
            raise InputError(f"{where}.lines")
        if lines:
            page = need(lines[0], "pageNo", int, f"{where}.lines[0]")
    concept = raw.get("concept") if isinstance(raw, dict) else None
    status = raw.get("conceptStatus") if isinstance(raw, dict) else None
    auto = concept if isinstance(concept, str) and concept and status == "auto" else None
    return Chunk(order, title, list(path or []), text, page, auto)


def _material(raw: object) -> Material:
    w = "input.material"
    pages = parse_pages(need_list(raw, "pages", w), f"{w}.pages")
    names = raw.get("concepts") if isinstance(raw, dict) else None
    if names is not None and not (
        isinstance(names, list) and all(isinstance(n, str) for n in names)
    ):
        raise InputError(f"{w}.concepts")
    chunks = raw.get("chunks") if isinstance(raw, dict) else None
    if chunks is not None and not isinstance(chunks, list):
        raise InputError(f"{w}.chunks")
    return Material(
        need(raw, "id", str, w),
        need(raw, "title", str, w),
        pages,
        list(names or []),
        [_chunk(c, f"{w}.chunks[{i}]") for i, c in enumerate(chunks or [])],
    )


def parse(raw: JsonObject) -> GenerateInput:
    """input을 확인해 꺼냅니다. 맞지 않으면 InputError(다시 해도 같으므로 바로 실패)."""
    text = need(raw, "day", str, "input")
    try:
        day = date.fromisoformat(text) if _DAY.fullmatch(text) else None
    except ValueError:
        day = None
    if day is None:
        raise InputError("input.day")
    size = raw.get("size")
    if size is None:
        size = SET_SIZE
    if not isinstance(size, int) or isinstance(size, bool) or not 1 <= size <= MAX_SIZE:
        raise InputError("input.size")
    material = _material(raw.get("material"))
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
        need(a, "id", str, w)
        at = utc_date(need(a, "finishedAt", (str, datetime), w), f"{w}.finishedAt")
        answers = []
        for j, x in enumerate(need_list(a, "answers", w)):
            wx = f"{w}.answers[{j}]"
            void = x.get("void") if isinstance(x, dict) else None
            answers.append(
                (need(x, "questionId", str, wx), need(x, "correct", bool, wx), is_void(void))
            )
        attempts.append(Attempt(need(a, "quizSetId", str, w), at, answers))
    # 이전에 MongoDB가 빈 객체를 생략해 저장한 작업도 처리한다. 잘못된 형식은 그대로 거절한다.
    notes = parse_notes(need({"notes": raw.get("notes", {})}, "notes", dict, "input"))
    return GenerateInput(day, size, material, sets, attempts, notes, _type_stats(raw))


def _type_stats(raw: JsonObject) -> dict[str, levels.Tally]:
    """input.typeStats {유형: {answered, correct}}(없어도 됨, #268). 모양이 틀린 유형은 뺌: 난이도를
    고치는 참고값이라 이것 하나로 퀴즈를 실패시키지 않음."""
    out: dict[str, levels.Tally] = {}
    stats = raw.get("typeStats")
    if not isinstance(stats, dict):
        return out
    for ty, v in stats.items():
        a = v.get("answered") if isinstance(v, dict) else None
        c = v.get("correct") if isinstance(v, dict) else None
        ok = all(isinstance(x, int) and not isinstance(x, bool) for x in (a, c))
        if ok and 0 <= c <= a:  # type: ignore[operator]
            out[str(ty)] = levels.Tally(int(a), int(c))  # type: ignore[arg-type]
    return out


# ---------------------------------------------------------------- code: note text


def title_core(title: str | None) -> str:
    """'1. 최통' → '최통', '2. 메닐편모충 (비병원성)' → '메닐편모충'."""
    t = re.sub(r"^\s*(?:\d+|[IVXⅠ-Ⅻ]+)\s*[.)]\s*", "", (title or "").replace("[?]", ""))
    return re.sub(r"\s*\(.*$", "", t).strip()


def _hangul(w: str) -> str:
    return re.sub(r"[^가-힣]", "", w)


def _jamo(syllable: str) -> set[int]:
    """한 음절의 (초성, 중성, 종성) 번호. 자리가 섞이지 않게 0 · 100 · 200을 더함.

    받침이 없으면 종성은 넣지 않습니다: 넣으면 받침 없는 음절끼리 늘 같아 '개요' → 모기가
    오타 꼴이 됐습니다(/code-review #94).
    """
    n = ord(syllable) - 0xAC00
    out = {n // 588, 100 + n % 588 // 28}
    return out | {200 + n % 28} if n % 28 else out


def typo_shape(word: str, term: str) -> bool:
    """OCR 오타 꼴: 한글 글자 수가 같고, 같은 자리 글자끼리 자모가 하나 이상 같음(노트 정리
    tagging.py의 auto 기준에서 받침 없음끼리는 같다고 보지 않음, _jamo). '최통' → 회충은 맞고,
    '개요' → 회충 · 모기 · 'Summary' → 영어 태그는 아님. auto 태그 자체는 그대로 씁니다
    (제목만 안 바꿈)."""
    a, b = _hangul(word), _hangul(term)
    return (
        bool(a) and len(a) == len(b) and all(_jamo(x) & _jamo(y) for x, y in zip(a, b, strict=True))
    )


def chunk_text(c: Chunk) -> str:
    """조각 글에서 [?] 줄을 뺀 것(text.clean_pages와 같음).

    auto 태그가 한글 글자 수가 같은 제목에 붙었으면 OCR 오타 꼴(노트 정리 tagging.py)이라 제목
    낱말을 태그로 바꿉니다: '1. 최통'은 회충이고, 그대로 두면 회충을 묻는 문제가 '정답이 노트에
    없음'으로 떨어졌습니다(기생충 2, 11/04).
    """
    text = "\n".join(ln for ln in c.text.split("\n") if ln.strip() and "[?]" not in ln)
    core = title_core(c.title)
    if c.concept and core and norm(c.concept) not in norm(text) and typo_shape(core, c.concept):
        text = text.replace(core, c.concept, 1)
    return text


def fixed_pages(chunks: list[Chunk]) -> dict[int, str]:
    """{pageNo: 글}: 조각마다 첫 줄이 있는 쪽에 고친 글을 붙이고, 상위 제목(path)은 바뀔 때만 씀."""
    out: defaultdict[int, list[str]] = defaultdict(list)
    last: dict[int, list[str]] = {}
    for c in sorted(chunks, key=lambda c: c.order):
        if c.page is None:
            continue
        if last.get(c.page) != c.path:
            out[c.page] += c.path
            last[c.page] = c.path
        t = chunk_text(c)
        if t:
            out[c.page].append(t)
    return {p: "\n".join(v) for p, v in sorted(out.items()) if v}


def note_pages(m: Material) -> dict[int, str]:
    """퀴즈를 낼 쪽 글: 노트 조각이 시작하는 쪽은 고친 글로, 나머지 쪽은 쪽별 원본 글로.

    쪽 번호(lines)가 없는 조각은 어느 쪽에도 붙이지 않습니다.
    """
    fixed = fixed_pages(m.chunks) if m.chunks else {}
    return dict(sorted({**clean_pages(m.pages), **fixed}.items()))


# ---------------------------------------------------------------- code: sharing out


def history(
    sets: list[QuizSet],
    attempts: list[Attempt],
    material_id: str,
    notes: Notes,
    where: dict[str, tuple[str, int]] | None = None,
) -> defaultdict[int, PageInfo]:
    """쪽마다: 아직 못 익힌 개념의 틀린 답 수 · 다 익힌 개념.

    저장된 문제에는 출처 쪽이 없어 낱말로 쪽에 놓습니다(text.locate). where는 문제마다 놓인
    (materialId, pageNo)를 담아 두는 곳이라, 넘기면 run의 겹침 검사가 같은 자리를 다시 씁니다.
    """
    by_id = {s.id: s for s in sets}
    where = {} if where is None else where

    def home(s: QuizSet, q: Question) -> tuple[str, int]:
        if q["id"] not in where:
            where[q["id"]] = locate(q, notes, s.material_id)
        return where[q["id"]]

    # 개념 이름이 없는 문제(OTHER)는 셈에서 뺌: 여러 쪽의 문제가 '기타' 하나로 모여 첫 쪽에 몰림
    # 다 익힌 개념이 아닌 것(틀린 답을 셈):
    # - 같은 개념의 문제가 아직 복습 중(active): 예전 문제를 익혔어도 새 문제를 계속 틀림
    #   (Codex 리뷰 #94)
    # - 5번 풀어도 못 익혀 멈춘(stopped) 문제를 익힌 문제보다 나중에 풀었음: 빼면 다섯 번째 오답에
    #   가중치가 7.0 → 0.3(Codex 재리뷰 3차). 멈춘 뒤 새 문제를 익히면(같은 풀이에서 함께 끝나도)
    #   다시 다 익힌 개념: 멈춘 문제는 다시 풀 수 없어 늘 약하다고 보면 가중치가 내려가지 않음
    #   (/code-review). 시각은 mastered · stopped가 된 때(srs.endedAt, #113): 풀이가 무효가 되거나
    #   세트가 지워져도 바뀌지 않음. endedAt이 없는 예전 기록만 문제마다 마지막으로 푼 때, 풀이도
    #   없으면 가장 오래된 것으로 봄
    last: dict[str, datetime] = {}
    for a in attempts:
        for qid, _, void in a.answers:
            if not void and a.finished_at > last.get(qid, datetime.min):
                last[qid] = a.finished_at
    learned: dict[str, datetime] = {}  # 개념: 익힌 문제가 끝난 때(가장 나중)
    stopped: dict[str, datetime] = {}  # 개념: 멈춘 문제가 끝난 때(가장 나중)
    active: set[str] = set()
    page_of: dict[str, int] = {}
    for s in sets:
        for q in s.questions:
            st = q.get("srs")
            state = st.get("state") if st else None
            c = concept_of(q)
            unknown = state not in ("mastered", "active", "stopped")
            if unknown or c == OTHER or home(s, q)[0] != material_id:
                continue
            at = (st.get("endedAt") if st else None) or last.get(q["id"], datetime.min)
            if state == "active":
                active.add(c)
            else:
                when = learned if state == "mastered" else stopped
                when[c] = max(when.get(c, at), at)
            if state == "mastered":
                page_of.setdefault(c, home(s, q)[1])
    mastered = {
        c for c, at in learned.items() if c not in active and stopped.get(c, datetime.min) <= at
    }
    wrong: Counter[str] = Counter()
    for a in attempts:
        qset = by_id.get(a.quiz_set_id)
        if qset is None:
            continue
        qm = {q["id"]: q for q in qset.questions}
        for qid, correct, void in a.answers:
            hit = qm.get(qid)
            c = concept_of(hit) if hit else OTHER
            if (
                hit
                and c != OTHER
                and not void
                and judge(correct)
                and home(qset, hit)[0] == material_id
            ):
                page_of.setdefault(c, home(qset, hit)[1])
                wrong[c] += 1
    # 다 익힌 개념은 틀린 적이 없어도 셈(로컬은 틀린 답이 있는 개념만 봤음, /code-review 11/04)
    per_page: defaultdict[int, PageInfo] = defaultdict(PageInfo)
    for c in mastered:
        per_page[page_of[c]].mastered += 1
        per_page[page_of[c]].done.append(c)
    for c, n in wrong.items():
        if c not in mastered:
            per_page[page_of[c]].wrong += n
            per_page[page_of[c]].weak.append(c)
    return per_page


def allocate(
    pages: dict[int, str], per_page: defaultdict[int, PageInfo], n: int
) -> tuple[dict[int, float], dict[int, int], dict[int, int]]:
    """(가중치, 나눈 문제 수, 고르게 나눴을 때). 5줄 이상인 쪽만."""
    usable = [p for p, t in pages.items() if askable(t)]
    if not usable:
        return {}, {}, {}
    weight = {p: max(0.3, 1 + 1.5 * per_page[p].wrong - 0.7 * per_page[p].mastered) for p in usable}
    total = sum(weight.values())
    raw = {p: n * w / total for p, w in weight.items()}
    share = {p: int(v) for p, v in raw.items()}
    # 가중치가 같으면(새 노트는 모두 1) 쪽 순서가 아니라 흩어 놓은 순서로: 21쪽 노트의 10문제가
    # 앞 10쪽에 몰리지 않게
    spread = {p: (i * 0.618034) % 1 for i, p in enumerate(usable)}
    order = sorted(raw, key=lambda p: (-(raw[p] - share[p]), spread[p]))
    for p in order[: n - sum(share.values())]:
        share[p] += 1
    plain = {p: n // len(usable) + (1 if i < n % len(usable) else 0) for i, p in enumerate(usable)}
    # 다 익힌 개념이 있는 쪽은 한 문제로 다시 확인: 익힌 개념이 아주 빠지지 않게
    keep = [p for p in usable if per_page[p].mastered and share[p] == 0]
    if keep and n >= 6:
        p = max(keep, key=lambda p: per_page[p].mastered)

        # 뺄 쪽: 문제 수가 가장 많은 쪽 중 틀린 답 · 다 익힌 개념이 없는 쪽 → 틀린 답이 없는 쪽 →
        # 가중치가 작은 쪽 → 흩어 놓은 순서. 몫이 모두 0 · 1이면 쪽 순서로 골라 틀린 답이 있는 쪽이
        # 0문제가 됐음(/code-review #94)
        def give(k: int) -> tuple[int, bool, bool, float, float]:
            info = per_page[k]
            return share[k], not info.wrong, not info.mastered, -weight[k], spread[k]

        # 뺄 쪽이 한 문제뿐인데 틀린 답이나 다 익힌 개념이 있으면 다시 확인을 건너뜀: 아직 틀리는
        # 쪽이 0문제가 되거나, 다 익힌 쪽끼리 한 문제를 주고받기만 함(/code-review #94)
        k = max(share, key=give)
        if share[k] > 1 or not (per_page[k].wrong or per_page[k].mastered):
            share[k] -= 1
            share[p] = 1
    return weight, share, plain


# 한국어 용어 과목 쪽의 유형 순서(page_types). 부정설명 · 조합은 안정적 모드에서만
KO_ORDER = ("정의", "특징", "부정설명", "분류", "조합")


def page_types(text: str, korean_subject: bool, extra: tuple[str, ...] = ()) -> list[str]:
    """'(A) … is/are …ing' 사진 묘사 보기가 가득한 쪽은 장면 문제, 나머지는 유형을 돌림.

    '(A)' 줄 수만 세면 RC Part 5/6 쪽도 걸렸습니다(2일차 시험).
    extra(안정적 모드의 부정설명 · 조합)는 한국어 용어 과목 쪽에만: 둘 다 용어에 대한 한국어 설명
    문장을 묻는 유형입니다. 자리마다 · 판마다 유형을 이 순서로 돌리므로(levels.order_types) 어려운
    유형이 몰리지 않게 사이사이에 둡니다.
    """
    if len(_PHOTO.findall(text)) >= 3:
        return ["묘사", "어휘"]
    if korean_subject:
        return [t for t in KO_ORDER if t in ("정의", "특징", "분류") or t in extra]
    return ["빈칸", "어휘", "규칙"]


def is_korean_subject(pages: dict[int, str]) -> bool:
    """노트마다: 영어를 문장으로 쓰는 과목(어학)인지, 용어로만 쓰는지.

    영어 낱말 중 기능어 비율 — 토익 18~29%, 뇌파 5%, 미생 3%(10/22). 로마자 비율은 안 됨(미생은
    세균 · 검사 이름 때문에 57%). 영어 낱말이 적으면 비율이 우연이라: 기생충 원충류는 19개 중
    'in' · 'a' 2개(10.5%)로 토익 빈칸 유형을 받아 10문제 중 1문제만 만들었습니다(11/01). 영어 노트는
    기능어가 130개 넘고 나머지는 8개 이하였습니다.
    """
    words = [w.lower() for w in re.findall(r"[A-Za-z]+", " ".join(pages.values()))]
    func = sum(w in FUNC for w in words)
    return func < 20 or func / max(len(words), 1) < 0.10


# ---------------------------------------------------------------- hint · overlap


def _hint(info: PageInfo, used: list[str]) -> str:
    hint = ""
    if info.weak:
        hint += f"\n이 학생이 자주 틀린 개념(우선 다룬다): {', '.join(info.weak)}"
    if info.done:
        hint += f"\n이미 익힌 개념(피한다): {', '.join(info.done)}"
    if info.angle:
        asked = ", ".join(f"{c}({' · '.join(tys)})" for c, tys in info.angle.items())
        hint += (
            f"\n이 퀴즈에서 이미 물은 개념(물은 유형): {asked} — 고른다면"
            " 앞 문제와 다른 특징 · 다른 각도를 묻는다"
        )
    # 목록이 없으면 appeal to · budget · serving을 또 정답으로 냄(버린 초안 34개 중 7개, 10/29)
    if used:
        hint += f"\n이 퀴즈에서 이미 정답으로 쓴 것(정답으로 다시 쓰지 않는다): {', '.join(used)}"
    return hint


def _listed(m: Made) -> bool:
    """받은 문제의 정답을 '이미 쓴 정답'(used)에 넣을지(#268). 조합형 정답(ㄱ, ㄴ)은 묶음 이름이라
    겹쳐도 되고, 부정설명의 정답은 틀린 설명이라 다음 초안 지시(_hint)에 사실처럼 실리지 않게 뺌."""
    assert m.question is not None
    return not is_combo(m.question["options"]) and m.type != "부정설명"


def _seen_made(m: Made) -> Seen:
    """받은 문제를 겹침 검사(seen)에 더할 모양으로: 개념 · 만들게 한 유형을 붙임(#268)."""
    assert m.question is not None
    s = seen_draft(m.question)
    s["concept"] = m.concept or ""
    s["type"] = m.asked_as or m.type or ""
    return s


def _until(llm: Llm, stop: threading.Event) -> Llm:
    """stop이 켜진 뒤의 호출은 보내지 않고 LlmError(STOPPED).

    다 모았거나 돌려준 뒤에도 남은 자리 스레드는 검사 · 풀기 호출을 몇 번 더 하는데, 학교 LLM
    클라이언트는 프로세스에 하나라 그 호출이 다음 작업의 차례를 밀어냄(/code-review #95).
    이미 PacedLlm 안에서 차례를 기다리거나 다시 보내려는 호출도 stop_on으로 멈춤(Codex 리뷰
    #125). 보낸 뒤 응답을 기다리는 호출은 끝까지 기다림. 작업 취소와 같은 Stopping을 씀(#263).
    """
    return Stopping(llm, stop, STOPPED)


# ---------------------------------------------------------------- LLM: drafts, then one check


def _schema(names: list[str]) -> JsonObject:
    q = similar.Q_SCHEMA["properties"]["question"]
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["question"],
        "properties": {
            "question": {
                **q,
                "properties": {**q["properties"], "concept": {"type": "string", "enum": names}},
                "required": [*q["required"], "concept"],
            }
        },
    }


def draft_one(llm: Llm, slot: Slot, text: str, used: list[str], k: int) -> Made:
    """한 자리의 초안 1개: 생성 호출 1번(조합은 combo.build, 문장 판정까지). 코드 검사까지 하고,
    걸리면 why에 이유를 담아 돌려줍니다. 검사 모델 풀기는 판마다 한 번에(check_all).

    used는 이 세트에서 이미 쓴 정답, k는 자리 순번: 정답 자리를 A~E에 고르게 놓습니다(text.place).
    """
    out = Made(slot.page, slot.level, slot.type)
    ty = slot.type
    hint = _hint(slot.info, used)
    if ty == GROUP_TYPE and used:  # 정답은 용어가 아니라 그 용어의 분류(#282)
        hint += "\n분류 문제: 정답(분류 이름)이 이미 정답으로 쓴 것이 되는 용어는 고르지 않는다"
    concept: object
    if ty == "조합":
        b = combo.build(llm, slot.page, text, slot.names, hint, slot.notes, combo.truth_for())
        out.down, out.rejected = b.draft is None and b.down > 0 and not b.answered, b.rejected > 0
        if b.draft is None:
            out.why, out.fault = b.why, b.fault
            return out
        d, concept = b.draft, b.concept
    else:
        tip = similar.first_tip(ty)
        user = (
            f'<노트 쪽="{slot.page}">\n{text[:TEXT_CAP]}\n</노트>\n\n'
            f"개념 목록(이 안에서 고른다): {', '.join(slot.names)}{hint}\n"
            f"문제 유형: {ty} — {similar.TYPES[ty][0]}\npassage: {similar.TYPES[ty][1]}"
            f"{slot.notes}{chr(10) + tip if tip else ''}\n\n"
            f"이 노트로 {CHOICES}지선다 문제 1개를 만들어라. 난이도는 중·고등학교 내신 보통 "
            "수준."
        )
        try:
            r = llm.call(
                settings.quiz_gen_model,
                GEN_SYS,
                user,
                _schema(slot.names),
                "Quiz",
                max_tokens=1400,
                temperature=0.7,
            )
        except LlmError as e:
            out.down, out.rejected, out.why = True, isinstance(e, LlmRejectedError), [str(e)]
            return out
        raw = similar._draft(r)
        if raw is None:
            out.why = ["답 모양이 맞지 않음"]
            return out
        d = tidy(raw)
        q = r.get("question")
        concept = q.get("concept") if isinstance(q, dict) else None
    named = concept if isinstance(concept, str) else ""
    # 겹침은 여기서 보지 않음(seen · used 없이): 동시에 만든 초안끼리는 넣을 때 봄(_make_all)
    why, key = code_check(d, Target("new"), text, ty, [], named)
    if concept not in slot.names:  # 개념 목록이 길면 모델이 이 필드를 빠뜨리기도 함
        why.append("개념 이름 없음")
    if key is not None and not why:
        d = similar.answer_as_option(d, key)
        options, key = place(d["options"], key, k)
        d = {**d, "options": options}
        if not _shape_ok(d):  # 서버가 빼는 모양(#247): 빈 질문 · 답 · 보기
            why.append(BAD_SHAPE)
    if why or key is None:
        out.why, out.fault = why or ["정답 글이 보기와 안 맞음"], True
        return out
    out.question, out.concept, out.key = d, named, key
    out.type = "빈칸" if "____" in d["passage"] else ty
    return out


CHECK_SYS = (
    "너는 퀴즈 검수자다. 문제마다 그 문제에 적힌 쪽의 노트만 근거로 직접 푼다. 문제마다 따로 "
    "판단해 정답 기호, 정답이 하나뿐인지, 노트만으로 답을 확정할 수 있는지 답한다. results에 "
    "문제 순서대로 넣는다. JSON으로만 답한다."
)
Verdict = Literal["pass", "unsure", "wrong", "bad"]


def check_all(
    llm: Llm, made: list[Made], pages: dict[int, str], end: float | Callable[[], float] = math.inf
) -> list[tuple[Verdict, str]]:
    """초안들을 검사 모델이 한 호출로 풂(#512). 초안마다 (판정, 고른 답 또는 이유).

    pass    정답을 골랐고 정답이 하나뿐 · 노트로 정해짐
    unsure  정답을 골랐지만 정답이 하나뿐이 아니거나 노트로 정해지지 않음
    wrong   다른 답 · '없음'을 고름(정답이 틀렸을 수 있음)
    bad     그 문제의 답 모양이 틀림
    문제마다 따로 묻던 정답 둘 검사(quality.screen) · 검사 모델 풀기(similar.solved) · 생성 모델
    2차 풀기를 이 한 호출의 '정답이 하나뿐인지'로 대신합니다. 쪽 글은 쪽마다 한 번만 보여 줍니다.
    초안이 많거나 쪽 글이 길면 CHECK_BATCH문제 · 쪽 글 CHECK_CHARS자씩 나눠 묻습니다(30문제 · 21쪽
    노트를 한 호출에 넣으면 학교 LLM 문맥을 넘음, /code-review #512).
    호출이 실패하거나 답 전체의 모양이 틀리면 한 번 더 보냄. 다시 실패한 묶음은 모두 bad(다른
    묶음의 결과는 그대로, Codex 리뷰 #513). 모든 묶음의 호출이 실패하면 LlmError를 올림: 모두
    서버가 거절했을 때만 LlmRejectedError(다시 시도 없음), 일시 장애가 섞이면 다시 시도되는
    오류(Codex 재리뷰 #513). 거절은 다시 보내지 않음.
    end(_clock 값)를 넘기면 그 묶음은 기다리지 않고 시간 상한 장애로 셈(남은 호출은 보내지 않음).
    end가 함수면 대기 중에도 1초마다 다시 읽어 사용자 이어받기의 짧아진 상한을 반영함.
    """
    groups: list[list[Made]] = []
    for m in made:
        group = groups[-1] if groups else []
        chars = sum(len(pages[p][:CHECK_CAP]) for p in {x.page for x in [*group, m]})
        if not group or len(group) >= CHECK_BATCH or chars > CHECK_CHARS:
            groups.append([m])
        else:
            group.append(m)
    out: list[tuple[Verdict, str]] = []
    errors: list[LlmError] = []
    stop = threading.Event()

    def remaining() -> float:
        return (end() if callable(end) else end) - _clock()

    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="quiz-check")
    try:
        for group in groups:
            try:
                if remaining() <= 0:
                    raise LlmError(TIMEOUT)
                f = pool.submit(_check_group, _until(llm, stop), group, pages)
                while not f.done() and (left := remaining()) > 0:
                    wait([f], timeout=min(1.0, left))
                if not f.done():
                    stop.set()  # 끊은 묶음은 다시 보내지 않음
                    raise LlmError(TIMEOUT)
                out += f.result()
            except LlmError as e:
                errors.append(e)
                out += [("bad", f"{UNCHECKED}({e})")] * len(group)
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    if groups and len(errors) == len(groups):
        if all(isinstance(e, LlmRejectedError) for e in errors):
            raise errors[0]
        raise next(e for e in errors if not isinstance(e, LlmRejectedError))
    return out


def _check_group(llm: Llm, made: list[Made], pages: dict[int, str]) -> list[tuple[Verdict, str]]:
    """check_all의 한 호출."""
    notes = "\n\n".join(
        f'<노트 쪽="{p}">\n{pages[p][:CHECK_CAP]}\n</노트>' for p in sorted({m.page for m in made})
    )
    shown = []
    for i, m in enumerate(made, 1):
        d = m.question
        assert d is not None
        body = d["stem"] + (f"\n{d['passage']}" if d["passage"] else "")
        shown.append(
            f"문제 {i} (노트 쪽 {m.page})\n{body}\n"
            + "\n".join(f"{LETTERS[j]}. {o}" for j, o in enumerate(d["options"]))
        )
    schema: JsonObject = {
        "type": "object",
        "additionalProperties": False,
        "required": ["results"],
        "properties": {
            "results": {
                "type": "array",
                "minItems": len(made),
                "maxItems": len(made),
                "items": similar.CHK_SCHEMA,
            }
        },
    }
    user = f"{notes}\n\n" + "\n\n".join(shown)
    rows: list[Any] | None = None
    for again in (False, True):
        try:
            r = llm.call(
                settings.quiz_check_model,
                CHECK_SYS,
                user,
                schema,
                CHECK_NAME,
                max_tokens=100 + 60 * len(made),
            )
        except LlmRejectedError:
            raise
        except LlmError:
            if again:
                raise
            continue
        v = r.get("results")
        if isinstance(v, list) and len(v) == len(made):
            rows = v
            break
    if rows is None:
        return [("bad", UNCHECKED)] * len(made)
    out: list[tuple[Verdict, str]] = []
    for m, row in zip(made, rows, strict=True):
        said = row.get("answer") if isinstance(row, dict) else None
        one = row.get("only_one") if isinstance(row, dict) else None
        sure = row.get("supported") if isinstance(row, dict) else None
        if (
            said not in similar.CHK_ANSWERS
            or not isinstance(one, bool)
            or not isinstance(sure, bool)
        ):
            out.append(("bad", UNCHECKED))
        elif m.key is not None and said == LETTERS[m.key]:
            out.append(("pass" if one and sure else "unsure", str(said)))
        else:  # 다른 답 · '없음': 정답이 틀렸을 수 있어 남겨 두지도 않음
            out.append(("wrong", str(said)))
    return out


def _draft_all(
    llm: Llm,
    slots: list[Slot],
    pages: dict[int, str],
    used: list[str],
    base: int,
    need: int,
    end: float,
    pool: ThreadPoolExecutor,
    limit: Callable[[], float] | None = None,
) -> list[Made]:
    """자리마다 초안 1개를 동시에(pool의 WORKERS개씩).

    pool은 판끼리 함께 씀: 지난 판에 남아 응답을 기다리는 호출도 WORKERS 안에 들어, 동시 생성
    호출이 판 수만큼 늘지 않게(Codex 재리뷰 #513, #247과 같음).
    시간 상한(Codex 리뷰 #513): 판은 end(_clock 값)까지, 초안 need개(여분 뺀 자리 수)가 나온 뒤에는
    SPARE_WAIT_SEC초까지만 더 기다림. 학교 LLM은 호출 하나가 180초 · 다시 보내기 2번까지 걸려,
    여분 초안 하나가 멈춰도 나머지 검사가 몇 분 밀렸음. 끝나지 않은 자리는 TIMEOUT(응답 없음으로
    셈)이고, 그 자리의 남은 호출은 멈춤 신호로 보내지 않음(_until).
    LlmError가 아닌 오류(학교 LLM 설정 오류 · 코드 오류)는 남은 자리를 멈추고 그대로 올림: 남은
    자리도 같으므로(#262 · Codex 리뷰 #264).
    """
    if not slots:
        return []
    stop = threading.Event()
    until = _until(llm, stop)
    futures: list[Future[Made]] = []

    def guarded(s: Slot, k: int) -> Made:
        """설정 · 코드 오류는 그 자리에서 바로 멈춤 신호를 켬: 주 스레드가 알아채기 전에 기다리던
        다음 자리가 호출하지 않게(Codex 재리뷰 #513, 예전 guarded와 같음)."""
        try:
            return draft_one(until, s, pages[s.page], list(used), k)
        except LlmError:
            raise
        except BaseException:
            stop.set()
            raise

    try:
        futures += [pool.submit(guarded, s, base + i) for i, s in enumerate(slots)]
        pending = set(futures)
        while pending:
            if limit is not None:
                end = min(end, limit())
            left = end - _clock()
            if left <= 0:
                break
            done, pending = wait(pending, timeout=min(1.0, left), return_when=FIRST_COMPLETED)
            for f in done:
                if (e := f.exception()) is not None and not isinstance(e, LlmError):
                    raise e
            made = sum(1 for f in futures if f.done() and not f.exception() and f.result().question)
            if made >= need:
                end = min(end, _clock() + SPARE_WAIT_SEC)
        out = []
        for f, s in zip(futures, slots, strict=True):
            if f.done() and f.exception() is None:
                out.append(f.result())
            else:
                why = str(f.exception()) if f.done() else TIMEOUT
                out.append(Made(s.page, s.level, s.type, why=[why], down=True))
        return out
    finally:
        # 끊긴 자리는 다음 호출을 보내지 않고, 시작하지 않은 자리는 취소
        stop.set()
        for f in futures:
            f.cancel()


# ---------------------------------------------------------------- run


def _concept_names(llm: Llm, m: Material, pages: dict[int, str]) -> list[str]:
    """노트에 개념 이름이 없을 때: 쪽마다 뽑고(concepts.for_page), 노트 조각의 auto 태그를 앞에.

    쪽마다 동시에 뽑습니다. 한 쪽에 20~63초(11/05 학교 LLM, 버린 이름을 다시 물으면 길어짐)라
    차례로 뽑으면 쪽 수만큼 퀴즈 요청이 길어졌음(#95). 합치는 순서는 쪽 순서 그대로.
    """
    subject = concepts.subject_words(m.title)
    texts = [t for _, t in sorted(pages.items()) if askable(t)]
    names: list[str] = []
    # 한 쪽이 LlmError면 작업 처리기가 다시 시도하므로 다른 쪽도 더 호출하지 않음: 시작하지 않은
    # 쪽은 취소하고, 도는 쪽은 다음 호출에서 멈춤(_until). 끝나는 차례로 기다려 앞쪽이 느려도
    # 뒤쪽 실패를 바로 알아챔(쪽 순서로 기다리면 앞쪽이 끝날 때까지 호출이 이어짐, Codex #125)
    failed = threading.Event()
    until = _until(llm, failed)
    pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="concepts")
    try:
        futures = [pool.submit(concepts.for_page, until, t, m.title) for t in texts]
        done, _ = wait(futures, return_when=FIRST_EXCEPTION)  # 모두 끝나거나 하나가 실패할 때까지
        for f in futures:  # 기다림을 끝낸 실패(그 뒤에 끝난 쪽이 아니라)
            if f in done and (e := f.exception()) is not None:
                raise e
        found = [f.result()[0] for f in futures]
    except BaseException:
        failed.set()
        raise
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    for good in found:
        names = concepts.dedupe(names + good, subject)
    tags = [c.concept for c in m.chunks if c.concept]
    return concepts.dedupe(tags + names, subject) if tags else names


def run(
    llm: Llm,
    raw: JsonObject,
    report: Progress,
    *,
    mode: Mode = FAST,
    hurry: Callable[[], bool] | None = None,
) -> JsonObject:
    """quiz_generate(빠름) · quiz_pregen(안정적) 작업 하나(#274).

    hurry() → 사용자가 이 작업을 이어받았는지(report.awaited). 참이 되면 다음 판부터 빠른 모드
    유형으로 만듭니다(이미 만든 문제는 그대로).
    """
    t0 = time.monotonic()
    inp = parse(raw)
    m = inp.material
    n = inp.size
    pages = note_pages(m)
    notes: Notes = {**inp.notes, m.id: pages}
    title = f"{m.title} 맞춤 퀴즈 · {inp.day:%m-%d}"
    # 글이 없는 노트(사진만 · 모든 줄이 [?]) · 짧은 쪽뿐인 노트(allocate가 묻지 않음)
    if not any(askable(t) for t in pages.values()):
        raise InputError(NO_TEXT)

    new_names = None
    names_all = m.concepts
    if not names_all:
        names_all = new_names = _concept_names(llm, m, pages)
        report(10, "개념 이름 뽑기")

    where: dict[str, tuple[str, int]] = {}
    per_page = history(inp.sets, inp.attempts, m.id, notes, where)
    korean = is_korean_subject(pages)
    weight, share, plain = allocate(pages, per_page, n)
    report(15, "쪽마다 문제 수 나누기")

    # 겹침 검사는 이 노트 세트의 문제와, 다른 세트에서 낱말로 이 노트에 놓이는 문제(여러 노트를
    # 섞는 오늘의 복습 세트 · /code-review #94). 자리는 history가 담아 둔 where를 다시 씀. 다른 노트
    # 문제까지 넣으면 passage 없는 '다음 중 요충의 특징은?'에 회충 문제가 '거의 같음'으로 걸림
    def here(s: QuizSet, q: Question) -> bool:
        if s.material_id == m.id:
            return True
        if q["id"] not in where:
            where[q["id"]] = locate(q, notes, s.material_id)
        return where[q["id"]][0] == m.id

    seen: list[Seen] = [seen_question(q) for s in inp.sets for q in s.questions if here(s, q)]
    subject = concepts.subject_words(m.title)
    # 난이도(#268): 유형 난이도는 모든 사용자의 정답률로 고치고, 세트 비율은 이 사용자의 난이도별
    # 정답률로 정함(levels.py)
    lv = levels.type_levels(inp.type_stats)
    user = levels.level_stats(
        {q["id"]: q for s in inp.sets for q in s.questions},
        (x for a in inp.attempts for x in a.answers),
        lv,
    )
    # 쓸 수 있는 난이도: 이 노트의 쪽 유형에 있는 난이도(빠른 모드의 용어 과목은 하 · 중뿐)
    usable = {
        lv[t]
        for text in pages.values()
        if askable(text)
        for t in page_types(text, korean, mode.extra)
        if t in lv
    }
    mix = levels.level_mix(n, usable, user)
    made, failed = _make_all(
        llm, pages, names_all, subject, per_page, weight, share, korean, seen, n, report,
        mode, hurry, mix, lv,
    )  # fmt: skip
    log.info("맞춤 퀴즈(%s): %d/%d문제, %.0f초", mode.name, len(made), n, time.monotonic() - t0)
    if len(made) < n:  # 모자란 세트는 돌려주지 않음(앱은 작업 상태로 성공 화면을 고름, #247)
        # 자리마다 이유가 다를 수 있어 모두 담음(겹치면 한 번)
        why = "; ".join(list(dict.fromkeys(w for f in failed for w in f["why"]))[:WHY_SHOWN])
        got = f"{len(made)}/{n}문제만 만듦" if made else "만든 문제가 없음"
        raise NoQuestionsError(f"{got}({why})" if why else got)
    qs = [
        {
            "id": new_id(),
            "order": i,
            "type": r.type,
            "prompt": r.question["stem"],
            "passage": r.question["passage"] or None,
            "choices": r.question["options"],
            "answer": r.question["answer"],
            "explanation": r.question.get("explanation"),
            "conceptTags": [r.concept],
            # 유형으로 정하고 모든 사용자의 정답률로 고친 난이도(#268). 모델이 붙인 difficulty는
            # 쓰지 않음(실험 1)
            "difficulty": lv.get(r.type or "") or similar.difficulty_of(r.type),
            "srs": None,
        }
        for i, r in enumerate(made, 1)
        if r.question is not None
    ]
    out = _result(qs, title, new_names, weight, share, plain, per_page, [])
    # 앱 안내 · 확인용: 목표 비율, 약한 난이도, 이 사용자의 난이도별 (푼 수, 틀린 수)
    out["levels"] = {
        "target": mix,
        "weak": levels.weak_level(user, usable),
        "user": {k: [t.answered, t.count] for k, t in user.items()},
    }
    return out


def _shape_ok(d: Draft) -> bool:
    """세트에 넣을 수 있는 모양인지(#247). 서버 검사(apps/api quiz-sets.service.ts
    fromWorkerQuestion: 질문 · 답이 글, 보기는 글 배열)보다 좁게 봄: 빈 질문 · 빈 답 · 빈 보기도
    빼고, 앱은 보기 중 하나를 고르므로 보기 CHOICES개 안에 정답이 있어야 함. draft_one이 검사
    호출 전에 거름."""
    stem, answer, options = d.get("stem"), d.get("answer"), d.get("options")
    return (
        isinstance(stem, str)
        and bool(stem.strip())
        and isinstance(answer, str)
        and bool(answer.strip())
        and isinstance(options, list)
        and len(options) == CHOICES
        and all(isinstance(o, str) and o.strip() for o in options)
        and answer in options
    )


def _make_all(
    llm: Llm,
    pages: dict[int, str],
    names_all: list[str],
    subject: set[str],
    per_page: defaultdict[int, PageInfo],
    weight: dict[int, float],
    share: dict[int, int],
    korean: bool,
    seen: list[Seen],
    n: int,
    report: Progress,
    mode: Mode = FAST,
    hurry: Callable[[], bool] | None = None,
    mix: dict[str, int] | None = None,
    lv: dict[str, str] | None = None,
) -> tuple[list[Made], list[JsonObject]]:
    """판마다 초안을 모두 만든 뒤 한 번에 검사해 (세트 문제(세트 순서), 못 만든 자리) (#512).

    순서는 모듈 설명의 '만들기' 1~5. 못 만든 자리는 다 채우면 []이고, 모자라면 run이 오류 글에
    이유를 담음. 쪽에 물을 개념(한 개념 PER_CONCEPT문제까지)이 남지 않으면 무거운 쪽부터 다른 쪽을
    쓰고, 어느 쪽에도 없으면 이미 물은 개념도 다른 유형 · 다른 각도로 묻게 합니다(#268).
    난이도(#268): mix는 난이도마다 목표 문제 수, lv는 유형마다 난이도(levels.py). 자리마다 난이도를
    정해 그 난이도의 유형으로 만들고(levels.order_types), 다음 판은 모자란 난이도부터 채웁니다.
    통과한 초안이 남으면 모자란 난이도의 초안부터 넣습니다.
    """
    lv = lv or dict(similar.DIFFICULTY)
    target = levels.slot_levels(mix or {}) or ["중"]  # 자리마다 난이도(첫 판의 차례)
    taken: list[Made] = []  # 세트에 넣은 차례대로
    kept: list[Made] = []  # 검사를 통과했지만 겹침 때문에 남겨 둔 초안
    failed: list[Made] = []  # 못 채운 자리(오류 글, 마지막 판 먼저)
    used: list[str] = []  # 이 세트에서 쓴 정답(다음 판 초안 지시)
    asked: Counter[str] = Counter()  # 세트에서 개념마다 물은 수
    asked_as: defaultdict[str, list[str]] = defaultdict(list)  # 개념마다 물은 유형
    # 같은 난이도의 유형 돌리기: 빠른 모드는 (쪽, 난이도)마다, 안정적 모드는 난이도마다 세트
    # 전체에서(#268 · Codex 리뷰 #300)
    visits: Counter[tuple[int, str]] = Counter()
    turns: Counter[str] = Counter()
    backups = sorted(weight, key=lambda p: -weight[p])  # 여분 자리 · 개념이 바닥난 자리가 갈 쪽
    cur = mode

    def levels_for(count: int, order: list[str]) -> list[str]:
        return [order[i % len(order)] for i in range(count)] if order else ["중"] * count

    def lacking() -> list[str]:
        """목표보다 모자란 난이도부터(그다음 첫 판 차례)."""
        got = Counter(lv.get(r.type or "", "중") for r in taken)
        short = {k: c - got[k] for k, c in (mix or {}).items() if c > got[k]}
        return levels.slot_levels(short) + target

    def open_names(page: int) -> list[str]:
        """그 쪽에서 아직 PER_CONCEPT문제 안 된 개념."""
        names = concepts.for_text(names_all, pages[page], subject)
        return [c for c in names if asked[c] < PER_CONCEPT]

    def plan(want: list[tuple[int, str, str]]) -> list[Slot]:
        """(쪽, 난이도, 앞 초안의 문제점)마다 자리. 한 쪽의 자리들은 그 쪽 개념을 나눠 받아 동시에
        만든 초안이 같은 개념으로 몰리지 않게 함(모델은 받은 목록 안에서 고름)."""
        homes = []
        for p, level, notes in want:
            page = next((b for b in [p, *backups] if open_names(b)), p)
            homes.append((page, level, notes))
        count = Counter(page for page, _, _ in homes)
        nth: Counter[int] = Counter()
        slots = []
        for page, level, notes in homes:
            names = open_names(page) or concepts.for_text(names_all, pages[page], subject)
            j = nth[page]
            nth[page] += 1
            mine = names[j :: count[page]] or names
            types = page_types(pages[page], korean, cur.extra)
            turn = turns[level] if cur.extra else visits[page, level]
            ty = levels.order_types(types, level, lv, turn)[0]
            visits[page, level] += 1
            turns[level] += 1
            info = per_page[page]
            if again := {c: list(asked_as[c]) for c in mine if c in asked}:
                info = replace(info, angle=again)
            slots.append(Slot(page, level, ty, mine, info, notes))
        return slots

    seen_now = list(seen)  # 겹침 검사: 이미 있는 문제 + 세트에 넣은 문제(admit이 더함)

    def overlap(r: Made) -> str | None:
        """이미 넣은 문제와의 겹침: 거의 같음(버림) · 같은 정답과 유형 · 개념 수(남겨 둠)."""
        d = r.question
        assert d is not None and r.concept is not None
        if too_close(d, seen_now, r.concept, r.asked_as):
            return NEAR_SAME
        if asked[r.concept] >= PER_CONCEPT:
            return CONCEPT_FULL
        if _listed(r) and any(
            x.asked_as == r.asked_as and _listed(x) and same_item(d["answer"], x.question["answer"])
            for x in taken
            if x.question is not None
        ):
            return SAME_TYPE_ANSWER
        return None

    def admit(r: Made) -> None:
        assert r.question is not None and r.concept is not None
        asked[r.concept] += 1
        asked_as[r.concept].append(r.asked_as)
        if _listed(r):
            used.append(r.question["answer"])
        seen_now.append(_seen_made(r))
        taken.append(r)

    first = [p for p in sorted(share, key=lambda p: -share[p]) for _ in range(share[p])]
    want = [(p, lv_, "") for p, lv_ in zip(first, levels_for(len(first), target), strict=True)]
    want += [(p, lv_, "") for p, lv_ in zip(*_spares(n, backups, target), strict=True)]
    need = len(first)  # 이번 판에 채울 자리(여분 제외)
    deadline = _clock() + TOTAL_SEC * mode.patience
    round_end = math.inf

    def refresh_deadline() -> float:
        nonlocal cur, deadline, round_end
        if cur is not FAST and hurry is not None and hurry():
            now = _clock()
            cur = FAST
            # 사용자가 이어받은 뒤에는 이미 진행 중인 판 · 검사도 사용자 대기 상한으로 줄임.
            # 기존 상한이 더 가까우면 늘리지 않는다.
            deadline = min(deadline, now + TOTAL_SEC)
            round_end = min(round_end, now + ROUND_SEC)
            log.info("맞춤 퀴즈: 이어받아 빠른 모드로(%d/%d문제)", len(taken), n)
        return deadline

    def draft_deadline() -> float:
        return min(refresh_deadline(), round_end)

    pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="quiz-draft")
    try:
        for rnd in range(ROUNDS):
            refresh_deadline()
            if rnd and _clock() >= deadline:  # 둘째 판을 띄울 시간이 없음: 남겨 둔 초안으로
                break
            round_end = min(_clock() + ROUND_SEC * cur.patience, deadline)
            made = _draft_all(
                llm, plan(want), pages, used, len(taken), need, round_end, pool, draft_deadline
            )
            report(15 + (45 if rnd == 0 else 70), "문제 만들기")
            if rnd == 0 and made and all(r.down for r in made):  # 학교 LLM 장애: 작업 처리기에 맡김
                if all(r.rejected for r in made):  # 모두 서버가 거절: 다시 해도 같음(Codex #264)
                    raise LlmRejectedError("문제 만들기 요청을 모두 거절함")
                raise LlmError("문제 만들기 호출이 모두 실패함")
            missed: list[Made] = [r for r in made if r.question is None]
            ready = []
            for r in made:
                if r.question is None:
                    continue
                if too_close(r.question, seen_now, r.concept or "", r.asked_as):
                    r.why, r.fault = [NEAR_SAME], True
                    missed.append(r)
                else:
                    ready.append(r)
            try:
                verdicts = check_all(llm, ready, pages, refresh_deadline)
            except LlmError:
                if rnd == 0 or not (taken or kept):
                    raise
                # 문제를 받은 뒤의 장애: 받은 · 남겨 둔 문제를 버리고 처음부터 다시 돌리지 않게
                # 남겨 둔 초안으로 채움(/code-review #512)
                verdicts = [("bad", UNCHECKED)] * len(ready)
            report(15 + (55 if rnd == 0 else 80), "문제 검사")
            passed = []
            for r, (v, said) in zip(ready, verdicts, strict=True):
                if v == "pass":
                    passed.append(r)
                    continue
                r.why = (
                    [NOT_SURE]
                    if v == "unsure"
                    else [UNCHECKED]
                    if v == "bad"
                    else [f"검사 탈락(검수자 답 {said})"]
                )
                r.fault = v != "bad"
                missed.append(r)
            # 목표보다 모자란 난이도의 초안부터: 넣을 때마다 다시 봄(한 난이도가 남은 자리를 다
            # 차지하지 않게, /code-review #512)
            while passed and len(taken) < n:
                got = Counter(lv.get(x.type or "", "중") for x in taken)
                short = {k for k, c in (mix or {}).items() if got[k] < c}
                r = next((x for x in passed if lv.get(x.type or "", "중") in short), passed[0])
                passed.remove(r)
                if why := overlap(r):
                    r.why, r.fault = [why], True
                    if why != NEAR_SAME:
                        kept.append(r)
                    missed.append(r)
                else:
                    admit(r)
            failed[:0] = missed
            missing = need = n - len(taken)
            if missing <= 0:
                break
            # 다음 판: 못 채운 자리만(앞 초안의 문제점을 알려 줌, 장애 · 모양 오류는 빼고) + 여분
            redo = [r for r in missed if r.fault] + [r for r in missed if not r.fault]
            redo = redo[:missing] or [Made(p, "중", "") for p in backups[:missing]]
            levels_now = levels_for(missing, lacking())
            want = [
                (r.page, levels_now[i % missing], _notes(r) if r.fault else "")
                for i, r in enumerate(redo)
            ]
            want += [
                (backups[(i + 1) % len(backups)], levels_now[i % missing], "")
                for i in range(missing - len(want))
            ]
            want += [
                (p, lv_, "") for p, lv_ in zip(*_spares(missing, backups, lacking()), strict=True)
            ]
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
    # 모자라면 검사를 통과한 겹침 초안으로만 채움. 애매하거나 거의 같은 문제는 뺌
    for r in kept:
        if len(taken) >= n:
            break
        assert r.question is not None and r.concept is not None
        if not too_close(r.question, seen_now, r.concept, r.asked_as):
            admit(r)
    if len(taken) >= n:
        report(100, "문제 만들기")
    for i, r in enumerate(taken):  # 정답 자리는 세트 안 순서로(여분 자리 번호로 두면 몰림)
        q = r.question
        assert q is not None
        options, _ = place(q["options"], q["options"].index(q["answer"]), i)
        r.question = {**q, "options": options}
    # 남겨 둔 초안으로 채운 자리는 못 만든 자리가 아님
    left = [r for r in failed if all(r is not x for x in taken)]
    return taken, ([{"pageNo": r.page, "why": r.why} for r in left] if len(taken) < n else [])


def _spares(missing: int, backups: list[int], order: list[str]) -> tuple[list[int], list[str]]:
    """여분 자리(모자란 수 × SPARE, 올림): 가장 무거운 쪽부터, 난이도는 order 차례로."""
    k = math.ceil(missing * SPARE) if backups else 0
    lv_ = [order[i % len(order)] for i in range(k)] if order else ["중"] * k
    return [backups[i % len(backups)] for i in range(k)], lv_


def _notes(r: Made) -> str:
    """다음 판 초안 지시에 넣는 앞 초안의 문제점."""
    return f"\n앞서 만든 문제의 문제점: {'; '.join(r.why)} — 다른 문장으로 새로 만든다. "


def _result(
    qs: list[Any],
    title: str,
    new_names: list[str] | None,
    weight: dict[int, float],
    share: dict[int, int],
    plain: dict[int, int],
    per_page: defaultdict[int, PageInfo],
    failed: list[JsonObject],
) -> JsonObject:
    return {
        "questions": qs,
        "title": title,
        "concepts": new_names,
        "pages": [
            {
                "pageNo": p,
                "weight": round(weight[p], 2),
                "plain": plain[p],
                "share": share[p],
                "wrong": per_page[p].wrong,
                "mastered": per_page[p].mastered,
            }
            for p in sorted(weight)
        ],
        "failed": failed,
    }
