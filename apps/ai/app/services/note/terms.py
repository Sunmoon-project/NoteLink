"""노트 후처리용 용어 사전 도구.

OCR 오타는 한글 글자 수가 같은 경우가 대부분이라(기생충 노트 실험 115개 중 114개),
후보는 같은 글자 수 용어 중 자모가 비슷한 것만 냄.
"""

import re
import unicodedata
from collections import defaultdict
from collections.abc import Iterable
from functools import cache
from typing import Any

NEAR_MIN = 0.6  # 후보로 낼 자모 유사도 하한
NEAR_K = 5
COMMON_SCORE = -16.0  # Kiwi 단일 명사 점수가 이보다 높으면 이미 있는 보통 낱말

_HANGUL = re.compile(r"[가-힣]")
_KEEP = re.compile(r"[^가-힣A-Za-z0-9]")


def syllables(word: str) -> int:
    """한글 글자 수 (띄어쓰기 · 영문 · 숫자 제외)."""
    return len(_HANGUL.findall(word))


def jamo(word: str) -> str:
    return unicodedata.normalize("NFD", _KEEP.sub("", word))


def similarity(a: str, b: str) -> float:
    """자모 단위 편집 거리로 잰 유사도(0~1)."""
    ja, jb = jamo(a), jamo(b)
    prev = list(range(len(jb) + 1))
    for i, ca in enumerate(ja, 1):
        cur = [i]
        for j, cb in enumerate(jb, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return 1 - prev[-1] / max(len(ja), len(jb), 1)


def letters_alike(a: str, b: str) -> bool:
    """한글 글자 수가 같고 같은 자리 글자끼리 자모가 하나 이상 같음(OCR 오타 꼴)."""
    sa, sb = _HANGUL.findall(a), _HANGUL.findall(b)
    if not sa or len(sa) != len(sb):
        return False
    return all(set(jamo(x)) & set(jamo(y)) for x, y in zip(sa, sb, strict=True))


class TermDict:
    """과목 용어 목록(시드). 같은 글자 수끼리 묶어 두고 비슷한 용어를 찾음."""

    def __init__(self, terms: Iterable[str]) -> None:
        self.terms = list(dict.fromkeys(t.replace(" ", "") for t in terms if syllables(t)))
        self._jamo = {jamo(t) for t in self.terms}
        self._by_len: dict[int, list[str]] = defaultdict(list)
        for t in self.terms:
            self._by_len[syllables(t)].append(t)

    def __contains__(self, word: object) -> bool:
        return isinstance(word, str) and jamo(word) in self._jamo

    def __len__(self) -> int:
        return len(self.terms)

    def near(self, word: str, k: int = NEAR_K, min_sim: float = NEAR_MIN) -> list[str]:
        """글자 수가 같고 자모가 비슷한 용어, 비슷한 순."""
        scored = [(t, similarity(word, t)) for t in self._by_len.get(syllables(word), [])]
        return [t for t, s in sorted(scored, key=lambda x: -x[1]) if s >= min_sim][:k]

    def best(self, word: str) -> float:
        return max(
            (similarity(word, t) for t in self._by_len.get(syllables(word), [])), default=0.0
        )

    def nearest_any(self, word: str, min_sim: float) -> str | None:
        """글자 수가 달라도 되는 가장 비슷한 용어 (개념 이름 후보용)."""
        best = max(self.terms, key=lambda t: similarity(word, t), default=None)
        return best if best is not None and similarity(word, best) >= min_sim else None

    def found_in(self, text: str) -> list[str]:
        """글에 그대로 나온 용어(띄어쓰기 무시), 긴 것부터."""
        flat = text.replace(" ", "")
        return sorted(
            (t for t in self.terms if syllables(t) >= 2 and t in flat), key=lambda t: -len(t)
        )


@cache
def _kiwi() -> Any:
    from kiwipiepy import Kiwi  # type: ignore[import-untyped]  # 모델을 처음 쓸 때만 읽음

    return Kiwi()


def is_common(word: str) -> bool:
    """이미 있는 보통 낱말. 오타 후보에서 뺌."""
    toks = _kiwi().tokenize(word)
    return len(toks) == 1 and toks[0].tag.startswith("NN") and toks[0].score > COMMON_SCORE


def is_noun_like(word: str) -> bool:
    """동사 · 형용사 · 어미가 없고 부사 하나도 아닌 낱말.

    관형사는 허용: 오타가 관형사 + 명사로 읽히기도 함.
    """
    toks = _kiwi().tokenize(word)
    if len(toks) == 1 and toks[0].tag.startswith("MA"):
        return False
    return not any(t.tag.startswith(("V", "E", "IC")) for t in toks)
