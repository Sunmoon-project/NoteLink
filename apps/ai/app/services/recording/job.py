"""녹음 정리 작업(ai_jobs). audioUrl이면 STT부터, sentences면 STT 없이 정리부터(다시 정리하기).

input   {audioUrl, sizeBytes?, durationMs?} 또는 {sentences, durationMs}, 그리고 둘 다
        slidesUrl?: 강의 자료(.pptx · .ppt) 읽기 주소(SAS)
        notes?: [{title?, text}]  같은 폴더의 정리 끝난 필기 글(NestJS가 handwriting_summary 결과로)
result  {durationMs, transcript, sentences, slides, chunks, warnings,
         materialUsed: {slidePages, notes}}  LLM에 실제로 넣은 자료 수(없으면 0)

진행률 단계: (material 0, 강의 자료가 있을 때) stt 0→20, organize 20→90(창이 끝날 때마다),
embed 90→100.
거절은 InputError(코드가 있으면 앱이 구분), 일시 오류(LlmError · SpeechUnavailableError ·
EmbedUnavailableError)는 그대로 올립니다. 오류 문구에 녹음 · 자료 주소(SAS)를 넣지 않습니다.
자료(강의 자료 · 필기)는 형식이 틀리면 InputError지만, 파일을 받지 · 읽지 못하거나 상한을 넘는
것은 실패가 아니라 warnings에 남기고 녹음 대본만으로(또는 줄인 자료로) 정리합니다:
  {code: NO_SLIDES, reason: download | format | parse | empty | size}
  {code: MATERIAL_TRIMMED, reason: slides | notes | embed}
STT가 끝나면 다시 정리하기 input과 같은 모양 {sentences, durationMs}을 checkpoint에 저장하고,
다시 시도할 때 값이 검사를 통과하면 STT를 건너뜁니다(과금 · SAS 만료를 피함). 강의 자료가 있으면
뽑은 쪽 글과 그 경고 {material, materialWarnings}도 함께 저장해 다시 받지 않습니다(다시 정리하기
에서는 이것만 저장).
"""

import logging
import time
from collections.abc import Callable
from typing import Protocol, TypeIs, get_args

from app.clients.llm import JsonObject, Llm
from app.clients.speech import NoSpeechError, SpeechError, SpeechUnavailableError, Transcript
from app.core.config import settings
from app.services.recording.material import (
    NOTE_MAX_CHARS,
    NOTE_TITLE_MAX_CHARS,
    NOTES_MAX,
    Embedder,
    Material,
    NoteText,
    Trimmed,
)
from app.services.recording.models import Chunk, Sentence, SentenceWord, Slide
from app.services.recording.pipeline import organize, sentences_from
from app.services.recording.slides import (
    PAGE_MAX_CHARS,
    SLIDES_MAX_CHARS,
    NoSlidesReason,
    Page,
    SlidesWarning,
    clean,
    download_slides,
    read_slides,
)

__all__ = ["Embedder", "InputError", "Transcriber", "run"]

log = logging.getLogger(__name__)

TYPE = "recording_summary"
RECORDING_MAX_MS = 2 * 60 * 60 * 1000  # 처리하는 녹음의 최대 길이(2시간)
RECORDING_MIN_MS = 3 * 60 * 1000  # FR-20-26
RECORDING_MAX_BYTES = 250_000_000  # Azure 빠른 전사 REST 한도
RECORDING_MAX_CHARS = 230_400  # 2시간 × 초당 약 8자의 4배. 빠른 말도 넉넉히 들어가는 대본 길이
INVALID_FILE = "INVALID_FILE"
NO_SPEECH = "NO_SPEECH"
ORGANIZE_START = 20
ORGANIZE_END = 90


class InputError(ValueError):
    """녹음이나 input이 작업에 맞지 않음. 다시 해도 같음. 메시지는 앱에 보이는 짧은 원인."""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


class Report(Protocol):
    def __call__(self, value: int, step: str | None = None) -> None: ...


class Checkpoint(Protocol):
    def load_checkpoint(self) -> object: ...

    def save_checkpoint(self, value: JsonObject) -> None: ...


class Transcriber(Protocol):
    def transcribe(self, audio_url: str) -> Transcript: ...


type _Slides = tuple[list[Page], list[SlidesWarning]]


class _Source:
    """강의 자료를 읽는 방법. slides_url이 없으면 읽지 않음."""

    def __init__(
        self, slides_url: str | None, fetch: Callable[[str], bytes], report: Report
    ) -> None:
        self.slides_url, self._fetch, self._report = slides_url, fetch, report

    def read(self) -> _Slides:
        if self.slides_url is None:
            return [], []
        self._report(0, "material")
        return read_slides(self.slides_url, self._fetch)


def run(
    llm: Llm,
    speech: Callable[[], Transcriber],
    embedder: Embedder,
    inp: JsonObject,
    report: Report,
    *,
    checkpoint: Checkpoint | None = None,
    clock: Callable[[], float] = time.monotonic,
    fetch: Callable[[str], bytes] = download_slides,
) -> JsonObject:
    """speech는 STT를 할 때만 만듭니다. 다시 정리하기에는 음성 설정이 필요 없게.

    fetch는 강의 자료를 내려받음(시험에서 바꿈). embedder는 조각 임베딩과, 자료가 상한을 넘을 때
    창마다 자료를 고르는 데 씁니다.
    """
    audio_url, saved = inp.get("audioUrl"), inp.get("sentences")
    if (audio_url is None) == (saved is None):
        raise InputError("input에 audioUrl과 sentences 중 하나만 있어야 함")
    source = _Source(_slides_url(inp), fetch, report)
    notes, note_warnings = _notes(inp.get("notes"))
    deadline = clock() + settings.recording_job_max_sec
    if audio_url is not None:
        sentences, duration_ms, slides = _from_audio(
            speech, audio_url, inp, report, source, checkpoint
        )
    else:
        sentences, duration_ms = _from_saved(saved, inp)
        slides = _slides_again(source, checkpoint)
    pages, slide_warnings = slides
    material = Material(pages, notes, embedder)
    report(ORGANIZE_START, "organize")

    def on_window(done: int, total: int) -> None:
        span = ORGANIZE_END - ORGANIZE_START
        report(ORGANIZE_START + span * done // total, "organize")

    result = organize(
        llm,
        sentences,
        duration_ms,
        on_window=on_window,
        should_stop=lambda: clock() >= deadline,
        material=material,
    )
    report(ORGANIZE_END, "embed")
    chunks = _chunks(embedder, sentences, result["slides"])
    report(100, "embed")
    warnings = [
        *slide_warnings,
        *note_warnings,
        *material.warnings,
        *result.get("warnings", []),
    ]
    return {
        **result,
        "warnings": warnings,
        "materialUsed": material.used(),
        "chunks": chunks,
    }


# ---------------------------------------------------------------- 자료 input


def _slides_url(inp: JsonObject) -> str | None:
    url = inp.get("slidesUrl")
    if url is None:
        return None
    if not isinstance(url, str) or not url.strip():
        raise InputError("input.slidesUrl이 글자가 아님")
    return url


def _notes(raw: object) -> tuple[list[NoteText], list[Trimmed]]:
    """필기 글. 형식이 틀리면 InputError, 개수 · 길이 상한을 넘으면 앞에서부터 줄이고 경고."""
    if raw is None:
        return [], []
    if not isinstance(raw, list):
        raise InputError("input.notes가 목록이 아님")
    for i, note in enumerate(raw):
        title = note.get("title") if isinstance(note, dict) else None
        if (
            not isinstance(note, dict)
            or not isinstance(note.get("text"), str)
            or (title is not None and not isinstance(title, str))
        ):
            raise InputError(f"input.notes[{i}] 모양이 맞지 않음")
    trimmed = len(raw) > NOTES_MAX
    out: list[NoteText] = []
    for note in raw[:NOTES_MAX]:
        text = "\n".join(line for line in map(clean, note["text"].splitlines()) if line)
        if not text:
            continue
        if len(text) > NOTE_MAX_CHARS:
            text, trimmed = text[:NOTE_MAX_CHARS], True
        out.append({"title": clean(note.get("title") or "")[:NOTE_TITLE_MAX_CHARS], "text": text})
    warnings: list[Trimmed] = [{"code": "MATERIAL_TRIMMED", "reason": "notes"}] if trimmed else []
    return out, warnings


def _slides_again(source: _Source, checkpoint: Checkpoint | None) -> _Slides:
    """다시 정리하기: 저장한 자료가 있으면 쓰고, 없으면 읽어 자료만 저장."""
    if source.slides_url is None:
        return [], []
    if checkpoint is not None:
        saved = checkpoint.load_checkpoint()
        if isinstance(saved, dict) and "material" in saved:
            try:
                return _saved_slides(saved)
            except InputError as e:
                log.warning("저장된 강의 자료가 깨져 다시 읽음: %s", e)
    slides = source.read()
    if checkpoint is not None:
        checkpoint.save_checkpoint(_slides_checkpoint(slides))
    return slides


def _slides_checkpoint(slides: _Slides) -> JsonObject:
    pages, warnings = slides
    return {"material": pages, "materialWarnings": warnings}


def _saved_slides(saved: dict[str, object]) -> _Slides:
    """checkpoint의 {material, materialWarnings}. 모양이 틀리면 InputError."""
    raw, raw_warnings = saved.get("material"), saved.get("materialWarnings")
    if not isinstance(raw, list) or not isinstance(raw_warnings, list):
        raise InputError("material · materialWarnings가 목록이 아님")
    pages: list[Page] = []
    for i, p in enumerate(raw):
        page_no = p.get("pageNo") if isinstance(p, dict) else None
        text = p.get("text") if isinstance(p, dict) else None
        if (
            not isinstance(p, dict)
            or set(p) != {"pageNo", "text"}
            or not _is_count(page_no)
            or page_no <= (pages[-1]["pageNo"] if pages else 0)
            or not isinstance(text, str)
            or not text.strip()
            or len(text) > PAGE_MAX_CHARS
        ):
            raise InputError(f"material[{i}] 모양이 맞지 않음")
        pages.append({"pageNo": page_no, "text": text})
    if sum(len(p["text"]) for p in pages) > SLIDES_MAX_CHARS:
        raise InputError("material이 너무 김")
    warnings: list[SlidesWarning] = []
    for i, w in enumerate(raw_warnings):
        reason = w.get("reason") if isinstance(w, dict) else None
        if not isinstance(w, dict) or set(w) != {"code", "reason"}:
            raise InputError(f"materialWarnings[{i}] 모양이 맞지 않음")
        if w.get("code") == "NO_SLIDES" and _is_no_slides(reason):
            warnings.append({"code": "NO_SLIDES", "reason": reason})
        elif w.get("code") == "MATERIAL_TRIMMED" and reason == "slides":
            warnings.append({"code": "MATERIAL_TRIMMED", "reason": "slides"})
        else:
            raise InputError(f"materialWarnings[{i}] 모양이 맞지 않음")
    return pages, warnings


def _is_no_slides(value: object) -> TypeIs[NoSlidesReason]:
    return value in get_args(NoSlidesReason.__value__)


# ---------------------------------------------------------------- 녹음


def _from_audio(
    speech: Callable[[], Transcriber],
    audio_url: object,
    inp: JsonObject,
    report: Report,
    source: _Source,
    checkpoint: Checkpoint | None,
) -> tuple[list[Sentence], int, _Slides]:
    if not isinstance(audio_url, str) or not audio_url.strip():
        raise InputError("input.audioUrl이 글자가 아님")
    size_bytes = _optional_count(inp, "sizeBytes")
    duration_ms = _optional_count(inp, "durationMs")
    if size_bytes is not None:
        _check_size(size_bytes)
    if duration_ms is not None:
        _check_duration(duration_ms)
    if checkpoint is not None:
        reused = _from_checkpoint(checkpoint.load_checkpoint(), source.slides_url is not None)
        if reused is not None:
            sentences, actual_ms, kept = reused
            if kept is not None:
                return sentences, actual_ms, kept
            # 강의 자료를 넣기 전에 저장한 인식 결과: 자료만 읽어 함께 저장
            slides = source.read()
            checkpoint.save_checkpoint(_audio_checkpoint(sentences, actual_ms, source, slides))
            return sentences, actual_ms, slides
    client = speech()  # 설정 누락은 파일 문제가 아니므로 아래 except 밖에서
    slides = source.read()
    report(0, "stt")
    try:
        transcript = client.transcribe(audio_url)
    except SpeechUnavailableError:
        raise
    except NoSpeechError as e:
        raise InputError(str(e), code=NO_SPEECH) from e
    except SpeechError as e:
        raise InputError(f"음성 인식 실패({e})", code=INVALID_FILE) from e
    sentences = sentences_from(transcript)
    # 문장 끝이 STT 길이를 조금 넘을 수 있음. 이 값을 저장해야 다시 정리하기가 통과함
    actual_ms = max(transcript.duration_ms, *(s["endMs"] for s in sentences))
    _check_duration(actual_ms)
    _check_chars(sentences)
    if checkpoint is not None:
        checkpoint.save_checkpoint(_audio_checkpoint(sentences, actual_ms, source, slides))
    return sentences, actual_ms, slides


def _audio_checkpoint(
    sentences: list[Sentence], duration_ms: int, source: _Source, slides: _Slides
) -> JsonObject:
    saved: JsonObject = {"sentences": sentences, "durationMs": duration_ms}
    if source.slides_url is not None:
        saved.update(_slides_checkpoint(slides))
    return saved


def _from_checkpoint(
    saved: object, with_slides: bool
) -> tuple[list[Sentence], int, _Slides | None] | None:
    """다시 정리하기 input과 같은 검사를 합니다. 없거나 깨져 있으면 None(STT부터 다시).

    강의 자료가 있는 작업이면 저장한 자료도 검사해 돌려줍니다. 자료 항목이 없으면(자료를 넣기
    전에 저장) 자료 자리는 None, 있는데 깨졌으면 전체를 None으로 봅니다.
    """
    if saved is None:
        return None
    if not isinstance(saved, dict):
        log.warning("저장된 인식 결과가 객체가 아니라 STT부터 다시 함")
        return None
    try:
        sentences, duration_ms = _from_saved(saved.get("sentences"), saved)
        slides = _saved_slides(saved) if with_slides and "material" in saved else None
    except InputError as e:
        log.warning("저장된 인식 결과가 깨져 STT부터 다시 함: %s", e)
        return None
    if with_slides:
        return sentences, duration_ms, slides
    return sentences, duration_ms, ([], [])


def _from_saved(saved: object, inp: JsonObject) -> tuple[list[Sentence], int]:
    duration_ms = _optional_count(inp, "durationMs")
    if duration_ms is None:
        raise InputError("input.durationMs가 없음")
    if not isinstance(saved, list) or not saved:
        raise InputError("input.sentences가 비어 있거나 목록이 아님")
    sentences = [_saved_sentence(raw, i) for i, raw in enumerate(saved)]
    for i, (prev, cur) in enumerate(zip(sentences, sentences[1:], strict=False), 1):
        if cur["startMs"] < prev["startMs"]:
            raise InputError(f"input.sentences[{i}] 시각 순서가 맞지 않음")
    _check_duration(duration_ms)
    # durationMs를 작게 줘도 상한을 넘지 못하게 실제 시각과 맞춰 봄
    if max(s["endMs"] for s in sentences) > duration_ms:
        raise InputError("문장 시각이 녹음 길이를 넘음", code=INVALID_FILE)
    _check_chars(sentences)
    return sentences, duration_ms


def _saved_sentence(raw: object, i: int) -> Sentence:
    error = InputError(f"input.sentences[{i}] 모양이 맞지 않음")
    if not isinstance(raw, dict):
        raise error
    text, start, end, words = (
        raw.get("text"),
        raw.get("startMs"),
        raw.get("endMs"),
        raw.get("words"),
    )
    if not isinstance(text, str) or not text.strip():
        raise error
    if not _is_count(start) or not _is_count(end) or start > end:
        raise error
    if not isinstance(words, list) or not all(_is_word(w) for w in words):
        raise error
    kept: list[SentenceWord] = [
        {"text": w["text"], "startMs": w["startMs"], "endMs": w["endMs"]} for w in words
    ]
    return {"text": text, "startMs": start, "endMs": end, "words": kept}


def _is_word(raw: object) -> bool:
    if not isinstance(raw, dict) or not isinstance(raw.get("text"), str):
        return False
    start, end = raw.get("startMs"), raw.get("endMs")
    return _is_count(start) and _is_count(end) and start <= end


def _is_count(value: object) -> TypeIs[int]:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _optional_count(inp: JsonObject, key: str) -> int | None:
    value = inp.get(key)
    if value is None:
        return None
    if not _is_count(value):
        raise InputError(f"input.{key}가 0 이상의 정수가 아님")
    return value


def _check_size(size_bytes: int) -> None:
    if size_bytes == 0:
        raise InputError("녹음 파일이 비어 있음", code=INVALID_FILE)
    if size_bytes > RECORDING_MAX_BYTES:
        raise InputError("녹음 파일이 250MB를 넘음", code=INVALID_FILE)


def _check_duration(duration_ms: int) -> None:
    if duration_ms > RECORDING_MAX_MS:
        raise InputError("녹음이 2시간을 넘음", code=INVALID_FILE)
    if duration_ms < RECORDING_MIN_MS:
        raise InputError("녹음이 3분보다 짧음", code=INVALID_FILE)


def _check_chars(sentences: list[Sentence]) -> None:
    if sum(len(s["text"]) for s in sentences) > RECORDING_MAX_CHARS:
        raise InputError("대본이 너무 김", code=INVALID_FILE)


def _chunks(embedder: Embedder, sentences: list[Sentence], slides: list[Slide]) -> list[Chunk]:
    """슬라이드 하나가 조각 하나. 짧은 슬라이드도 문맥이 남게 제목을 앞에 붙임."""
    texts = [
        "\n".join(
            [s["title"], *(x["text"] for x in sentences[s["sentenceStart"] : s["sentenceEnd"]])]
        )
        for s in slides
    ]
    vectors = embedder.embed(texts, "document")
    return [
        {
            "order": i,
            "slideIndex": i,
            "startMs": slide["startMs"],
            "endMs": slide["endMs"],
            "text": text,
            "embedding": vector,
        }
        for i, (slide, text, vector) in enumerate(zip(slides, texts, vectors, strict=True))
    ]
