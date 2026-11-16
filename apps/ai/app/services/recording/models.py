"""녹음 정리 결과의 모양. ai_jobs.result에 JSON으로 들어갑니다. 시각은 녹음 시작부터의 밀리초."""

from typing import Literal, NotRequired, TypedDict

type DiagramKind = Literal["sequence", "contrast", "hierarchy", "cause", "list"]


class SentenceWord(TypedDict):
    text: str
    startMs: int
    endMs: int


class Sentence(TypedDict):
    text: str
    startMs: int
    endMs: int
    words: list[SentenceWord]


class Diagram(TypedDict):
    """도식의 구조. 그리는 것은 앱."""

    kind: DiagramKind
    terms: list[str]  # 짧은 핵심어
    relations: list[list[int]]  # [from, to]. terms 안 위치(0부터)


class Slide(TypedDict):
    startMs: int
    endMs: int
    sentenceStart: int  # sentences 안 위치(0부터)
    sentenceEnd: int  # 이 위치 앞까지
    title: str
    summary: str  # 2~3문장 설명. 한국어
    diagram: Diagram | None  # 도식이 맞지 않는 슬라이드는 None


class RecordingWarning(TypedDict):
    """실패가 아니라 결과와 함께 오는 경고."""

    code: Literal["PARTIAL"]
    untilMs: int  # 마지막 슬라이드의 끝


class RecordingResult(TypedDict):
    durationMs: int
    transcript: str  # 전체 대본
    sentences: list[Sentence]
    slides: list[Slide]
    warnings: NotRequired[list[RecordingWarning]]


class Chunk(TypedDict):
    """복습 재료로 쓰는 대본 조각. 슬라이드 하나가 조각 하나."""

    order: int
    slideIndex: int  # slides 안 위치(0부터)
    startMs: int
    endMs: int
    text: str  # 슬라이드 제목 + 원문 문장
    embedding: list[float]
