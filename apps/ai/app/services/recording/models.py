"""녹음 정리 결과의 모양. ai_jobs.result에 JSON으로 들어갑니다. 시각은 녹음 시작부터의 밀리초."""

from typing import Literal, TypedDict

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


class RecordingResult(TypedDict):
    durationMs: int
    transcript: str  # 전체 대본
    sentences: list[Sentence]
    slides: list[Slide]
