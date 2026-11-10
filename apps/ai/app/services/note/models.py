"""노트 결과에서 주고받는 모양. 좌표는 쪽 크기 대비 0~1, 단어 상자(polygon)만 OCR 원래 단위."""

from typing import Literal, NotRequired, TypedDict

type MarkKind = Literal["color", "highlight", "symbol", "keyword"]
type FixStatus = Literal["auto", "review"]  # auto = 글에 넣음, review = 학생 확인 필요
type ConceptStatus = Literal["auto", "review"]


class Word(TypedDict):
    """OCR 단어. 한국어는 음절 하나가 단어 하나."""

    text: str
    start: int  # 줄 글자 안 위치
    end: int
    polygon: list[float]
    confidence: float
    hand: NotRequired[bool]  # 손글씨 단어 (인쇄 번호 뒤 손글씨처럼 한 줄에 섞일 수 있음)
    color: NotRequired[str]  # 글씨색
    colorDiff: NotRequired[bool]  # 손글씨 주된 색과 다름 = 강조
    baseColor: NotRequired[str]  # 손글씨 주된 색
    highlight: NotRequired[str]  # 형광펜 색


class Line(TypedDict):
    id: int  # 쪽 안 OCR 줄 번호(1부터)
    page: int
    text: str
    x0: float
    x1: float
    y0: float
    y1: float
    hand: bool  # 손글씨 줄
    words: list[Word]


class Row(TypedDict):
    """읽는 순서로 놓은 줄. 같은 높이의 OCR 줄 여러 개를 합친 것일 수 있음."""

    page: int
    lineIds: list[int]
    text: str
    x0: float
    x1: float
    y0: float
    y1: float
    hand: bool
    words: list[Word]


class PageLayout(TypedDict):
    pageNo: int
    twoColumn: bool
    rows: list[Row]


class PageText(TypedDict):
    """① 쪽별 원본 글자 (materials.pages)."""

    pageNo: int
    ocrText: str  # OCR 원문 + 흐린 낱말 앞 [?]


class OcrLine(TypedDict):
    """② OCR 줄 결과의 줄 하나."""

    text: str
    x0: float
    x1: float
    y: float  # 세로 가운데
    handwritten: bool
    conf: float  # 줄 안 낱말 신뢰도의 최솟값


class MarkBox(TypedDict):
    kind: Literal["check", "circle"]
    x0: float
    x1: float
    y0: float
    y1: float


class PageLines(TypedDict):
    """② OCR 줄 결과 한 쪽."""

    pageNo: int
    twoColumn: bool
    lines: list[OcrLine]
    marks: list[MarkBox]
    marksChecked: bool  # False = 찾지 않음 ('표시 없음'과 구분)


class Mark(TypedDict):
    """조각 글 안의 강조 구간."""

    kind: MarkKind
    start: int
    end: int
    color: NotRequired[str]
    baseColor: NotRequired[str]
    text: NotRequired[str]  # symbol · keyword에서 찾은 글자


class Emphasis(TypedDict):
    has: bool
    marks: list[Mark]


class PageRef(TypedDict):
    pageNo: int
    lineIds: list[int]


class Chunk(TypedDict):
    """④ 노트 조각 (note_chunks). userId · embedding 등은 저장할 때 붙임."""

    order: int
    title: str | None  # 제목 줄, 없으면 None
    path: list[str]  # 상위 제목
    text: str  # OCR 원문, 줄은 \n
    lines: list[PageRef]  # text 줄마다 원본 위치
    emphasis: Emphasis
    uncertainCount: int  # [?] 개수
    needsLlm: bool  # 코드로 못 나눈 긴 문단
    fixes: NotRequired[list["TypoFix"]]  # 오타 고침(후처리를 켰을 때만)
    concept: NotRequired[str | None]  # 개념 태그(사전 용어)
    conceptStatus: NotRequired[ConceptStatus | None]


class TypoFix(TypedDict):
    """OCR 오타 고침 하나. ① ocrText는 그대로 두고 ④ 조각 글에만 넣음."""

    order: int  # 조각 order
    word: str  # OCR 글자
    term: str  # 사전 용어
    sim: float  # 자모 유사도
    status: FixStatus
