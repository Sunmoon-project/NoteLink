"""맞춤 퀴즈: 노트로 새 퀴즈 한 세트. 이 사용자가 아직 틀리는 쪽을 더 묻습니다 (로컬 quiz_gen.py).

ai_jobs.type = 'quiz_generate' (공용 계약 AiJobType).
ai_jobs.type = 'quiz_pregen': 노트를 만들 때 NestJS가 넣는 첫 맞춤 퀴즈 미리 만들기(#134). input ·
  result는 quiz_generate와 같고, 처리기는 사용자가 기다리는 작업이 없을 때만 가져갑니다
  (worker/jobs.py). 새 노트는 개념 뽑기가 더해져 3분 가까이 걸려서 미리 만들어 둡니다.

  코드  쪽마다 문제 수 나누기 · 과목 판단(영어 문장 과목 / 용어 과목) · 쪽마다 유형 돌리기 ·
        세트 안에서 개념 · 정답 겹치지 않게 · 못 만든 자리는 다른 쪽으로 넘기기
  LLM   문제 1개씩 만들기(생성 모델) → 코드 검사(checks.code_check) → '정답 둘' 검사
        (quality.screen) → 검사 모델이 노트만 보고 풀어 정답 자리까지 맞아야 채택(similar.solved).
        개념 이름이 없는 노트는 쪽마다 이름을 뽑습니다(concepts.for_page, 쪽마다 동시에)

시간(#95): 앱이 퀴즈를 빨리 받아야 해서 5문제를 2분 안에 만듭니다. 차례로 만들면 10문제에
  11~12분, 5문제에 7분이 걸렸습니다(11/05 학교 LLM).
  - 자리(문제 수만큼)와 여분 자리(문제 수 × EXTRA)를 WORKERS개씩 동시에 만들고, 먼저 통과한 n개를
    씁니다. 학교 LLM은 동시 요청을 받고, 호출 간격은 SchoolLlm이 지킵니다
  - 통과한 문제는 받아들일 때(accept) 잠금 안에서 그사이 다른 자리가 받은 문제와 개념 · 정답 ·
    문장 겹침을 다시 봅니다
  - 새 초안은 SEC_PER_QUESTION × n초 안에만 시작하고, HARD_SEC_PER_QUESTION × n초에는 그 판을
    끝냅니다(아직 도는 자리는 다음 단계에서 멈춤). 개념 뽑기 시간은 넣지 않습니다
  - n개가 안 되면 통과한 문제는 둔 채 모자란 자리만 다음 판에 다시 돌립니다(MAX_ROUNDS판 ·
    FILL_SEC_PER_QUESTION × n초까지, #247). 열린 쪽이 없으면 마지막 단계로 이미 물은 개념도 다른
    각도로 묻습니다. 그래도 모자라면 짧은 세트 대신 NoQuestionsError(앱은 '다시 시도')
  - 11/05 학교 LLM 5문제: 미생 85초 5/5 · 토익 1일차 109초 5/5 · 기생충 1 110초 4/5(차례로 만들 때
    미생 10문제 714초). 1분에 보낸 호출은 많아야 28번
  알려진 한계: 개념 이름이 없는 새 노트는 첫 퀴즈에서 개념 뽑기(쪽마다 동시에, 미생 7쪽 87초 ·
  기생충 1 3쪽 70초)가 더해져 171~199초. 뽑은 이름은 result.concepts로 노트에 저장되어 다음
  퀴즈부터는 뽑지 않습니다

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

result — NestJS가 quiz_sets에 새 세트로 저장합니다(materialId · folderId는 노트에서)
  questions  새 세트 문제(order 1부터, srs는 null: 아직 풀지 않음). 늘 size개
  title      '<노트 제목> 맞춤 퀴즈 · MM-DD'
  concepts   새로 뽑은 개념 이름(materials.concepts에 저장). 노트에 이름이 있었으면 null
  pages      [{pageNo, weight, plain, share, wrong, mastered}] 쪽마다 배분(앱 안내 · 확인용).
             plain은 기록 없이 고르게 나눴을 때, share는 실제로 나눈 문제 수
  failed     [{pageNo, why}] 못 만든 자리(마지막으로 시도한 쪽과 탈락 이유). 다 채우므로 늘 []

size개를 다 만들지 못하면 짧은 결과로 끝내지 않습니다(앱은 작업 상태로 성공 화면을 고름,
#175 · #247).
  - 물을 글이 없음: 글이 없거나 MIN_LINES줄 이상인 쪽이 없음. LLM을 부르기 전에 InputError
    (바로 실패)
  - LLM 장애: 한 문제도 못 만들었고 마지막 판의 생성 호출이 모두 실패함(응답 없음 포함). LlmError로
    작업 처리기가 나중에 다시 시도. 문제를 만든 뒤의 장애는 받은 문제를 버리고 처음부터 다시 돌리지
    않게 아래 NoQuestionsError로
  - 그 밖(초안이 탈락 · 물을 개념이 모자람 · 시간 상한): NoQuestionsError(바로 실패, 코드
    NO_QUESTIONS, 'k/n문제만 만듦(이유)'). 모자란 자리는 이미 판을 나눠 다시 돌렸으므로 작업을
    다시 시도하면 기다림만 몇 배로 길어짐(미리 만들기는 상한이 PATIENT배). 다시 할지는 앱의
    '다시 시도'에 맡김
'정답 둘' 검사나 검사 모델 호출이 실패한 초안은 쓰지 않습니다.
오답 보기 한두 개만 걸린 초안은 그 보기만 바꿔 다시 검사합니다(quality.checked, 로컬과 같음, #95).
알려진 한계(로컬과 같음): 새 문제의 srs는 null이라, 처음 푼 뒤 복습 상태에 checked가 없어 오늘의
복습이 '정답 둘' 검사를 한 번 더 합니다.
"""

import re
import threading
import time
from collections import Counter, defaultdict
from collections.abc import Callable
from concurrent.futures import FIRST_COMPLETED, FIRST_EXCEPTION, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass, field, replace
from datetime import date, datetime
from typing import Any

from app.clients.llm import (
    STOPPED,
    JsonObject,
    Llm,
    LlmError,
    LlmRejectedError,
    Stopping,
)
from app.core.config import settings
from app.services.quiz import concepts, quality, similar
from app.services.quiz.checks import (
    Seen,
    Target,
    code_check,
    reversed_of,
    seen_draft,
    seen_question,
    too_close,
)
from app.services.quiz.models import CHOICES, Draft, Notes, Page, Question
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
from app.services.quiz.text import clean_pages, locate, norm, place, same_item, tidy

TYPE = "quiz_generate"
PREGEN_TYPE = "quiz_pregen"
SET_SIZE = 10
MAX_SIZE = (
    30  # 한 자리에 LLM 호출이 최대 3쪽 × 2번 × (생성 · 검사 · 풀기): 학교 LLM 하나를 오래 잡지 않게
)
MIN_LINES = 5  # 이보다 짧은 쪽은 묻지 않음
NO_TEXT = f"노트에 문제를 낼 글이 없음({MIN_LINES}줄 이상인 쪽 없음)"


def askable(text: str) -> bool:
    """문제를 낼 수 있는 쪽 글인지(정리한 글이 MIN_LINES줄 이상). NestJS askable과 같은 기준."""
    return len(text.split("\n")) >= MIN_LINES


class NoQuestionsError(InputError):
    """물을 글은 있는데 한 문제도 만들지 못함. 작업은 다시 시도하지 않고 code로 실패합니다."""

    code = "NO_QUESTIONS"


TEXT_CAP = 2500  # 생성 모델에 보여 주는 쪽 글
CHECK_CAP = 3000  # 검사 모델에 보여 주는 쪽 글(similar.solved와 같음)
BACKUPS = 2  # 못 만든 자리를 넘겨 볼 다른 쪽 수
WORKERS = 8  # 동시에 만드는 자리 · 동시에 개념을 뽑는 쪽(호출 간격은 SchoolLlm이 지킴)
# 여분 자리: 5문제에 자리 5개면 1~2개가 비었고(11/05 미생 3~4/5 · 기생충 1~3/5) 110초에 보낼 수
# 있는 호출 약 50번 중 23~30번만 썼음. 먼저 통과한 n개를 쓰고 나머지는 멈춤
EXTRA = 0.6
# 문제 하나에: 새 초안은 20초 안에만 시작(5문제 100초), 23초에는 만든 것만 돌려줌(5문제 115초).
# 110초 하나로 두면 직전에 시작한 초안이 15~20초 더 돌아 9번 중 4번이 123~129초, 새 초안을
# 90초까지만 두면 다 채운 세트가 9번 중 6번 → 2번(11/05 로컬)
SEC_PER_QUESTION = 20
HARD_SEC_PER_QUESTION = 23
# 미리 만들기(patient): 기다리는 사용자가 없고, 사용자 작업이 도는 동안 LLM 차례를 양보하므로
# 시간 상한을 이만큼 늘림(/code-review #138). 상한을 그대로 두면 바쁠 때 문제를 덜 만듦
PATIENT = 10
CLASH = "동시에 만든 문제와 겹침"  # 다른 자리가 그사이 받은 문제와 겹침: 쪽을 닫지 않음
FULL = "이미 다 모음"
TIMEOUT = "시간 상한"
BAD_SHAPE = "문제 모양이 맞지 않음"  # 서버 모양 검사(fromWorkerQuestion)에 걸림
# 모자란 자리를 다시 돌리는 전체 상한(문제 하나에): 5문제 300초(#247). 미리 만들기는 첫 판 상한
# (HARD_SEC_PER_QUESTION × PATIENT)이 더 길어 그것을 씀
FILL_SEC_PER_QUESTION = 60
# 사용자가 기다리는 전체 상한(10문제도 5분, 이슈 #247 '예: 5분'). 첫 판 상한(23초 × n)이 더 길면
# (14문제부터) 첫 판 상한까지
FILL_MAX_SEC = 300
MAX_ROUNDS = 5  # 판 수 상한: 초안이 빨리 탈락하는 노트에서 상한 시간 내내 학교 LLM을 두드리지 않게
# 새 판을 띄울 최소 남은 시간: 한 자리(생성 · 검사 · 풀기)가 끝날 만큼. 이보다 짧으면 판이 거의 늘
# 상한에 걸려 호출만 버림(/code-review #247)
MIN_ROUND_SEC = 45
AGAIN_PER_CONCEPT = 2  # 마지막 단계에서 한 개념을 물을 수 있는 문제 수
WHY_SHOWN = 5  # 오류 글에 담는 탈락 이유 수(판 · 자리가 많아도 ai_jobs.error가 길어지지 않게)
_clock = time.monotonic  # 시험에서 바꿔 끼움
_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
# 이 쪽에서 새로 물을 것이 남지 않았다는 탈락 이유(checks.code_check). '보기 5개가 아니거나 겹침'은
# 초안 잘못이라 넣지 않음: '겹침'이 든 이유를 모두 보면 그 쪽이 닫혔음(/code-review 11/04)
DRY_REASONS = {
    "이미 있는 문제와 거의 같음",
    "앞 문제를 거꾸로 물음(겹침)",
    "세트 안에서 정답이 겹침",
}

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


@dataclass
class PageInfo:
    """한 쪽의 학습 기록: 아직 못 익힌 개념의 틀린 답 수 · 다 익힌 개념."""

    wrong: int = 0
    mastered: int = 0
    weak: list[str] = field(default_factory=list)
    done: list[str] = field(default_factory=list)
    angle: list[str] = field(default_factory=list)  # 마지막 단계: 이미 물은 개념(다른 각도로, #247)


@dataclass
class Made:
    """gen_one의 결과. question이 있으면 통과한 문제."""

    question: Draft | None = None
    concept: str | None = None
    type: str | None = None
    why: list[str] = field(default_factory=list)
    down: int = 0  # 호출이 실패한 시도 수
    tries: int = 0
    rejected: int = 0  # down 중 서버가 요청을 거절한 생성 호출(LlmRejectedError, #262)


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
    notes = parse_notes(need(raw, "notes", dict, "input"))
    return GenerateInput(day, size, material, sets, attempts, notes)


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
    #   (/code-review). 풀이 시각은 문제마다 마지막으로 푼 때, 풀이가 없으면 가장 오래된 것으로 봄
    last: dict[str, datetime] = {}
    for a in attempts:
        for qid, _, void in a.answers:
            if not void and a.finished_at > last.get(qid, datetime.min):
                last[qid] = a.finished_at
    learned: dict[str, datetime] = {}  # 개념: 익힌 문제를 마지막으로 푼 때
    stopped: dict[str, datetime] = {}  # 개념: 멈춘 문제를 마지막으로 푼 때
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
            at = last.get(q["id"], datetime.min)
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


def page_types(text: str, korean_subject: bool) -> list[str]:
    """'(A) … is/are …ing' 사진 묘사 보기가 가득한 쪽은 장면 문제, 나머지는 유형을 돌림.

    '(A)' 줄 수만 세면 RC Part 5/6 쪽도 걸렸습니다(2일차 시험).
    """
    if len(_PHOTO.findall(text)) >= 3:
        return ["묘사", "어휘"]
    if korean_subject:
        return ["정의", "특징", "분류"]
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


# ---------------------------------------------------------------- LLM: one question


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


def _hint(info: PageInfo, used: list[str]) -> str:
    hint = ""
    if info.weak:
        hint += f"\n이 학생이 자주 틀린 개념(우선 다룬다): {', '.join(info.weak)}"
    if info.done:
        hint += f"\n이미 익힌 개념(피한다): {', '.join(info.done)}"
    if info.angle:
        hint += (
            f"\n이 퀴즈에서 이미 물은 개념: {', '.join(info.angle)} — 고른다면"
            " 앞 문제와 다른 특징 · 다른 각도를 묻는다"
        )
    # 목록이 없으면 appeal to · budget · serving을 또 정답으로 냄(버린 초안 34개 중 7개, 10/29)
    if used:
        hint += f"\n이 퀴즈에서 이미 정답으로 쓴 것(정답으로 다시 쓰지 않는다): {', '.join(used)}"
    return hint


type Accept = Callable[[Made], list[str]]


def _take(seen: list[Seen], used: list[str]) -> Accept:
    """차례로 만들 때: 겹침은 code_check가 이미 봤으니 seen · used에 더하기만."""

    def accept(m: Made) -> list[str]:
        assert m.question is not None
        seen.append(seen_draft(m.question))
        used.append(m.question["answer"])
        return []

    return accept


def _until(llm: Llm, stop: threading.Event) -> Llm:
    """stop이 켜진 뒤의 호출은 보내지 않고 LlmError(STOPPED).

    다 모았거나 돌려준 뒤에도 남은 자리 스레드는 검사 · 풀기 호출을 몇 번 더 하는데, 학교 LLM
    클라이언트는 프로세스에 하나라 그 호출이 다음 작업의 차례를 밀어냄(/code-review #95).
    이미 SchoolLlm 안에서 차례를 기다리거나 다시 보내려는 호출도 stop_on으로 멈춤(Codex 리뷰
    #125). 보낸 뒤 응답을 기다리는 호출은 끝까지 기다림. 작업 취소와 같은 Stopping을 씀(#263).
    """
    return Stopping(llm, stop, STOPPED)


def gen_one(
    llm: Llm,
    page_no: int,
    text: str,
    types: list[str],
    names: list[str],
    info: PageInfo,
    seen: list[Seen],
    used: list[str],
    slot: int,
    accept: Accept | None = None,
    stop: Callable[[bool], str | None] | None = None,
) -> Made:
    """한 쪽에서 문제 1개. 처음 두 유형으로 한 번씩(2번까지).

    통과한 문제는 결과(Made)째 accept에 넘깁니다. accept가 돌려준 겹침 이유가 없으면 받아들여진
    것이고(seen · used · 세트에 더하는 것도 accept), 있으면 다음 유형으로 다시 만듭니다. accept가
    없으면 seen · used에 더하기만 합니다. 다른 자리가 seen · used를 늘리므로 만들 때는 그 사본을
    봅니다.
    stop(새 초안인지) → 멈출 이유: 새 초안 앞에서는 시간 상한 · 다 모음, 검사 앞에서는 다 모음만.
    """
    out = Made()
    accept = accept or _take(seen, used)
    notes = ""
    for ty in types[:2]:
        if stop and (halt := stop(True)):
            out.why = out.why or [halt]
            break
        used_now = list(used)
        t = Target("new", used_answers=used_now)
        hint = _hint(info, used_now)
        out.tries += 1
        tip = similar.first_tip(ty)
        user = (
            f'<노트 쪽="{page_no}">\n{text[:TEXT_CAP]}\n</노트>\n\n'
            f"개념 목록(이 안에서 고른다): {', '.join(names)}{hint}\n"
            f"문제 유형: {ty} — {similar.TYPES[ty][0]}\npassage: {similar.TYPES[ty][1]}"
            f"{notes}{chr(10) + tip if tip else ''}\n\n"
            f"이 노트로 {CHOICES}지선다 문제 1개를 만들어라. 난이도는 중·고등학교 내신 보통 수준."
        )
        try:
            r = llm.call(
                settings.quiz_gen_model,
                GEN_SYS,
                user,
                _schema(names),
                "Quiz",
                max_tokens=1400,
                temperature=0.7,
            )
        except LlmError as e:
            out.down += 1
            out.rejected += isinstance(e, LlmRejectedError)
            out.why = [str(e)]
            continue
        raw = similar._draft(r)
        if raw is None:
            out.why = ["답 모양이 맞지 않음"]
            continue
        d = tidy(raw)
        concept = r["question"].get("concept") if isinstance(r.get("question"), dict) else None
        why, k = code_check(d, t, text, ty, list(seen))
        if concept not in names:  # 개념 목록이 길면 모델이 이 필드를 빠뜨리기도 함
            why.append("개념 이름 없음")
        if (
            not d["stem"].strip()
            or not d["answer"].strip()
            or not all(o.strip() for o in d["options"])
        ):
            # 빈 질문 · 답 · 보기: 검사 호출을 쓰기 전에 거름. 보기 수는 code_check가 보고, 보기를
            # 놓은 뒤의 모양은 accept(_shape_ok)가 다시 봄(/code-review #247)
            why.append(BAD_SHAPE)
        if not why and stop and (full := stop(False)):
            out.why = [full]
            break
        if not why:
            # 오답 보기 한두 개만 걸린 초안은 새로 만들지 않고 그 보기만 바꿔 다시 검사(로컬과
            # 같음): 11/05 동시 실행에서 못 만든 자리 둘이 모두 이런 초안이었음(미생 '항산성균의
            # 염색 보조' · 'AFB stain'). 새 초안(생성 · 검사 · 풀기) 대신 생성 모델 한 번
            def check(x: Draft, t: Target = t, ty: str = ty) -> tuple[list[str], int | None]:
                return code_check(x, t, text, ty, list(seen))

            d, why, k2, _, unchecked = quality.checked(llm, d, check, text, ty)
            k = k2 if k2 is not None else k
            if unchecked:  # 검사하지 못한 초안은 쓰지 않음
                out.down += 1
                out.why = ["정답 둘 검사 호출이 실패함"]
                continue
        if not why and k is not None:
            d = similar.answer_as_option(d, k)
            options, pos = place(d["options"], k, slot)
            verdict, said = similar.solved(llm, d, options, pos, text[:CHECK_CAP])
            if verdict == "pass":
                out.question, out.concept = {**d, "options": options}, str(concept)
                out.type, out.why = ("빈칸" if "____" in d["passage"] else ty), []
                why = accept(out)
                if not why:
                    return out
                out.question = out.concept = out.type = None
                out.why = why
                if FULL in why:
                    break
                notes = f"\n앞서 만든 문제의 문제점: {'; '.join(why)} — 다른 문장으로 새로 만든다. "
                continue
            if verdict == "down":
                out.down += 1
                out.why = [said]
                continue
            if verdict == "bad":  # 답 모양 오류: 재시도 지시에 문제점으로 넣지 않음
                out.why = [said]
                continue
            why = [f"검사 탈락(검수자 답 {said})"]
        out.why = why
        notes = f"\n앞서 만든 문제의 문제점: {'; '.join(why)} — 다른 문장으로 새로 만든다. "
    return out


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


def run(llm: Llm, raw: JsonObject, report: Progress, *, patient: bool = False) -> JsonObject:
    """quiz_generate · quiz_pregen 작업 하나. patient면 시간 상한을 PATIENT배로(미리 만들기)."""
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
    made, failed, down, tried_calls, rejected = _make_all(
        llm, pages, names_all, subject, per_page, weight, share, korean, seen, n, report, patient
    )
    if len(made) < n:  # 모자란 세트는 돌려주지 않음(앱은 작업 상태로 성공 화면을 고름, #247)
        if not made and tried_calls and down == tried_calls:
            if rejected == down:  # 모두 서버가 거절: 다시 해도 같아 다시 넣지 않게(Codex #264)
                raise LlmRejectedError("문제 만들기 요청을 모두 거절함")
            raise LlmError("문제 만들기 호출이 모두 실패함")
        # 자리마다 이유가 다를 수 있어(시간 상한 · 검사 탈락) 모두 담음(겹치면 한 번)
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
            "srs": None,
        }
        for i, (_, r) in enumerate(made, 1)
        if r.question is not None
    ]
    return _result(qs, title, new_names, weight, share, plain, per_page, failed)


def _shape_ok(d: Draft) -> bool:
    """세트에 넣을 수 있는 모양인지(#247). 서버 검사(apps/api quiz-sets.service.ts
    fromWorkerQuestion: 질문 · 답이 글, 보기는 글 배열)보다 좁게 봄: 빈 질문 · 빈 답 · 빈 보기도
    빼고, 앱은 보기 중 하나를 고르므로 보기 CHOICES개 안에 정답이 있어야 함. 빈 질문 · 답은
    gen_one이 검사 호출 전에도 거름."""
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
    patient: bool = False,
) -> tuple[list[tuple[int, Made]], list[JsonObject], int, int, int]:
    """자리마다 동시에 문제를 만들어 (만든 문제(세트 순서), 못 만든 자리, 실패한 시도, 시도,
    실패 중 서버가 거절한 생성 호출).

    판(round)마다 자리를 동시에 돌리고, n개가 안 되면 통과한 문제는 둔 채 모자란 자리만 다음 판에
    다시 돌립니다(전체 상한 FILL_SEC_PER_QUESTION × n초, 미리 만들기는 첫 판 상한, #247). 열린
    쪽(물을 개념이 남은 쪽)이 없으면 마지막 단계로 이미 물은 개념도 다른 각도로 묻게 합니다(정답 ·
    문장 겹침 검사는 그대로). 판의 생성 호출이 모두 실패하면(학교 LLM 장애) 더 돌리지 않습니다.
    시도 수는 마지막 판 것이고, 못 만든 자리는 모든 판 것(마지막 판 먼저)입니다.
    시간 상한에 아직 호출 중인 자리는 실패한 시도로 셉니다: 학교 LLM이 연결만 받고 답하지
    않으면 끝난 자리가 없어, 다시 시도하지 않고 0문제 세트로 끝났음(/code-review #95).
    """
    used: list[str] = []
    asked: Counter[str] = Counter()  # 세트에서 개념마다 물은 수
    taken: list[tuple[int, Made]] = []  # 받아들인 차례대로
    visits: Counter[int] = Counter()
    dry: set[int] = set()
    drained: set[int] = set()  # dry 가운데 물을 개념이 남지 않아 닫은 쪽(마지막 단계에서 다시 엶)
    lock = threading.Lock()
    done = threading.Event()  # n개를 다 모았거나 돌려줌: 남은 자리는 다음 단계에서 멈춤
    relaxed = False  # 마지막 단계: 이미 물은 개념도 다른 각도로(#247)
    errors: list[BaseException] = []  # LlmError가 아닌 오류로 끝난 자리(guarded)
    backups = sorted(weight, key=lambda p: -weight[p])  # 못 만든 자리가 넘어갈 쪽
    slots = [p for p in sorted(share, key=lambda p: -share[p]) for _ in range(share[p])]
    t0 = _clock()
    mult = PATIENT if patient else 1
    budget = max(n, 1) * mult
    deadline = t0 + SEC_PER_QUESTION * budget
    hard = t0 + HARD_SEC_PER_QUESTION * budget
    total = max(hard, t0 + min(FILL_SEC_PER_QUESTION * max(n, 1), FILL_MAX_SEC))
    min_round = min(MIN_ROUND_SEC, HARD_SEC_PER_QUESTION * budget)

    def spare_of(k: int, order: list[int]) -> list[int]:
        # 여분 자리는 가장 무거운 쪽부터(못 만든 자리가 넘어가는 순서와 같음)
        return [order[i % len(order)] for i in range(int(k * EXTRA + 0.5))] if order else []

    def per_concept(again_ok: bool) -> int:
        """한 개념을 물을 수 있는 문제 수: 마지막 단계에서만 AGAIN_PER_CONCEPT."""
        return AGAIN_PER_CONCEPT if again_ok else 1

    def accept(page: int, r: Made, again_ok: bool) -> list[str]:
        """잠금 안에서 그사이 다른 자리가 받은 문제와 겹침을 다시 보고, 받으면 세트에 바로 넣음
        (받은 뒤 세트에 넣기 전에 돌려주면 그 문제를 잃고 개념만 막힘, /code-review #95)."""
        d = r.question
        assert d is not None and r.concept is not None
        if not _shape_ok(d):  # 서버가 빼는 모양이면 받지 않고 그 자리가 다시 만듦(#247)
            return [BAD_SHAPE]
        with lock:
            if done.is_set() or len(taken) >= n:
                return [FULL]
            if (
                # 마지막 단계에서도 한 개념은 두 문제까지(/code-review #247)
                asked[r.concept] >= per_concept(again_ok)
                or any(same_item(d["answer"], u) for u in used)
                or too_close(d, seen)
                or reversed_of(d, seen)
            ):
                return [CLASH]
            asked[r.concept] += 1
            seen.append(seen_draft(d))
            used.append(d["answer"])
            taken.append((page, r))
            if len(taken) >= n:
                done.set()
            return []

    def stop_of(halt: threading.Event, draft_until: float) -> Callable[[bool], str | None]:
        """판마다 멈춤 판단: 지난 판에 남아 도는 자리가 다음 판의 늦춰진 상한을 보고 새 초안을
        시작하지 않게 그 판의 상한 · halt를 붙잡아 둠(/code-review #247)."""

        def stop(new_draft: bool) -> str | None:
            if done.is_set():
                return FULL
            if halt.is_set():
                return TIMEOUT
            return TIMEOUT if new_draft and _clock() > draft_until else None

        return stop

    def one_slot(
        slot: int, p: int, until: Llm, stop: Callable[[bool], str | None]
    ) -> tuple[int, Made]:
        with lock:
            tried = [p] + [b for b in backups if b != p and b not in dry][:BACKUPS]
            # 이 자리가 시작할 때의 단계: 지난 판에 남아 도는 자리가 뒤늦게 켜진 마지막 단계를 따라
            # 이미 물은 개념(다른 각도 안내 없이 만든 초안)을 받지 않게(/code-review #247)
            again_ok = relaxed
        last = (p, Made(why=["물을 개념이 남지 않음"]))
        down = tries = rejected = 0
        for page in tried:
            if halt := stop(True):
                last = (last[0], Made(why=[halt]))
                break
            with lock:
                if page in dry:
                    continue
                # 세트 안에서 개념은 한 문제씩: 이미 물은 개념을 또 고른 초안이 기생충 30개 중
                # 6개(조충류 · 질편모충, 11/01)였고, 그사이 2쪽의 대장 아메바 · 리슈마니아를
                # 묻지 못함. 마지막 단계(relaxed)에서만 이미 물은 개념도 고름
                names = [
                    c
                    for c in concepts.for_text(names_all, pages[page], subject)
                    if asked[c] < per_concept(again_ok)
                ]
                if not names:
                    if again_ok == relaxed:  # 지난 단계 자리가 다시 연 쪽을 닫지 않게(/code-review)
                        dry.add(page)
                        drained.add(page)
                    continue
                types = page_types(pages[page], korean)
                k = visits[page] % len(types)
                visits[page] += 1
                info = per_page[page]
                if again_ok and (again := [c for c in names if c in asked]):
                    info = replace(info, angle=again)

            def here(x: Made, page: int = page) -> list[str]:
                return accept(page, x, again_ok)

            r = gen_one(
                until, page, pages[page], types[k:] + types[:k], names, info,
                seen, used, slot, here, stop,
            )  # fmt: skip
            down, tries, rejected = down + r.down, tries + r.tries, rejected + r.rejected
            last = (page, r)
            if r.question:  # accept가 세트에 넣음
                break
            # 이 쪽에는 새로 물을 것이 남지 않음. 이유가 모두 겹침일 때만: 보기가 망가진 초안의
            # '정답이 겹침'에 1쪽이 닫혀 0문제가 됨(기생충 3 실제 실행, 11/04)
            if r.why and all(w in DRY_REASONS for w in r.why):
                with lock:
                    # 지난 단계의 자리가 마지막 단계에서 막 연 쪽을 다시 닫지 않게
                    # (/code-review #247)
                    if again_ok == relaxed:
                        dry.add(page)
        page, r = last
        r.down, r.tries, r.rejected = down, tries, rejected
        return page, r

    shown = 0

    def show() -> None:
        nonlocal shown
        if len(taken) != shown:
            shown = len(taken)
            report(15 + 85 * shown // max(n, 1), "문제 만들기")

    def guarded(
        slot: int, p: int, until: Llm, stop: Callable[[bool], str | None]
    ) -> tuple[int, Made]:
        """자리가 LlmError가 아닌 오류(학교 LLM 설정 오류 · 코드 오류)로 끝나면 그 자리에서 바로
        멈춤 신호를 켬: 남은 자리도 같으므로 주 스레드가 알아채기 전에 다음 자리가 호출하지 않게
        (Codex 리뷰 #264). 신호를 켜기 전에 오류를 남겨 둠: 주 스레드가 신호를 보고 먼저 빠져나오면
        이 자리는 아직 도는 자리로 빠져 오류를 잃고 시간 상한으로 셈(Codex 재리뷰 #264)."""
        try:
            return one_slot(slot, p, until, stop)
        except LlmError:
            raise
        except BaseException as e:
            errors.append(e)
            done.set()
            raise

    # 판마다 새로 만들지 않음: 지난 판에 남아 응답을 기다리는 자리도 WORKERS 안에 들어, 동시에
    # 붙잡는 학교 LLM 연결이 판 수만큼 늘지 않게(/code-review #247)
    pool = ThreadPoolExecutor(max_workers=WORKERS, thread_name_prefix="quiz-slot")

    def one_round(
        at: list[int], draft_until: float, until_time: float
    ) -> tuple[list[tuple[int, Made]], list[tuple[int, Made]], int]:
        """자리들을 동시에 돌려 (끝난 자리, 못 만든 자리(시간 상한에 도는 중 · 시작하지 못함),
        시작한 자리 수)."""
        halt = threading.Event()  # 이 판이 끝나면 남은 자리는 호출하지 않음
        until = _until(llm, halt)
        stop = stop_of(halt, draft_until)
        futures: list[Future[tuple[int, Made]]] = []
        try:
            futures = [pool.submit(guarded, k, p, until, stop) for k, p in enumerate(at)]
            pending: set[Future[tuple[int, Made]]] = set(futures)
            while pending and not done.is_set() and (left := until_time - _clock()) > 0:
                # 자리 하나가 끝날 때마다 깨어남(늦어도 1초마다 시간 상한을 봄)
                _, pending = wait(pending, timeout=min(1.0, left), return_when=FIRST_COMPLETED)
                show()
            show()  # 마지막 자리가 끝나며 다 모은 것
        finally:
            with lock:
                halt.set()
            # 시작하지 않은 자리는 취소하고, 취소되지 않고 끝나지도 않은 자리는 도는 자리로 셈
            # (그사이 워커를 얻은 자리도 빠지지 않게, /code-review #247). 도는 자리는 기다리지
            # 않음: 다음 호출(_until) · 단계(stop)에서 멈춤
            for f in futures:
                f.cancel()
            running = {f for f in futures if not f.done()}
        # 오류로 끝난 자리는 guarded가 errors에 남겨 아래에서 한 곳으로 올림(/code-review #269)
        finished = [
            f.result()
            for f in futures
            if f.done()
            and not f.cancelled()
            and f not in running
            and not ((e := f.exception()) is not None and not isinstance(e, LlmError))
        ]
        cut = [(p, Made(why=[TIMEOUT])) for f, p in zip(futures, at, strict=True)
               if f in running or f.cancelled()]  # fmt: skip
        return finished, cut, len(finished) + len(running)

    def not_made(
        finished: list[tuple[int, Made]], cut: list[tuple[int, Made]]
    ) -> list[tuple[int, Made]]:
        """판에서 못 만든 자리(끝난 자리의 탈락 이유 + 도는 중이었거나 시작하지 못한 자리)."""
        out = []
        for page, r in finished:
            if r.question is not None or FULL in r.why:  # 다 모아 멈춘 자리는 못 만든 것이 아님
                continue
            out.append((page, Made(why=[TIMEOUT]) if STOPPED in r.why else r))
        return out + cut

    at = slots + spare_of(n, backups)
    finished: list[tuple[int, Made]] = []
    cut: list[tuple[int, Made]] = []
    earlier: list[tuple[int, Made]] = []  # 앞 판에서 못 만든 자리(오류 글에 이유를 모두 담음)
    rounds = 0
    answered = False  # 학교 LLM이 한 번이라도 답함(어느 판에서든 실패하지 않은 호출이 있음)
    try:
        while True:
            finished, cut, started = one_round(at, deadline, hard)
            answered = answered or any(r.tries > r.down for _, r in finished)
            rounds += 1
            missing = n - len(taken)
            now = _clock()
            if errors:  # 설정 · 코드 오류: 다음 판도 같음(아래에서 그대로 올림)
                break
            # 남은 시간이 한 자리(생성 · 검사 · 풀기)에 모자라면 새 판을 띄우지 않음. 문제 수가
            # 적으면 첫 판 상한이 기준(1문제: 23초)
            if missing <= 0 or total - now < min_round or rounds >= MAX_ROUNDS:
                break
            # 학교 LLM 장애: 다음 판도 같으므로 작업 처리기에 맡김. 끝난 자리의 호출이 모두
            # 실패했거나, 끝난 자리가 하나도 없음(모두 상한까지 응답을 기다림 · 지난 판 자리가
            # 워커를 잡아 시작하지 못함): 응답하지 않는 서버를 판마다 다시 두드리지 않음
            # (#95 · /code-review #247)
            round_down = sum(r.down for _, r in finished)
            round_tries = sum(r.tries for _, r in finished)
            # 이번 판 자리가 만든 문제만 성과로 셈: 지난 판에 남은 자리가 뒤늦게 받아들여져도
            # 장애 중인 학교 LLM을 다음 판에서 다시 두드리지 않게(/code-review #247)
            # 끝난 자리가 없는 판은 한 문제도 못 만들었을 때만 장애: 만든 문제가 있으면 서버는
            # 답하고 있음. 다만 한 자리도 시작하지 못한 판(지난 판 자리가 워커를 모두 잡음)은 다음
            # 판도 같으므로 멈춤
            if not any(r.question for _, r in finished) and (
                (not finished and not taken)
                or not started
                or (round_tries and round_down == round_tries)
            ):
                break
            with lock:
                open_pages = [b for b in backups if b not in dry]
                if not open_pages and not relaxed:  # 개념이 모자람: 마지막 단계
                    # 개념이 바닥나 닫은 쪽만 다시 엶. 겹침(DRY_REASONS)으로 닫은 쪽은 마지막
                    # 단계에서도 같은 겹침 검사에 걸리므로 그대로(/code-review #247)
                    relaxed = True
                    dry -= drained
                    open_pages = [b for b in backups if b not in dry]
            if not open_pages:
                break  # 마지막 단계에서도 물을 것이 없음
            earlier += not_made(finished, cut)
            at = [open_pages[i % len(open_pages)] for i in range(missing)]
            at += spare_of(missing, open_pages)
            # 판 하나의 상한은 첫 판과 같게: 자리는 동시에 돌아 한 자리에 드는 시간(생성 · 검사 ·
            # 풀기)이 모자란 문제 수에 비례하지 않음. 1문제 × 23초로 두면 다시 돌린 자리가 거의 늘
            # 상한에 걸림(/code-review #247)
            deadline = min(total, now + SEC_PER_QUESTION * budget)
            hard = min(total, now + HARD_SEC_PER_QUESTION * budget)
    finally:
        with lock:
            done.set()
            made = list(taken)
        pool.shutdown(wait=False, cancel_futures=True)
    # 자리가 LlmError가 아닌 오류로 끝남(guarded): 남은 자리도 같으므로 그대로 올림(#262). 그사이
    # 다른 자리가 n개를 다 모았으면 만든 세트를 버리지 않음(/code-review #269)
    if errors and len(made) < n:
        raise errors[0]
    out: list[tuple[int, Made]] = []
    for i, (page, r) in enumerate(made):
        # 정답 자리는 세트 안 순서로(여분 자리 번호로 두면 몰림)
        assert r.question is not None
        q = r.question
        options, _ = place(q["options"], q["options"].index(q["answer"]), i)
        r.question = {**q, "options": options}
        out.append((page, r))
    # 다 채우면 run이 그대로 돌려주므로 비고, 모자라면 run이 오류 글에 이유를 담음(마지막 판 먼저)
    failed: list[JsonObject] = (
        [{"pageNo": page, "why": r.why} for page, r in not_made(finished, cut) + earlier]
        if len(made) < n
        else []
    )
    # 한 문제도 못 만들었을 때만 시간 상한에 호출 중이던 · 시작하지 못한 자리를 실패한 시도로
    # (응답하지 않는 서버). 만든 문제가 있으면 서버는 답하고 있으므로 장애가 아님(/code-review #247)
    # 앞 판에서 서버가 답했으면 마지막 판이 전체 상한에 잘린 것도 장애가 아님(/code-review #269)
    stuck = len(cut) if not made and not answered else 0
    down = sum(r.down for _, r in finished) + stuck
    tries = sum(r.tries for _, r in finished) + stuck
    return out, failed, down, tries, sum(r.rejected for _, r in finished)


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
