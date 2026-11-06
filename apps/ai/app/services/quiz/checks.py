"""LLM이 만든 문제 초안의 코드 검사. 모델 검사(quality · 검수자)보다 먼저, 호출 없이 돌립니다.

code_check는 탈락 이유 목록과 정답 보기의 위치를 돌려줍니다. 이유가 없어야 다음 검사로 갑니다.
"""

import difflib
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Literal, NotRequired, TypedDict

from app.services.quiz.models import CHOICES, Draft, Question
from app.services.quiz.text import (
    BLANK,
    VALUE,
    norm,
    number_values,
    same_item,
    same_word,
    short_answer,
    terms,
)

NEGATIVE = re.compile(r"아닌|않은|틀린|옳지\s?않|잘못된|거리가 먼")
KO_TYPES = ("정의", "특징", "분류")  # 한국어 용어 과목 유형 (임상병리, 10/22)
_KO = re.compile(r"[가-힣]{2,}")
_PIECE = re.compile(r",\s+")  # 이어 붙인 보기의 조각 사이


class Seen(TypedDict):
    """겹침 검사에 쓰는 이미 있는 문제. 저장된 문제는 q가 있고, 이번에 만든 문제는 answer가 있음."""

    all: str  # norm(문제 글 + 제시문)
    passage: str  # norm(제시문)
    answer: NotRequired[str]  # norm(정답)
    q: NotRequired[Question | None]


def seen_question(q: Question) -> Seen:
    return {
        "all": norm(q["prompt"] + (q.get("passage") or "")),
        "passage": norm(q.get("passage")),
        "q": q,
    }


def seen_draft(d: Draft) -> Seen:
    return {
        "all": norm(d["stem"] + d["passage"]),
        "passage": norm(d["passage"]),
        "answer": norm(d["answer"]),
    }


@dataclass
class Target:
    """무엇을 위해 만든 문제인지. 다시 보기는 원래 문제, 맞춤 퀴즈는 'new'."""

    reason: Literal["wrong", "right", "new"]
    # 원래 문제의 정답. 비어 있으면 '틀린 낱말 다시 묻기' 검사를 하지 않음(short_answer('')는 False)
    answer: str = ""
    concept: str = ""
    used_answers: list[str] = field(default_factory=list)  # 이 세트에서 이미 쓴 정답
    # 지난번 맞혔어도 원래 정답을 다시 물음(오늘의 복습이 결함 문제를 같은 낱말로 바꿀 때). 이때는
    # 오늘의 복습의 같은 낱말 기준(text.same_word: 띄어쓰기만 다른 똑같은 답)으로 봅니다
    keep_answer: bool = False


def too_close(d: Draft, seen: list[Seen]) -> bool:
    """이미 있는 문제와 85% 이상 같음.

    둘 다 제시문이 있으면 제시문끼리만 비교합니다. 문제 글은 tidy가 같은 문장으로 맞추기도 해서,
    문제 글까지 합쳐 비교하면 제시문이 짧은 다른 문제('쌓다' / '계약을 성공하다')도 같다고 봤습니다
    (로컬 DB 116문제에서 바뀐 판정은 이 1쌍, 10/27 측정).
    """
    me = norm(d["stem"] + d["passage"])
    mp = norm(d["passage"])
    for s in seen:
        if mp and s["passage"]:
            if difflib.SequenceMatcher(None, mp, s["passage"]).ratio() >= 0.85:
                return True
        elif difflib.SequenceMatcher(None, me, s["all"]).ratio() >= 0.85:
            return True
    return False


def reversed_of(d: Draft, seen: list[Seen]) -> bool:
    """이번에 만든 앞 문제를 거꾸로 물음 (미생 시험).

    '무산소성 세균 → 산소 없이 증식한다' 다음에 '산소 없이 증식하는 세균 → 무산소성 세균'.
    저장된 문제(q가 있음)는 보지 않습니다.
    """
    a, p = norm(d["answer"]), norm(d["passage"])
    for s in seen:
        if s.get("q") is not None or not s.get("answer"):
            continue
        sa = s.get("answer", "")
        if a and s["passage"] and difflib.SequenceMatcher(None, a, s["passage"]).ratio() >= 0.8:
            return True
        if p and difflib.SequenceMatcher(None, p, sa).ratio() >= 0.8:
            return True
    return False


def number_spans(s: str) -> list[tuple[int, int, list[Decimal]]]:
    """s 안의 수마다 (시작, 끝, 값). 위치를 쓰려면 s는 NFC이고 쉼표가 없어야 합니다
    (number_values는 쉼표를 지우고 읽음). 값을 읽지 못한 지수는 빈 목록입니다."""
    return [(*m.span(), number_values(m.group(0))[0]) for m in VALUE.finditer(s)]


def same_value(a: str, b: str) -> bool:
    """같은 값을 다른 꼴로 쓴 두 보기 (350,000 CFU/mL과 3.5×10^5 CFU/mL, 미생 시험).

    수를 뺀 나머지 글이 같고 수가 모두 같을 때만입니다. 문장 속에 우연히 같은 수가 있는
    보기('… carrying 2 boxes' / '… opening 2 boxes')나 '37℃에서 24시간' / '37℃에서 48시간'은
    다른 보기입니다.
    """
    return _same_parsed(number_values(a), number_values(b))


def _same_parsed(a: tuple[list[Decimal], str], b: tuple[list[Decimal], str]) -> bool:
    return bool(a[0]) and a == b


def option_key(o: str) -> tuple[str, tuple[Decimal, ...]]:
    """보기 · 정답이 같은지 볼 때 쓰는 키: norm(대소문자 · 문장부호 무시)에 적힌 수를 더함.

    norm은 '.' · '-'를 지우므로 수까지 따로 보지 않으면 '1.5 mL'과 '15 mL',
    '-20℃'와 '20℃'가 같은 보기가 됩니다. 'No.5'와 'No. 5'는 같은 보기입니다.
    """
    return norm(o), tuple(number_values(o)[0])


def form(w: str | None) -> Literal["ing", "ed", "base"]:
    """끝 글자로 본 낱말 형태.

    알려진 한계: 끝 글자만 보므로 proceed · need는 -ed, ceiling · thing은 -ing로 봅니다(#12).
    """
    w = (w or "").strip().lower()
    return "ing" if w.endswith("ing") else "ed" if w.endswith("ed") else "base"


def form_giveaway(d: Draft) -> bool:
    """정답만 형태가 달라 문법만 보고 풀리는 빈칸 (오늘의 복습 10/23).

    'The staff is ____ the products'에 organizing / clothing / adjust / counter.
    오답 중 둘 이상이 정답과 같은 형태여야 합니다. 영어 한 낱말 보기만 봅니다
    ('String of pearl'은 -ing 형태가 아님).
    """
    answer_key = option_key(d["answer"])
    opts = [o for o in d["options"] if option_key(o) != answer_key]
    if not all(re.fullmatch(r"[A-Za-z][A-Za-z'\-]*", o.strip()) for o in [*opts, d["answer"]]):
        return False
    return sum(form(o) == form(d["answer"]) for o in opts) < 2


def _joined(i: int, opts: list[str], keys: list[tuple[str, tuple[Decimal, ...]]]) -> bool:
    """보기 i가 다른 보기 셋 이상을 쉼표로 이어 붙인 것. keys는 보기마다 option_key.

    쉼표 뒤에 띄어쓰기가 있을 때만 나눔(1,000 · 2,000은 한 조각). 쉼표로 나뉘는 보기가 둘
    이상이거나 조각이 모두 한 글자면 조합 문제(ㄱ, ㄴ · I, II, III · 산소, 질소, 수소)라 뺌."""
    if sum(len(_PIECE.split(o)) > 1 for o in opts) > 1:
        return False
    parts = _PIECE.split(opts[i])
    # 조각이 모두 한 글자면 조합 보기가 하나여도 문제 모양(ㄱ, ㄴ, ㄷ. · Codex #136)
    if len(parts) < 3 or all(len(norm(x)) <= 1 for x in parts):
        return False
    others = {k for j, k in enumerate(keys) if j != i}
    return sum(option_key(x.strip()) in others for x in parts) >= 3


def code_check(
    d: Draft, t: Target, page_text: str, ty: str, seen: list[Seen]
) -> tuple[list[str], int | None]:
    """(탈락 이유, 정답 보기 위치). 이유가 비어 있으면 통과."""
    why: list[str] = []
    opts = d["options"]
    keys = [option_key(o) for o in opts]
    if len(opts) != CHOICES or len(set(keys)) != CHOICES:
        why.append(f"보기 {CHOICES}개가 아니거나 겹침")
    # 다섯째 보기가 나머지를 이어 붙인 'TXY 다이어그램, 에탄올 상태 변화, …'(화공양론, 11/06),
    # 'stacked, fastened, extended, docked'(토익)가 모든 검사를 통과함. 조각이 다른 보기와
    # 똑같을 때만 봄: 글자가 안에 들어 있기만 한 H2O · H2O2, 15 · 1.5, ㄱ · ㄱ, ㄴ은 좋은 보기
    if any(_joined(i, opts, keys) for i in range(len(opts))):
        why.append("다른 보기를 이어 붙인 보기")
    parsed = [number_values(o) for o in opts]
    if any(_same_parsed(a, b) for i, a in enumerate(parsed) for b in parsed[i + 1 :]):
        why.append("값이 같은 숫자 보기")
    answer_key = option_key(d["answer"])
    hits = [i for i, o in enumerate(opts) if option_key(o) == answer_key]
    if len(hits) != 1:
        why.append("정답 글이 보기와 안 맞음")
    p = d["passage"].strip()
    if ty == "빈칸" and "____" not in p:
        why.append("빈칸 문장 없음")
    # 정답 하나는 빈칸 하나를 채움: '방법은 ____, ____, ____ 등이 있습니다'에 정답 도말법이
    # 모든 검사를 통과함(기생충, 11/01). 코드의 빈 ()·[](useState() · () => · [])는 text.BLANK가
    # 빈칸으로 보지 않아 유형과 상관없이 봄(/code-review #94)
    if len(BLANK.findall(p)) > 1:
        why.append("빈칸이 여러 개")
    # 요청한 유형이 아니라 모양으로 판단: '어휘' 초안이 빈칸 문장으로 오기도 함
    # ('The rope was ____ to the post'에 fastened와 -ing 낱말 넷, 10/26)
    if "____" in p and form_giveaway(d):
        why.append("형태만 보고 정답이 보임(오답 보기를 정답과 같은 형태로)")
    # 분류 문제를 끝 글자로 가리는 검사는 두지 않음: 기생충에서 본 이름(편모충류 · 대변 검사)에
    # 맞춘 규칙이라 '표고버섯 → 균류'(동물 · 식물 · 원생생물 · 원핵생물)도 버렸음(Codex 재리뷰 #94).
    # 정답만 분류 이름인 보기는 과목과 상관없이 품질 검사에서 볼 일(퀴즈 속도 개선 작업)
    # 토익 유형만: 한국어 문장의 빈칸은 정상적인 정의 문제 (React Native 강의, 10/25)
    if "____" in p and ty not in KO_TYPES and _KO.search(p):
        why.append("빈칸 문장에 한국어 뜻 노출")
    if ty == "묘사" and not _KO.search(p):
        why.append("장면 설명 없음")
    if ty == "묘사" and re.search(r"[A-Za-z]+(?:\s+[A-Za-z']+){2,}", p):
        why.append("장면 설명에 영어 문장이 섞임")
    if ty == "어휘" and len(p) < 2:
        why.append("물을 뜻 없음")
    if ty == "정의" and len(re.findall(r"[가-힣]", p)) < 10:
        why.append("설명 문장 없음")
    # passage가 '____'뿐이어도 용어가 아님: 미생 초안 9개가 지식 검사에 '용어: ____'로 감(10/29)
    if ty in ("특징", "분류") and not (1 <= len(BLANK.sub("", p).strip()) <= 40):
        why.append("물을 용어 없음")
    if ty == "정의" and p and norm(d["answer"]) in norm(p):
        why.append("설명에 정답 용어 노출")
    if NEGATIVE.search(d["stem"]):
        why.append("부정 질문")
    if not _KO.search(d["stem"]):
        why.append("문제 글이 한국어가 아님")
    # 특징 · 분류도: '____는 산소가 없는 환경에서 살아가는 세균'에
    # 정답 '산소가 없는 환경에서 살아간다' (미생, 10/25)
    # 한국어 어미(살아간다 / 살아가는)를 떼고 비교
    a = norm(d["answer"])
    if (
        ty in ("어휘", "빈칸", "묘사", "특징", "분류")
        and p
        and a
        and (a in norm(p) or (len(a) >= 8 and re.search(r"[가-힣]$", a) and a[:-2] in norm(p)))
    ):
        why.append("제시문에 정답 노출")
    # 한국어 규칙 문장은 원래 말을 바꿔 쓰므로 낱말 대조 대신 검수자 검사에 맡김
    if short_answer(d["answer"]) or not _KO.search(d["answer"]):
        ts, page = terms(d["answer"]), norm(page_text)
        if ts and sum(norm(x) in page for x in ts) / len(ts) < 0.5:
            why.append("정답이 노트에 없음")
    # 개념 이름에 적힌 낱말은 같은 개념을 묻는 것으로 봄
    # ('divide, separate, arrange의 유의어'에서 organizing 대신 arranging)
    in_concept = any(
        same_item(d["answer"], w) for w in re.findall(r"[A-Za-z][A-Za-z\-']+", t.concept)
    )
    # keep_answer: 새 문제가 이 낱말의 복습을 이어 가므로 똑같은 답만(port → report, 개념 이름의
    # 다른 낱말도 안 됨). 오답 복습은 넓게(same_item · 개념 이름)
    same = (
        same_word(d["answer"], t.answer)
        if t.keep_answer
        else same_item(d["answer"], t.answer) or in_concept
    )
    if (t.reason == "wrong" or t.keep_answer) and short_answer(t.answer) and not same:
        kind = "틀린" if t.reason == "wrong" else "원래"
        why.append(f"{kind} 낱말('{t.answer}')을 다시 묻지 않음")
    if any(same_item(d["answer"], u) for u in t.used_answers):
        why.append("세트 안에서 정답이 겹침")
    if too_close(d, seen):
        why.append("이미 있는 문제와 거의 같음")
    if reversed_of(d, seen):
        why.append("앞 문제를 거꾸로 물음(겹침)")
    return why, (hits[0] if len(hits) == 1 else None)
