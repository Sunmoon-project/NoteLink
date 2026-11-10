"""퀴즈 서비스가 주고받는 모양. DB 팀 설계(노트 · 퀴즈 · AI)의 필드 이름을 따릅니다.

메인 서버가 ai_jobs.input에 담아 주는 값(Page · Question)과 LLM이 만든 문제 초안(Draft)입니다.
ObjectId는 문자열로 주고받습니다.
"""

from typing import NotRequired, TypedDict

from app.services.quiz.srs import Srs

CHOICES = 5  # 객관식은 모두 5지선다 (10/25)
LETTERS = "ABCDE"[:CHOICES]

# 노트 글: {materialId: {pageNo: 정리된 글}}
type Notes = dict[str, dict[int, str]]


class Page(TypedDict):
    """materials.pages 한 쪽. 확실하지 않은 낱말은 ocrText 안에 [?]로 표시돼 있음 (AI 계획 5-2)."""

    pageNo: int
    ocrText: str | None


class Question(TypedDict):
    """quiz_sets.questions 한 문제."""

    id: str
    order: int
    type: NotRequired[str | None]
    prompt: str
    passage: NotRequired[str | None]
    choices: list[str] | None  # 단답형 · 서술형은 null (DB 설계 검사 규칙 ['array', 'null'])
    answer: str
    explanation: NotRequired[str | None]
    conceptTags: NotRequired[list[str]]
    difficulty: NotRequired[str | None]  # 하 · 중 · 상(유형으로 정함, similar.difficulty_of, #268)
    srs: NotRequired[Srs | None]


class Draft(TypedDict):
    """LLM이 만든 문제 초안. 검사를 통과하면 Question으로 바뀜."""

    stem: str
    passage: str
    options: list[str]
    answer: str
    explanation: NotRequired[str | None]
    difficulty: NotRequired[str]
