"""개념 카드 작업(#558, 상위 #557): 맞춤 퀴즈와 같은 범위의 플래시카드 5장.

ai_jobs.type = 'quiz_flashcards' (공용 계약 AiJobType). 맞춤 퀴즈 · 미리 만들기 세트가 ready가 되면
NestJS가 넣습니다(quiz-sets.service.ts settle). 퀴즈 작업과 따로 돌아 퀴즈 응답을 늦추지 않습니다
(앱은 퀴즈 작업이 succeeded가 되어야 퀴즈를 엶). 미리 만들기처럼 사용자 작업과 따로 도는 반복이
가져가고, LLM 호출 차례도 사용자 작업에 양보합니다(worker/handlers.py BACKGROUND).

회의(09-27) 결정: 문제 5개를 만들 때 같은 범위에서 플래시카드도 따로 5장. 퀴즈 문제를 카드로 옮기지
않고, 퀴즈 문제가 나온 쪽 · 그 문제의 개념으로 카드(앞 = 용어 · 짧은 질문, 뒤 = 뜻 · 답 1~2문장)를
LLM 한 호출로 묶어 만듭니다.

input — NestJS가 작업을 만들 때 담습니다
  material   퀴즈 작업의 input.material 그대로({id, title, pages, concepts?, chunks?}, generate.py)
  questions  [{id, order, prompt, choices, answer, explanation?, conceptTags}] 그 세트의 문제.
             문제마다 나온 쪽을 낱말로 찾습니다(text.locate, DB에 문제의 쪽이 없음)

result — NestJS가 사용자가 플래시카드 목록을 열 때 flashcards에 저장합니다(flashcards.service.ts)
  flashcards        [{front, back, pageNo, concept}] 근거 검사를 통과한 카드(최대 COUNT장)
  flashcardsReason  COUNT장을 못 채운 이유('N/5장만 만듦(이유)'), 다 채우면 null

검사(코드): 모양 · 쪽(보여 준 쪽만) · 길이 · 앞뒤가 같음 · 앞면 겹침, 앞면 낱말이 그 쪽 글에 있음,
뒷면 글이 그 쪽 노트 글에 있음(grounded). 그다음 검사 모델이 한 호출로 앞뒤 짝을 봄(뒷면이 그 앞면의
뜻 · 답인지, _verify). 떨어진 카드는 빼고, 모자라면 보충 호출은 한 번까지(앞
카드의 문제점 · 이미 만든 앞면을 알려 줌).

카드는 퀴즈의 덤입니다: 호출 실패 · 시간 초과 · 설정 오류 · 코드 오류가 나도 예외를 올리지 않고
(다시 하면 되는 서버 거절 401 · 403 · 404만 올려 작업 처리기가 다시 시도)
만든 만큼과 이유를 돌려줍니다(작업은 성공). input 모양이 틀릴 때만 InputError(바로 실패).
이유 글에는 노트 · 카드 글을 넣지 않습니다(로그 · ai_jobs.result에 남으므로).
"""

import logging
import re
import threading
import time
import unicodedata
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor, wait

from app.clients.llm import (
    CANCELED,
    STOPPED,
    JsonObject,
    Llm,
    LlmError,
    LlmRejectedError,
    LlmSetupError,
    Stopping,
)
from app.core.config import settings
from app.services.quiz import generate
from app.services.quiz.review import (
    OTHER,
    InputError,
    Progress,
    concept_of,
    need_list,
    parse_question,
)
from app.services.quiz.text import locate, norm, terms

log = logging.getLogger(__name__)

TYPE = "quiz_flashcards"

NAME = "Flashcards"  # 카드 호출 이름
COUNT = 5  # 세트마다 카드 수(회의 결정)
TEXT_CAP = 2500  # 쪽마다 보여 주는 글(generate.TEXT_CAP과 같음)
CARD_CHARS = 10000  # 한 호출에 보여 주는 쪽 글 합계: 학교 LLM 문맥 안(generate.CHECK_CHARS 근처)
FRONT_MAX = 80
BACK_MAX = 200  # 1~2문장
# 뒷면 글자 중 그 쪽 노트 글에도 있는 글자 2개 묶음에 든 글자의 비율. 노트 문장을 살린 뜻 풀이
# ('위족으로 운동하며 적혈구를 먹는 형태' 0.81)는 넘고, 노트에 없는 뜻('모기가 옮기며 간에서
# 증식한다' 0)은 떨어짐. 묶음 수로 세면 이어 붙인 어미('4핵이며 인체 감염형')마다 묶음이 둘씩 빠져
# 노트 그대로인 풀이도 떨어졌음(0.5)
COVER = 0.6
# 뜻 풀이 끝의 서술 어미: 노트는 '- 4핵, 인체 감염형'처럼 어미 없이 적어, 세기 전에 뺌
# 맨 끝 '다' 한 글자는 빼지 않음('바다' · '많다'는 그 낱말이 노트에 그대로 있음, /code-review)
_END = re.compile(r"(?:입니다|합니다|됩니다|이다|한다|된다|는다|있다|없다|이며|이고)[\s.!]*$")
_LATIN = re.compile(r"([a-z]+)")
_SPACE = re.compile(r"\s+")
RUN = 4  # 뒷면에 쪽 글 그대로 있어야 하는 구간 길이(글자)
# 카드 한 장 몫의 출력 토큰: 앞 80자 + 뒤 200자 + 개념 · JSON 키(한글은 글자당 1토큰 안팎)
CARD_TOKENS = 700  # 한글이 글자당 2토큰 가까운 토크나이저도 덮게 넉넉히(상한일 뿐, /code-review)
POLL_SEC = 1.0  # 호출을 기다리며 상한을 보는 간격
# 작업 하나의 상한(초): 학교 LLM 호출 하나가 길면 180초 · 다시 보내기까지 걸리고, background 호출은
# 사용자 작업이 도는 동안 차례를 기다림. 넘으면 만든 만큼으로 끝냄(작업을 오래 잡지 않게)
JOB_SEC = 240
MIN_SEC = 15  # 남은 시간이 이보다 짧으면 호출하지 않음: 호출 하나도 끝나기 어려움
TIMEOUT = "시간 상한"
BAD_SHAPE = "카드 모양이 맞지 않음"
NOT_SHOWN = "보여 준 쪽이 아님"
TOO_LONG = "너무 김"
SAME_SIDES = "앞뒤가 같음"
SAME_FRONT = "앞면이 겹침"
FRONT_NOT_IN_NOTE = "앞면 낱말이 그 쪽에 없음"
NOT_IN_NOTE = "뒷면이 노트 글에 없음"
NOT_PAIRED = "뒷면이 앞면의 뜻 · 답이 아님"  # 검사 모델의 앞뒤 짝 검사(_verify)
UNCHECKED = "짝 검사의 답 모양이 맞지 않음"
VERIFY_NAME = "CheckCards"  # 앞뒤 짝 검사 호출 이름
WHY_SHOWN = 4  # 이유 글에 담는 탈락 이유 수

VERIFY_SYS = (
    "너는 플래시카드 검수자다. 카드마다 그 카드에 적힌 쪽의 노트만 근거로, 뒷면이 앞면(용어나 "
    "질문)의 뜻이나 답으로 맞는지 판단한다. 뒷면이 다른 용어 · 다른 항목의 설명이거나 노트로 "
    "확인할 수 없으면 false. 카드마다 따로 판단해 results에 카드 순서대로 넣는다. "
    "JSON으로만 답한다."
)
CARD_SYS = (
    "너는 학습용 플래시카드를 만든다. 주어진 노트 쪽의 글만 근거로, 외울 만한 용어 · 개념마다 "
    "카드 한 장을 만든다. front는 용어나 짧은 질문 한 줄, back은 그 뜻이나 답을 노트 문장을 살려 "
    "1~2문장으로 쓴다. 노트에 없는 내용 · 일반 상식은 쓰지 않는다. pageNo는 back의 근거가 있는 쪽, "
    "concept는 그 카드의 개념 이름. 카드끼리 같은 내용을 묻지 않는다. JSON으로만 답한다."
)


def grounded(back: str, page_text: str) -> bool:
    """뒷면 글이 그 쪽 노트 글에 있는지(끝 어미 뺌).

    영어 낱말은 낱말째(그 쪽 글의 낱말이면 덮임), 나머지(한글 · 숫자)는 norm 글에서 쪽 글에도 있는
    글자 2개 묶음이 덮는 글자로 셉니다. 덮인 글자가 COVER 이상이고, 쪽 글에 그대로 있는 구간도
    하나는 있어야 함(RUN글자 이상인 영어 낱말 · RUN글자 이어진 한글): 흔한 묶음('으로' · '하는')만
    맞아 비율이 넘는 지어낸 풀이를 막음. 영어를 글자 2개 묶음으로 세면 'th' · 'in' 같은 묶음이 쪽
    글에 거의 다 있어 어떤 영어 문장도 통과했음(/code-review).
    """
    page = norm(page_text)
    page_words = set(_LATIN.findall(page_text.lower()))
    covered = total = 0
    anchored = False
    text = back.strip().lower()
    cut = _END.sub("", text)
    if len(norm(cut)) >= 2:  # 어미를 빼서 너무 짧아지면 빼지 않음
        text = cut
    for i, part in enumerate(_LATIN.split(text)):
        if i % 2:  # 영어 낱말(split의 홀수 자리)
            total += len(part)
            if part in page_words:
                covered += len(part)
                anchored = anchored or len(part) >= RUN
            continue
        t = norm(part)
        hit = [False] * len(t)
        for j in range(len(t) - 1):
            if t[j : j + 2] in page:
                hit[j] = hit[j + 1] = True
        total += len(t)
        covered += sum(hit)
        n = min(RUN, len(t))  # RUN보다 짧은 글('바다')은 글 전체가 그대로 있어야 함
        anchored = anchored or (n >= 2 and any(t[j : j + n] in page for j in range(len(t) - n + 1)))
    # 짧은 뒷면('ATP' · 'ATP이다')이 모두 덮이면 그 글이 그대로 있는 것(/code-review)
    anchored = anchored or (covered == total and total < 2 * RUN)
    return total >= 2 and anchored and covered / total >= COVER


def _front_in_note(front: str, page_text: str) -> bool:
    """앞면 낱말(text.terms: 한글 낱말 앞 2글자 · 영어 앞 5글자)의 절반 넘게 그 쪽 글에 있음.
    '이 쪽의 주요 특징은?'처럼 개념 없는 앞면이 흔한 낱말 하나로 통과하지 않게(/code-review).
    낱말이 없으면(숫자 · 한 글자) 앞면 전체가 쪽 글에 있어야 함."""
    page = norm(page_text)
    found = [t for t in (norm(x) for x in terms(front)) if t]
    if not found:
        return norm(front) in page
    return sum(t in page for t in found) * 2 > len(found)


def _front_key(front: str) -> str:
    """앞면 겹침 비교 값: NFC 정규화 뒤 공백만 뺌(API flashcards.service.ts frontKey와 같음).
    대소문자 · 기호는 살림: CO 일산화탄소 · Co 코발트, Cl 염소 · Cl- 염화 이온(Codex 리뷰 #559)."""
    return _SPACE.sub("", unicodedata.normalize("NFC", front))


def _check(raw: object, pages: dict[int, str], fronts: set[str]) -> tuple[JsonObject | None, str]:
    """카드 하나: (통과한 카드, '') 또는 (None, 이유)."""
    if not isinstance(raw, dict):
        return None, BAD_SHAPE
    front, back, page, concept = (raw.get(k) for k in ("front", "back", "pageNo", "concept"))
    if (
        not isinstance(front, str)
        or not isinstance(back, str)
        or not front.strip()
        or not back.strip()
    ):
        return None, BAD_SHAPE
    if not isinstance(page, int) or isinstance(page, bool) or page not in pages:
        return None, NOT_SHOWN
    front, back = front.strip(), back.strip()
    if len(front) > FRONT_MAX or len(back) > BACK_MAX:
        return None, TOO_LONG
    if norm(front) == norm(back):
        return None, SAME_SIDES
    if _front_key(front) in fronts:
        return None, SAME_FRONT
    if not _front_in_note(front, pages[page]):
        return None, FRONT_NOT_IN_NOTE
    if not grounded(back, pages[page]):
        return None, NOT_IN_NOTE
    name = concept.strip() if isinstance(concept, str) and concept.strip() else None
    return {"front": front, "back": back, "pageNo": page, "concept": name}, ""


def _schema(pages: list[int], k: int) -> JsonObject:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["cards"],
        "properties": {
            "cards": {
                "type": "array",
                "maxItems": k,
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["front", "back", "pageNo", "concept"],
                    "properties": {
                        "front": {"type": "string"},
                        "back": {"type": "string"},
                        "pageNo": {"type": "integer", "enum": pages},
                        "concept": {"type": "string"},
                    },
                },
            }
        },
    }


def _shown(pages: dict[int, str], scope: list[tuple[int, str]]) -> tuple[dict[int, str], list[str]]:
    """보여 줄 쪽 글(퀴즈가 많이 물은 쪽부터 CARD_CHARS까지)과 개념(많이 물은 것부터)."""
    order = [p for p, _ in Counter(p for p, _ in scope if p in pages).most_common()]
    shown: dict[int, str] = {}
    total = 0
    for p in order:
        text = pages[p][:TEXT_CAP]
        if shown and total + len(text) > CARD_CHARS:
            continue
        shown[p] = text
        total += len(text)
    names = [c for c, _ in Counter(c for p, c in scope if c and p in shown).most_common()]
    return shown, names


def _ask(
    llm: Llm,
    model: str,
    system: str,
    user: str,
    schema: JsonObject,
    name: str,
    max_tokens: int,
    end: Callable[[], float],
    clock: Callable[[], float],
    temperature: float = 0.0,
) -> JsonObject:
    """LLM 호출 하나. end()(clock 값)까지만 기다리고(POLL_SEC마다 봄), 넘으면 남은 호출을 멈추고
    LlmError(TIMEOUT). 이미 보낸 호출은 응답을 기다리는 스레드에 남음(Stopping, 알려진 한계)."""
    stop = threading.Event()
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="quiz-cards")
    try:
        f = pool.submit(
            Stopping(llm, stop, STOPPED).call,
            model,
            system,
            user,
            schema,
            name,
            max_tokens=max_tokens,
            temperature=temperature,
        )
        while not f.done():
            left = end() - clock()
            if left <= 0:
                stop.set()
                raise LlmError(TIMEOUT)
            wait([f], timeout=min(POLL_SEC, left))
        return f.result()
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def _call(
    llm: Llm,
    user: str,
    pages: list[int],
    k: int,
    end: Callable[[], float],
    clock: Callable[[], float],
) -> object:
    """카드 만들기 호출 하나(생성 모델). 답의 cards."""
    r = _ask(
        llm, settings.quiz_gen_model, CARD_SYS, user, _schema(pages, k), NAME,
        200 + CARD_TOKENS * k, end, clock, temperature=0.3,
    )  # fmt: skip
    return r.get("cards") if isinstance(r, dict) else None


def _verify(
    llm: Llm,
    cards: list[JsonObject],
    pages: dict[int, str],
    end: Callable[[], float],
    clock: Callable[[], float],
) -> list[bool] | None:
    """코드 검사를 통과한 카드들의 앞뒤 짝을 검사 모델이 한 호출로 봄(Codex 리뷰 #559).

    카드마다 뒷면이 앞면(용어 · 질문)의 뜻 · 답이 맞는지. 뒷면 글이 그 쪽 노트에 있어도(grounded)
    다른 용어의 설명을 붙일 수 있어서: '이질 아메바 포낭형의 핵 수' ↔ 대장 아메바의
    '포낭형이 8핵이고 비병원성'. 답 모양이 틀리면 None(이 판의 카드를 쓰지 않음).
    """
    notes = "\n\n".join(
        f'<노트 쪽="{p}">\n{pages[p]}\n</노트>' for p in sorted({c["pageNo"] for c in cards})
    )
    shown = "\n\n".join(
        f"카드 {i} (노트 쪽 {c['pageNo']})\n앞: {c['front']}\n뒤: {c['back']}"
        for i, c in enumerate(cards, 1)
    )
    schema: JsonObject = {
        "type": "object",
        "additionalProperties": False,
        "required": ["results"],
        "properties": {
            "results": {
                "type": "array",
                "minItems": len(cards),
                "maxItems": len(cards),
                "items": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["matches"],
                    "properties": {"matches": {"type": "boolean"}},
                },
            }
        },
    }
    r = _ask(
        llm, settings.quiz_check_model, VERIFY_SYS, f"{notes}\n\n{shown}", schema, VERIFY_NAME,
        100 + 30 * len(cards), end, clock,
    )  # fmt: skip
    rows = r.get("results") if isinstance(r, dict) else None
    if not isinstance(rows, list) or len(rows) != len(cards):
        return None
    out = [row.get("matches") if isinstance(row, dict) else None for row in rows]
    ok = [x for x in out if isinstance(x, bool)]
    return ok if len(ok) == len(out) else None


def make(
    llm: Llm,
    pages: dict[int, str],
    scope: list[tuple[int, str]],
    *,
    end: float,
    clock: Callable[[], float] | None = None,
) -> tuple[list[JsonObject], str | None]:
    """퀴즈 문제가 나온 (쪽, 개념)들(scope)로 카드 COUNT장. (카드, 모자란 이유 또는 None).

    end는 clock 값으로 카드 단계가 끝나야 하는 때. 다시 하면 되는 설정 오류(LlmSetupError retry)만
    올리고, 그 밖의 실패는 예외를 올리지 않습니다(모듈 설명).
    """
    now = clock or time.monotonic

    def limit() -> float:
        return end

    shown, names = _shown(pages, scope)
    if not shown:
        return [], "퀴즈 쪽이 없음"
    cards: list[JsonObject] = []
    fronts: set[str] = set()
    why: list[str] = []
    faults: list[str] = []  # 카드 탈락 이유(보충 호출에 알림). 호출 장애는 넣지 않음
    for again in (False, True):
        k = COUNT - len(cards)
        if limit() - now() < MIN_SEC:
            why.append(TIMEOUT)
            break
        notes = "\n\n".join(f'<노트 쪽="{p}">\n{t}\n</노트>' for p, t in sorted(shown.items()))
        user = (
            f"{notes}\n\n개념(가능하면 이 개념들로, 한 개념에 한 장): {', '.join(names)}\n"
            f"이 노트로 플래시카드 {k}장을 만들어라."
        )
        if again and cards:
            made = "; ".join(c["front"] for c in cards)
            user += f"\n이미 만든 카드 앞면(다시 만들지 않는다): {made}"
        if again and faults:
            user += f"\n앞서 만든 카드의 문제점: {'; '.join(dict.fromkeys(faults))}"
        try:
            got = _call(llm, user, sorted(shown), k, limit, now)
            if not isinstance(got, list):
                why.append(BAD_SHAPE)
                faults.append(BAD_SHAPE)
                continue
            picked: list[JsonObject] = []  # 코드 검사를 통과한 카드(앞뒤 짝 검사 전)
            for raw in got:
                if len(cards) + len(picked) >= COUNT:
                    break
                c, bad = _check(raw, shown, fronts | {_front_key(x["front"]) for x in picked})
                if c is None:
                    why.append(bad)
                    faults.append(bad)
                    continue
                picked.append(c)
            matches = _verify(llm, picked, shown, limit, now) if picked else []
        except LlmRejectedError as e:  # 다시 보내도 같음
            why.append(f"카드 요청 거절({e})")
            break
        except LlmError as e:
            if str(e) in (TIMEOUT, CANCELED):  # 시간 상한 · 작업 취소: 보충 호출도 하지 않음
                why.append(TIMEOUT if str(e) == TIMEOUT else "작업이 취소됨")
                break
            why.append(f"카드 호출 실패({e})")
            continue
        except LlmSetupError as e:
            if e.retry:  # 서버 거절(401 · 403 · 404): 작업 처리기가 시도 한도 안에서 다시
                raise
            why.append(f"카드 만들기 오류({type(e).__name__})")  # 설정 값 없음 · 사용 한도
            break
        except Exception as e:  # 코드 오류: 다시 해도 같음
            why.append(f"카드 만들기 오류({type(e).__name__})")
            break
        if matches is None:
            why.append(UNCHECKED)
            continue
        for c, ok in zip(picked, matches, strict=True):
            if not ok:
                why.append(NOT_PAIRED)
                faults.append(NOT_PAIRED)
                continue
            cards.append(c)
            fronts.add(_front_key(c["front"]))
        if len(cards) >= COUNT:
            return cards, None
    shown_why = "; ".join(list(dict.fromkeys(why))[:WHY_SHOWN])
    got = f"{len(cards)}/{COUNT}장만 만듦"
    return cards, f"{got}({shown_why})" if shown_why else got


def run(llm: Llm, raw: JsonObject, report: Progress) -> JsonObject:
    """quiz_flashcards 작업 하나(모듈 설명). input이 틀리면 InputError."""
    m = generate.parse_material(raw.get("material"))
    qs = [
        parse_question(q, f"input.questions[{i}]")
        for i, q in enumerate(need_list(raw, "questions", "input"))
    ]
    pages = generate.note_pages(m)
    if not pages or not qs:
        raise InputError("카드를 낼 노트 글 · 문제가 없음")
    notes = {m.id: pages}
    scope = [
        (locate(q, notes, m.id)[1], "" if concept_of(q) == OTHER else concept_of(q)) for q in qs
    ]
    report(10, "개념 카드 만들기")
    t0 = time.monotonic()
    cards, why = make(llm, pages, scope, end=t0 + JOB_SEC)
    if why:
        log.info("개념 카드: %d/%d장, %.0f초(%s)", len(cards), COUNT, time.monotonic() - t0, why)
    report(100, "개념 카드 만들기")
    return {"flashcards": cards, "flashcardsReason": why}
