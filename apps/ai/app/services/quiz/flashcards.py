"""맞춤 퀴즈 끝에 만드는 개념 카드(#558, 상위 #557).

회의(09-27) 결정: 문제 5개를 만들 때 같은 범위에서 플래시카드도 따로 5장. 퀴즈 문제를 카드로 옮기지
않고, 퀴즈가 문제를 나눈 쪽 · 그 쪽 개념으로 카드(앞 = 용어 · 짧은 질문, 뒤 = 뜻 · 답 1~2문장)를
LLM 한 호출로 묶어 만듭니다. generate.run이 문제 초안과 함께 부르고(generate._Cards), 결과는
result.flashcards로 나가 NestJS가 세트를 ready로 옮길 때 flashcards에 저장합니다(settle).

검사(코드): 모양 · 쪽(보여 준 쪽만) · 길이 · 앞뒤가 같음 · 앞면 겹침, 앞면 낱말이 그 쪽 글에 있음,
뒷면 글이 그 쪽 노트 글에 있음(grounded: 노트 글에 있는 글자 2개 묶음이 덮는 글자가 COVER 이상).
떨어진 카드는 빼고, 모자라면
보충 호출은 한 번까지(앞 카드의 문제점 · 이미 만든 앞면을 알려 줌).

카드는 퀴즈의 덤입니다: 호출 실패 · 시간 초과 · 설정 오류 · 코드 오류가 나도 예외를 올리지 않고
만든 만큼과 이유를 돌려줍니다(퀴즈 작업은 그대로 성공). 이유 글에는 노트 · 카드 글을 넣지 않습니다
(로그 · ai_jobs.result에 남으므로).
"""

import re
import threading
import time
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
    Stopping,
)
from app.core.config import settings
from app.services.quiz.text import norm, terms

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
RUN = 4  # 뒷면에 쪽 글 그대로 있어야 하는 구간 길이(글자)
# 카드 한 장 몫의 출력 토큰: 앞 80자 + 뒤 200자 + 개념 · JSON 키(한글은 글자당 1토큰 안팎)
CARD_TOKENS = 700  # 한글이 글자당 2토큰 가까운 토크나이저도 덮게 넉넉히(상한일 뿐, /code-review)
POLL_SEC = 1.0  # 호출을 기다리며 상한(이어받기로 줄 수 있음)을 다시 보는 간격
# 퀴즈가 끝난 뒤 카드를 더 기다리는 상한(초). 카드는 퀴즈와 함께 만들므로(generate._Cards) 보통은
# 퀴즈보다 먼저 끝남. 바로 요청은 사용자가 기다리므로 WAIT_SEC, 미리 만들기는 CARD_SEC
WAIT_SEC = 5
CARD_SEC = 45
MIN_SEC = 15  # 남은 시간이 이보다 짧으면 호출하지 않음: 호출 하나도 끝나기 어려움
TIMEOUT = "시간 상한"
BAD_SHAPE = "카드 모양이 맞지 않음"
NOT_SHOWN = "보여 준 쪽이 아님"
TOO_LONG = "너무 김"
SAME_SIDES = "앞뒤가 같음"
SAME_FRONT = "앞면이 겹침"
FRONT_NOT_IN_NOTE = "앞면 낱말이 그 쪽에 없음"
NOT_IN_NOTE = "뒷면이 노트 글에 없음"
WHY_SHOWN = 4  # 이유 글에 담는 탈락 이유 수

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
    if norm(front) in fronts:
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


def _call(
    llm: Llm,
    user: str,
    pages: list[int],
    k: int,
    end: Callable[[], float],
    clock: Callable[[], float],
) -> object:
    """카드 호출 하나. end()(clock 값, 기다리는 동안 POLL_SEC마다 다시 봄)까지만 기다리고, 넘으면
    남은 호출을 멈추고 LlmError(TIMEOUT)."""
    stop = threading.Event()
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="quiz-cards")
    try:
        f = pool.submit(
            Stopping(llm, stop, STOPPED).call,
            settings.quiz_gen_model,
            CARD_SYS,
            user,
            _schema(pages, k),
            NAME,
            max_tokens=200 + CARD_TOKENS * k,
            temperature=0.3,
        )
        while not f.done():
            left = end() - clock()
            if left <= 0:
                stop.set()
                raise LlmError(TIMEOUT)
            wait([f], timeout=min(POLL_SEC, left))
        r = f.result()
        return r.get("cards") if isinstance(r, dict) else None
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def make(
    llm: Llm,
    pages: dict[int, str],
    scope: list[tuple[int, str]],
    *,
    end: float | Callable[[], float],
    clock: Callable[[], float] | None = None,
) -> tuple[list[JsonObject], str | None]:
    """퀴즈가 물은 (쪽, 개념)들(scope)로 카드 COUNT장. (카드, 모자란 이유 또는 None).

    end는 clock 값으로 카드 단계가 끝나야 하는 때. 함수면 볼 때마다 다시 부름(미리 만들기를 사용자가
    이어받으면 generate가 줄임). 예외를 올리지 않습니다(모듈 설명).
    """
    now = clock or time.monotonic
    limit: Callable[[], float] = end if callable(end) else (lambda: end)
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
        except LlmRejectedError as e:  # 다시 보내도 같음
            why.append(f"카드 요청 거절({e})")
            break
        except LlmError as e:
            if str(e) in (TIMEOUT, CANCELED):  # 시간 상한 · 작업 취소: 보충 호출도 하지 않음
                why.append(TIMEOUT if str(e) == TIMEOUT else "작업이 취소됨")
                break
            why.append(f"카드 호출 실패({e})")
            continue
        except Exception as e:  # 설정 · 코드 오류: 퀴즈는 그대로 성공(다시 해도 같음)
            why.append(f"카드 만들기 오류({type(e).__name__})")
            break
        if not isinstance(got, list):
            why.append(BAD_SHAPE)
            faults.append(BAD_SHAPE)
            continue
        for raw in got:
            if len(cards) >= COUNT:
                break
            c, bad = _check(raw, shown, fronts)
            if c is None:
                why.append(bad)
                faults.append(bad)
                continue
            cards.append(c)
            fronts.add(norm(c["front"]))
        if len(cards) >= COUNT:
            return cards, None
    shown_why = "; ".join(list(dict.fromkeys(why))[:WHY_SHOWN])
    got = f"{len(cards)}/{COUNT}장만 만듦"
    return cards, f"{got}({shown_why})" if shown_why else got
