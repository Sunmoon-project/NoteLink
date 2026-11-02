"""퀴즈 서비스 공용 도우미: 글 비교, 노트 정리, 문제가 나온 쪽 찾기, 초안 다듬기."""

import difflib
import re
import unicodedata

from app.services.quiz.models import CHOICES, Draft, Notes, Page, Question

BLANK = re.compile(r"_{3,}|\(\s*\)|\(\s{2,}\)|\[\s*\]")
_PUNCT = re.compile(r"[\s\-_.·:()\[\]'\"~/,!?]+")
_LABEL = re.compile(r"^\s*[\(\[]?([A-Ea-e])[\)\]\.:]\s*")
_KO_GLOSS = re.compile(r"\s*\([^()]*[가-힣][^()]*\)\s*$")
_KO_WORD = re.compile(r"[가-힣]{2,}")
_KO_SENTENCE_END = re.compile(r"(다|요|음|함)\.?$")


def norm(s: str | None) -> str:
    """비교용: 소문자, 공백 · 문장부호 제거, 한글 자모 합치기(NFC)."""
    return _PUNCT.sub("", unicodedata.normalize("NFC", s or "").lower())


def terms(s: str | None) -> list[str]:
    """쪽을 찾을 때 쓰는 낱말 조각: 영어 낱말 앞 5글자, 한글 낱말 앞 2글자 (어미 · 변형 무시)."""
    en = re.findall(r"[A-Za-z][A-Za-z\-']{2,}", s or "")
    ko = re.findall(r"[가-힣]{2,}", s or "")
    return [t[:5] for t in en] + [t[:2] for t in ko]


def clean_pages(pages: list[Page]) -> dict[int, str]:
    """{pageNo: 글}. 확실하지 않은 [?] 낱말이 있는 줄은 LLM에 보여 주지 않음.

    남은 글이 없는 쪽은 넣지 않습니다(빈 쪽이 출처로 골라지지 않게).
    """
    out: dict[int, str] = {}
    for p in pages:
        lines = (p["ocrText"] or "").split("\n")
        text = "\n".join(ln for ln in lines if ln.strip() and "[?]" not in ln)
        if text:
            out[p["pageNo"]] = text
    return out


def locate(q: Question, notes: Notes, prefer: str | None = None) -> tuple[str, int]:
    """문제가 나온 (materialId, pageNo)를 낱말로 찾습니다. DB에는 문제의 출처 쪽이 없습니다.

    정답(또는 어간: stacked ~ stack)이 있는 쪽이 먼저이고, 그다음은 보기 · 개념 · 해설 낱말 수.
    점수가 같으면 prefer(세트의 노트)를 고릅니다. 'be'처럼 짧은 정답은 거의 모든 쪽에 있어
    가산점을 주지 않고, 개념 · 해설 낱말(요청 · 동사원형)로 규칙이 적힌 쪽을 찾습니다
    (10/26: 1일차 1쪽이 아니라 9쪽). 오늘의 복습 세트는 여러 노트를 섞으므로 notes에는
    사용자의 노트를 모두 넣습니다(10/26: 2일차 낱말 span을 1일차에서 찾다 세 번 실패).
    """
    if not any(notes.values()):
        raise ValueError("찾을 노트 글이 없음")
    a = norm(q["answer"])
    stem = re.sub(r"(ing|ed|es|s)$", "", a)
    ts = terms(" ".join([q["answer"], *(q["choices"] or [])]))
    ts += terms(" ".join([*(q.get("conceptTags") or [])[:1], q.get("explanation") or ""]))

    def score(key: tuple[str, int]) -> tuple[int, bool]:
        t = norm(notes[key[0]][key[1]])
        has = len(a) > 3 and (a in t or (len(stem) >= 4 and stem in t))
        return 10 * has + sum(norm(x) in t for x in ts), key[0] == prefer

    return max(((mid, n) for mid, pages in notes.items() for n in pages), key=score)


def same_item(a: str | None, b: str | None) -> bool:
    """같은 낱말 · 표현으로 볼지: 한쪽이 다른 쪽을 품거나 75% 이상 비슷함.

    알려진 한계: 안에 들어 있기만 해도 같다고 봐서 be ~ because of, port ~ report처럼
    다른 낱말도 같게 볼 수 있습니다. 실제 풀이 기록으로 검증된 기준이라 그대로 두고,
    채점 세트로 측정하며 고칩니다(#9).
    """
    x, y = norm(a), norm(b)
    return bool(x and y) and (
        x in y or y in x or difflib.SequenceMatcher(None, x, y).ratio() >= 0.75
    )


def short_answer(a: str | None) -> bool:
    """문장이 아닌 낱말 · 짧은 표현(그대로 다시 물을 수 있는 것).

    한국어 용어(위상역전, 원충류)는 포함, 한국어 문장(…한다, …이다)은 제외. 빈 글은 답이 아님.
    알려진 한계: '결함' · '람다'처럼 문장 끝과 같은 글자로 끝나는 용어도 문장으로 봅니다(#9).
    """
    s = (a or "").strip()
    if not s or len(s.split()) > 4:
        return False
    if _KO_WORD.search(s):
        return len(s) <= 15 and not _KO_SENTENCE_END.search(s)
    return True


def tidy(d: Draft) -> Draft:
    """빈칸 표시를 ____로 통일하고 보기 앞 기호(A. (b) 등)를 뗍니다."""
    passage = BLANK.sub("____", d["passage"].strip())
    if "____" in passage:  # 영어 빈칸 문장 뒤에 괄호로 붙은 한국어 뜻풀이는 정답을 알려 줌
        passage = _KO_GLOSS.sub("", passage)
    stem = BLANK.sub("____", d["stem"])
    if "____" in passage and "뜻" in stem:  # 빈칸 문장인데 '한국어 뜻에 알맞은…'으로 물음
        stem = "다음 빈칸에 들어갈 가장 알맞은 표현을 고르시오."
    options = strip_labels(d["options"])
    answer = d["answer"]
    if options != [o.strip() for o in d["options"]]:  # 기호를 뗐으면 기호 붙은 정답도 같이 뗌
        bare = _LABEL.sub("", answer).strip()
        answer = bare if bare in options else answer
    return {**d, "stem": stem, "passage": passage, "options": options, "answer": answer}


def strip_labels(options: list[str]) -> list[str]:
    """보기가 모두 A, B, C… 순서로 기호를 달고 있을 때만 뗍니다(기호 뒤 띄어쓰기는 없어도 됨).

    'B. anthracis' · 'E. coli' 같은 학명의 첫 글자를 기호로 보고 지우지 않게 합니다.
    알려진 한계: 학명 다섯 개의 첫 글자가 마침 A~E 순서면 기호로 보고 뗍니다.
    """
    marks = [m.group(1).upper() if (m := _LABEL.match(o)) else "" for o in options]
    if not options or "".join(marks) != "ABCDE"[: len(options)]:
        return [o.strip() for o in options]
    return [_LABEL.sub("", o).strip() for o in options]


def place(opts: list[str], k: int, slot: int) -> tuple[list[str], int]:
    """정답(opts[k])을 모델이 둔 자리 대신 slot 번호에 따라 A~E에 고르게 놓습니다.

    보기가 5개보다 적으면 그 개수로 나눠 고르게 놓고, 실제로 놓인 자리를 돌려줍니다.
    """
    rest = [o for i, o in enumerate(opts) if i != k]
    target = slot % min(CHOICES, len(opts))
    return [*rest[:target], opts[k], *rest[target:]], target
