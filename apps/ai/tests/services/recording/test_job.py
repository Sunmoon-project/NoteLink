import json
import time
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

import bson
import mongomock
import pytest
from pydantic import SecretStr

from app.clients.llm import JsonObject, LlmCutError, LlmError, LlmRejectedError
from app.clients.speech import (
    NoSpeechError,
    Phrase,
    SpeechError,
    SpeechUnavailableError,
    Transcript,
    Word,
)
from app.clients.voyage import EmbedError, EmbedUnavailableError, InputType
from app.core.config import settings
from app.services.recording.job import (
    RECORDING_MAX_BYTES,
    RECORDING_MAX_CHARS,
    RECORDING_MAX_MS,
    RECORDING_MIN_MS,
    TYPE,
    InputError,
    Transcriber,
    run,
)
from app.services.recording.models import Sentence
from app.services.recording.pipeline import WINDOW_CHARS
from app.worker import handlers, runner
from app.worker.handlers import HANDLERS
from app.worker.jobs import JobGoneError, JobStore
from app.worker.runner import run_once
from tests.fakes import FakeLlm
from tests.services.recording.test_pipeline import SLIDES, PieceLlm, WindowLlm, item

T0 = datetime(2026, 11, 5, 1, 0, tzinfo=UTC)
AUDIO_URL = "https://blob.example.test/a.m4a?sig=secret-sas"
DURATION_MS = 600_000
MONGO_DOC_LIMIT = 16 * 1024 * 1024


def all_starts(ids: list[int]) -> list[int]:
    return list(range(1, len(ids) + 1))


def transcript(n: int = 4, *, gap_ms: int = 30_000, duration_ms: int = DURATION_MS) -> Transcript:
    return Transcript(
        duration_ms,
        tuple(Phrase(f"s{i} 문장", i * gap_ms, gap_ms - 100, ()) for i in range(n)),
    )


class FakeSpeech:
    def __init__(self, answer: Transcript | Exception | None = None) -> None:
        self.answer = answer if answer is not None else transcript()
        self.urls: list[str] = []

    def transcribe(self, audio_url: str) -> Transcript:
        self.urls.append(audio_url)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


class FakeVoyage:
    def __init__(self, error: Exception | None = None, *, dims: int = 2) -> None:
        self.error, self.dims = error, dims
        self.texts: list[str] = []
        self.input_types: list[InputType] = []

    def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        if self.error is not None:
            raise self.error
        self.texts += texts
        self.input_types.append(input_type)
        return [[i + 0.5] * self.dims for i in range(len(texts))]


def run_direct(
    inp: JsonObject,
    *,
    llm: Any = None,
    speech: FakeSpeech | None = None,
    voyage: FakeVoyage | None = None,
    report: Callable[[int, str | None], None] | None = None,
    clock: Callable[[], float] | None = None,
) -> JsonObject:
    def on_report(value: int, step: str | None = None) -> None:
        if report is not None:
            report(value, step)

    def make_speech() -> Transcriber:
        return speech if speech is not None else FakeSpeech()

    return run(
        llm if llm is not None else WindowLlm(all_starts),
        make_speech,
        voyage if voyage is not None else FakeVoyage(),
        inp,
        on_report,
        clock=clock if clock is not None else time.monotonic,
    )


def run_job(
    monkeypatch: pytest.MonkeyPatch,
    inp: object,
    *,
    llm: Any = None,
    speech: FakeSpeech | None = None,
    voyage: FakeVoyage | None = None,
) -> dict[str, Any]:
    """실제 runner · JobStore를 거쳐 ai_jobs 문서에 남은 결과를 돌려줍니다."""
    monkeypatch.setattr(handlers, "_llm", lambda: llm if llm is not None else WindowLlm(all_starts))
    monkeypatch.setattr(handlers, "_speech", lambda: speech if speech is not None else FakeSpeech())
    monkeypatch.setattr(handlers, "_voyage", lambda: voyage if voyage is not None else FakeVoyage())
    return queued_job_result(inp)


def queued_job(inp: object) -> Any:
    col: Any = mongomock.MongoClient(tz_aware=True).db.ai_jobs
    col.insert_one(
        {
            "_id": "j1",
            "type": TYPE,
            "status": "queued",
            "input": inp,
            "progress": 0,
            "attempts": 0,
            "result": None,
            "error": None,
            "createdAt": T0,
        }
    )
    return col


def queued_job_result(inp: object) -> dict[str, Any]:
    col = queued_job(inp)
    store = JobStore(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: T0)
    assert run_once(store, HANDLERS)
    doc: dict[str, Any] = col.find_one({"_id": "j1"})
    return doc


def saved_sentence(i: int = 0) -> Sentence:
    return {"text": f"s{i} 문장", "startMs": i * 30_000, "endMs": i * 30_000 + 29_900, "words": []}


def again_input(*sentences: object, duration_ms: object = DURATION_MS) -> JsonObject:
    return {"sentences": list(sentences or [saved_sentence()]), "durationMs": duration_ms}


# ---------- 등록 ----------


def test_job_type_is_shared_schema_name_and_registered() -> None:
    assert TYPE == "recording_summary"
    assert HANDLERS[TYPE] is handlers.recording_summary


def test_result_is_saved_through_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    speech = FakeSpeech()

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, speech=speech)

    assert (doc["status"], doc["progress"], doc["error"]) == ("succeeded", 100, None)
    assert speech.urls == [AUDIO_URL]
    result = doc["result"]
    assert [s["text"] for s in result["sentences"]] == [f"s{i} 문장" for i in range(4)]
    assert result["transcript"] == "\n".join(f"s{i} 문장" for i in range(4))
    assert result["durationMs"] == DURATION_MS
    assert len(result["slides"]) == 4
    assert result["warnings"] == []
    assert len(result["chunks"]) == 4


# ---------- input 모양 ----------


@pytest.mark.parametrize(
    "inp",
    [
        {},
        {"durationMs": DURATION_MS},
        {"audioUrl": None, "sentences": None},
        {"audioUrl": AUDIO_URL, "sentences": [saved_sentence()], "durationMs": DURATION_MS},
    ],
    ids=["none", "only-duration", "both-null", "both"],
)
def test_input_needs_exactly_one_source(monkeypatch: pytest.MonkeyPatch, inp: JsonObject) -> None:
    speech, llm = FakeSpeech(), FakeLlm()

    doc = run_job(monkeypatch, inp, speech=speech, llm=llm)

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"].startswith("입력 오류: ")
    assert speech.urls == []
    assert llm.calls == []


@pytest.mark.parametrize(
    "inp",
    [
        {"audioUrl": 3},
        {"audioUrl": "  "},
        {"audioUrl": ["주소"]},
        {"audioUrl": AUDIO_URL, "sizeBytes": "1"},
        {"audioUrl": AUDIO_URL, "sizeBytes": True},
        {"audioUrl": AUDIO_URL, "sizeBytes": -1},
        {"audioUrl": AUDIO_URL, "sizeBytes": 1.5},
        {"audioUrl": AUDIO_URL, "durationMs": "1"},
        {"audioUrl": AUDIO_URL, "durationMs": 300_000.5},
        {"audioUrl": AUDIO_URL, "durationMs": -1},
        {"sentences": "글", "durationMs": DURATION_MS},
        {"sentences": [], "durationMs": DURATION_MS},
        {"sentences": [saved_sentence()]},
        {"sentences": [saved_sentence()], "durationMs": "1"},
        {"sentences": [saved_sentence()], "durationMs": True},
    ],
)
def test_bad_input_shape_fails_without_calling_anything(
    monkeypatch: pytest.MonkeyPatch, inp: JsonObject
) -> None:
    speech, llm = FakeSpeech(), FakeLlm()

    doc = run_job(monkeypatch, inp, speech=speech, llm=llm)

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"].startswith("입력 오류: ")
    assert speech.urls == []
    assert llm.calls == []


@pytest.mark.parametrize(
    "change",
    [
        {"text": 3},
        {"text": "  "},
        {"text": None},
        {"startMs": "0"},
        {"startMs": 0.5},
        {"startMs": True},
        {"startMs": -1},
        {"endMs": None},
        {"startMs": 2000, "endMs": 1000},
        {"words": None},
        {"words": "글"},
        {"words": ["글"]},
        {"words": [{"text": 1, "startMs": 0, "endMs": 1}]},
        {"words": [{"text": "가", "startMs": 5, "endMs": 1}]},
        {"words": [{"text": "가", "startMs": "0", "endMs": 1}]},
    ],
)
def test_each_saved_sentence_is_checked(
    monkeypatch: pytest.MonkeyPatch, change: dict[str, object]
) -> None:
    bad: dict[str, object] = {**saved_sentence(1), **change}
    llm = FakeLlm()

    doc = run_job(monkeypatch, again_input(saved_sentence(), bad), llm=llm)

    assert doc["status"] == "failed"
    assert doc["error"].startswith("입력 오류: ")
    assert "sentences[1]" in doc["error"]
    assert llm.calls == []


def test_saved_sentence_that_is_not_an_object_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    doc = run_job(monkeypatch, again_input("글"), llm=FakeLlm())

    assert doc["status"] == "failed"
    assert "sentences[0]" in doc["error"]


def test_saved_sentences_must_be_in_time_order(monkeypatch: pytest.MonkeyPatch) -> None:
    doc = run_job(monkeypatch, again_input(saved_sentence(2), saved_sentence(1)), llm=FakeLlm())

    assert doc["status"] == "failed"
    assert "sentences[1]" in doc["error"]


# ---------- 상한 · 거절 ----------


@pytest.mark.parametrize(
    "limits",
    [
        {"durationMs": RECORDING_MAX_MS + 1},
        {"durationMs": RECORDING_MIN_MS - 1},
        {"sizeBytes": RECORDING_MAX_BYTES + 1},
        {"sizeBytes": 0},
    ],
)
def test_input_limits_reject_before_stt(
    monkeypatch: pytest.MonkeyPatch, limits: dict[str, int]
) -> None:
    speech = FakeSpeech()

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL, **limits}, speech=speech)

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"].startswith("INVALID_FILE: ")
    assert speech.urls == []


@pytest.mark.parametrize(
    "limits",
    [
        {"durationMs": RECORDING_MAX_MS},
        {"durationMs": RECORDING_MIN_MS},
        {"sizeBytes": RECORDING_MAX_BYTES},
    ],
)
def test_values_on_the_limit_are_accepted(limits: dict[str, int]) -> None:
    speech = FakeSpeech()

    run_direct({"audioUrl": AUDIO_URL, **limits}, speech=speech)

    assert speech.urls == [AUDIO_URL]


@pytest.mark.parametrize("duration_ms", [RECORDING_MAX_MS + 1, RECORDING_MIN_MS - 1])
def test_actual_length_from_stt_is_checked_again(
    monkeypatch: pytest.MonkeyPatch, duration_ms: int
) -> None:
    llm = FakeLlm()
    speech = FakeSpeech(transcript(duration_ms=duration_ms))

    doc = run_job(
        monkeypatch, {"audioUrl": AUDIO_URL, "durationMs": DURATION_MS}, speech=speech, llm=llm
    )

    assert doc["status"] == "failed"
    assert doc["error"].startswith("INVALID_FILE: ")
    assert llm.calls == []


@pytest.mark.parametrize("duration_ms", [RECORDING_MAX_MS + 1, RECORDING_MIN_MS - 1])
def test_organizing_again_checks_length(monkeypatch: pytest.MonkeyPatch, duration_ms: int) -> None:
    llm = FakeLlm()

    doc = run_job(monkeypatch, again_input(duration_ms=duration_ms), llm=llm)

    assert doc["status"] == "failed"
    assert doc["error"].startswith("INVALID_FILE: ")
    assert llm.calls == []


def test_small_duration_cannot_hide_sentences_over_two_hours(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    llm = WindowLlm(all_starts)
    over = RECORDING_MAX_MS // 30_000 + 1
    inp = again_input(*(saved_sentence(i) for i in range(over)))

    doc = run_job(monkeypatch, inp, llm=llm)

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"].startswith("INVALID_FILE: ")
    assert llm.windows == []


@pytest.mark.parametrize("over_ms", [1, 60_000])
def test_last_sentence_ending_after_duration_is_rejected(
    monkeypatch: pytest.MonkeyPatch, over_ms: int
) -> None:
    llm = FakeLlm()
    last: Sentence = {**saved_sentence(1), "endMs": DURATION_MS + over_ms}

    doc = run_job(monkeypatch, again_input(saved_sentence(0), last), llm=llm)

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"].startswith("INVALID_FILE: ")
    assert llm.calls == []


def test_earlier_sentence_ending_after_duration_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    llm = FakeLlm()
    long_one: Sentence = {**saved_sentence(0), "endMs": DURATION_MS + 1}

    doc = run_job(monkeypatch, again_input(long_one, saved_sentence(1)), llm=llm)

    assert doc["status"] == "failed"
    assert doc["error"].startswith("INVALID_FILE: ")
    assert llm.calls == []


def test_sentence_ending_exactly_at_duration_is_accepted() -> None:
    last: Sentence = {**saved_sentence(1), "endMs": DURATION_MS}

    result = run_direct(again_input(saved_sentence(0), last))

    assert result["slides"][-1]["endMs"] == DURATION_MS


# ---------- 글자 수 상한 ----------


def two_texts(total_chars: int) -> tuple[str, str]:
    """글자 합계가 total_chars인 두 문장. WindowLlm이 알아보게 s<위치>로 시작."""
    first = total_chars // 2
    return "s0 ".ljust(first, "가"), "s1 ".ljust(total_chars - first, "가")


def saved_with_chars(total_chars: int) -> JsonObject:
    first, second = two_texts(total_chars)
    return again_input(
        {**saved_sentence(0), "text": first},
        {**saved_sentence(1), "text": second},
    )


def transcript_with_chars(total_chars: int) -> Transcript:
    first, second = two_texts(total_chars)
    return Transcript(
        DURATION_MS,
        (Phrase(first, 0, 29_900, ()), Phrase(second, 30_000, 29_900, ())),
    )


def test_organizing_again_rejects_too_many_chars(monkeypatch: pytest.MonkeyPatch) -> None:
    llm = WindowLlm(all_starts)

    doc = run_job(monkeypatch, saved_with_chars(RECORDING_MAX_CHARS + 1), llm=llm)

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"].startswith("INVALID_FILE: ")
    assert llm.windows == []


def test_stt_result_with_too_many_chars_is_rejected_after_stt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    llm = WindowLlm(all_starts)
    speech = FakeSpeech(transcript_with_chars(RECORDING_MAX_CHARS + 1))

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, llm=llm, speech=speech)

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"].startswith("INVALID_FILE: ")
    assert speech.urls == [AUDIO_URL]
    assert llm.windows == []


def test_chars_on_the_limit_are_accepted_on_both_paths() -> None:
    again = run_direct(saved_with_chars(RECORDING_MAX_CHARS))
    fresh = run_direct(
        {"audioUrl": AUDIO_URL},
        speech=FakeSpeech(transcript_with_chars(RECORDING_MAX_CHARS)),
    )

    assert sum(len(s["text"]) for s in again["sentences"]) == RECORDING_MAX_CHARS
    assert sum(len(s["text"]) for s in fresh["sentences"]) == RECORDING_MAX_CHARS


def test_chars_limit_covers_two_hours_of_fast_speech() -> None:
    assert RECORDING_MAX_CHARS >= RECORDING_MAX_MS // 1000 * 8 * 4


# ---------- 문장 끝이 STT 길이를 넘을 때 ----------


def transcript_ending_after_duration(duration_ms: int, over_ms: int) -> Transcript:
    start = duration_ms - 10_000
    return Transcript(
        duration_ms,
        (
            Phrase("s0 문장", 0, 29_900, ()),
            Phrase("s1 문장", start, 10_000 + over_ms, ()),
        ),
    )


def test_duration_grows_to_last_sentence_end_and_result_can_be_organized_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = run_direct(
        {"audioUrl": AUDIO_URL},
        speech=FakeSpeech(transcript_ending_after_duration(DURATION_MS, 500)),
    )
    assert first["durationMs"] == DURATION_MS + 500
    saved = json.loads(json.dumps(first))

    doc = run_job(
        monkeypatch,
        {"sentences": saved["sentences"], "durationMs": saved["durationMs"]},
        speech=FakeSpeech(SpeechError("부르면 안 됨")),
    )

    assert doc["status"] == "succeeded"
    assert doc["result"]["durationMs"] == DURATION_MS + 500


def test_duration_stays_when_sentences_end_earlier() -> None:
    result = run_direct({"audioUrl": AUDIO_URL}, speech=FakeSpeech(transcript()))

    assert result["durationMs"] == DURATION_MS
    assert max(s["endMs"] for s in result["sentences"]) < DURATION_MS


def test_two_hour_limit_uses_the_grown_duration(monkeypatch: pytest.MonkeyPatch) -> None:
    llm = WindowLlm(all_starts)
    speech = FakeSpeech(transcript_ending_after_duration(RECORDING_MAX_MS, 1))

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, llm=llm, speech=speech)

    assert doc["status"] == "failed"
    assert doc["error"].startswith("INVALID_FILE: ")
    assert llm.windows == []


def test_grown_duration_on_the_two_hour_limit_is_accepted() -> None:
    speech = FakeSpeech(transcript_ending_after_duration(RECORDING_MAX_MS - 1, 1))

    result = run_direct({"audioUrl": AUDIO_URL}, speech=speech)

    assert result["durationMs"] == RECORDING_MAX_MS


def test_stt_rejecting_the_file_is_invalid_file_and_hides_the_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, speech=FakeSpeech(SpeechError("HTTP 400")))

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"].startswith("INVALID_FILE: ")
    assert "HTTP 400" in doc["error"]
    assert "secret-sas" not in doc["error"]


def test_no_speech_fails_with_code(monkeypatch: pytest.MonkeyPatch) -> None:
    speech = FakeSpeech(NoSpeechError("인식된 말이 없음"))

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, speech=speech)

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"] == "NO_SPEECH: 인식된 말이 없음"


def test_input_error_keeps_code_outside_runner() -> None:
    with pytest.raises(InputError) as e:
        run_direct({"audioUrl": AUDIO_URL, "durationMs": 1})
    assert e.value.code == "INVALID_FILE"


# ---------- 일시 오류 ----------


def test_speech_unavailable_is_retried_later(monkeypatch: pytest.MonkeyPatch) -> None:
    speech = FakeSpeech(SpeechUnavailableError("HTTP 503"))

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, speech=speech)

    assert (doc["status"], doc["attempts"], doc["result"]) == ("queued", 1, None)
    assert "HTTP 503" in doc["error"]
    assert doc["retryAt"] > T0


def test_voyage_unavailable_is_retried_later(monkeypatch: pytest.MonkeyPatch) -> None:
    voyage = FakeVoyage(EmbedUnavailableError("HTTP 429"))

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, voyage=voyage)

    assert (doc["status"], doc["attempts"], doc["result"]) == ("queued", 1, None)
    assert "HTTP 429" in doc["error"]


def test_llm_unavailable_is_retried_later(monkeypatch: pytest.MonkeyPatch) -> None:
    llm = FakeLlm({SLIDES: [LlmError("HTTP 503")]})

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, llm=llm)

    assert (doc["status"], doc["attempts"]) == ("queued", 1)
    assert doc["error"] == "AI 응답을 받지 못함(HTTP 503)"


def test_llm_rejection_fails_without_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    # 서버가 거절한 요청(413 등)은 다시 넣어도 같음: 작업 처리기까지 와서 바로 실패(Codex #264)
    llm = FakeLlm({SLIDES: [LlmRejectedError("HTTP 413")]})

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, llm=llm)

    assert (doc["status"], doc["attempts"]) == ("failed", 1)
    assert doc["error"] == "AI가 요청을 거절함(HTTP 413)"


def test_a_rejected_right_half_fails_without_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    # 창 전체가 잘려 반으로 나눈 뒤 오른쪽 반을 서버가 거절: 작업 처리기까지 와서 바로 실패(#272)
    llm = PieceLlm({(0, 4): [LlmCutError("JSON")], (2, 2): [LlmRejectedError("HTTP 413")]})

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, llm=llm)

    assert llm.asked == [(0, 4), (0, 2), (2, 2)]
    assert (doc["status"], doc["attempts"]) == ("failed", 1)
    assert doc["error"] == "AI가 요청을 거절함(HTTP 413)"


@pytest.mark.parametrize("error", ["HTTP 401", "응답 모양"])
def test_permanent_voyage_error_fails_without_retry(
    monkeypatch: pytest.MonkeyPatch, error: str
) -> None:
    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, voyage=FakeVoyage(EmbedError(error)))

    assert (doc["status"], doc["attempts"], doc["error"]) == ("failed", 1, "처리 중 오류")


@pytest.fixture
def real_clients(monkeypatch: pytest.MonkeyPatch) -> Any:
    """설정 누락을 보려고 실제 만들기 함수를 씁니다. 캐시는 앞뒤로 비움."""
    for make in (handlers._llm, handlers._speech, handlers._voyage):
        make.cache_clear()
    monkeypatch.setattr(settings, "llm_provider", "claude")
    monkeypatch.setattr(settings, "anthropic_api_key", SecretStr("k"))
    monkeypatch.setattr(settings, "azure_speech_endpoint", "http://speech.test")
    monkeypatch.setattr(settings, "azure_speech_key", SecretStr("k"))
    monkeypatch.setattr(settings, "voyage_api_key", SecretStr("k"))
    yield monkeypatch
    for make in (handlers._llm, handlers._speech, handlers._voyage):
        make.cache_clear()


@pytest.mark.parametrize(
    ("name", "blank", "error"),
    [
        # LLM 설정은 LlmSetupError(retry=False)로 이유를 남김(#262 · #278)
        ("anthropic_api_key", SecretStr(""), "AI 설정 오류(ANTHROPIC_API_KEY가 비어 있음)"),
        ("azure_speech_endpoint", "", "처리 중 오류"),
        ("voyage_api_key", SecretStr(""), "처리 중 오류"),
    ],
)
def test_missing_setting_fails_without_retry(
    real_clients: pytest.MonkeyPatch, name: str, blank: object, error: str
) -> None:
    real_clients.setattr(settings, name, blank)

    doc = queued_job_result({"audioUrl": AUDIO_URL})

    assert (doc["status"], doc["attempts"], doc["error"]) == ("failed", 1, error)


# ---------- 진행률 ----------


def recorder() -> tuple[list[tuple[int, str | None]], Callable[[int, str | None], None]]:
    seen: list[tuple[int, str | None]] = []

    def record(value: int, step: str | None) -> None:
        seen.append((value, step))

    return seen, record


def long_transcript(n: int = 60) -> Transcript:
    return Transcript(
        n * 30_000,
        tuple(Phrase(f"s{i} " + "가" * 200, i * 30_000, 29_900, ()) for i in range(n)),
    )


def test_progress_goes_through_steps_in_order_and_only_up() -> None:
    seen, record = recorder()

    run_direct({"audioUrl": AUDIO_URL}, speech=FakeSpeech(long_transcript()), report=record)

    values = [v for v, _ in seen]
    assert values == sorted(values)
    assert seen[0] == (0, "stt")
    assert seen[-1] == (100, "embed")
    steps = [s for _, s in seen]
    order = ["stt", "organize", "embed"]
    assert steps == sorted(steps, key=lambda s: order.index(str(s)))
    organizing = [v for v, s in seen if s == "organize"]
    assert organizing[0] == 20
    assert organizing[-1] == 90
    assert len(organizing) > 2  # 창이 끝날 때마다
    assert (90, "embed") in seen


def test_organizing_again_skips_stt_and_starts_at_organize() -> None:
    seen, record = recorder()

    def no_speech_client() -> Transcriber:
        raise AssertionError("STT를 부르면 안 됨")

    result = run(
        WindowLlm(all_starts),
        no_speech_client,
        FakeVoyage(),
        again_input(saved_sentence(0), saved_sentence(1)),
        lambda value, step=None: record(value, step),
    )

    assert len(result["slides"]) == 2
    assert seen[0] == (20, "organize")
    assert "stt" not in [s for _, s in seen]
    assert seen[-1] == (100, "embed")


def test_organizing_again_accepts_saved_result(monkeypatch: pytest.MonkeyPatch) -> None:
    words = (Word("s0", 0, 500), Word("문장", 500, 400))
    first = run_direct(
        {"audioUrl": AUDIO_URL},
        speech=FakeSpeech(Transcript(DURATION_MS, (Phrase("s0 문장", 0, 29_900, words),))),
    )
    saved = json.loads(json.dumps(first))

    doc = run_job(
        monkeypatch,
        {"sentences": saved["sentences"], "durationMs": saved["durationMs"]},
        speech=FakeSpeech(SpeechError("부르면 안 됨")),
    )

    assert doc["status"] == "succeeded"
    assert doc["result"]["sentences"] == saved["sentences"]
    assert doc["result"]["transcript"] == saved["transcript"]
    assert doc["result"]["durationMs"] == saved["durationMs"]


def test_cancel_stops_at_the_next_window() -> None:
    llm = WindowLlm(all_starts)

    def cancel(value: int, step: str | None) -> None:
        if step == "organize" and value > 20:
            raise JobGoneError("j1")

    with pytest.raises(JobGoneError):
        run_direct(
            {"audioUrl": AUDIO_URL},
            llm=llm,
            speech=FakeSpeech(long_transcript()),
            report=cancel,
        )
    assert len(llm.windows) == 1


def test_a_cancel_stops_the_next_llm_call_before_any_progress_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # 같은 창을 다른 온도로 다시 묻는 사이에는 진행률을 쓰지 않음: 처리기가 몇 초마다 상태를 읽어
    # 취소를 알아채고(report.canceled), 학교 LLM 연결(Stopping)이 다음 호출을 보내지 않아야 함.
    # 실제 runner · JobStore를 거쳐, 처리가 끝난 뒤 잠금이 풀리는지도 봄(Codex 리뷰 #273, #263)
    monkeypatch.setattr(runner, "CANCEL_CHECK_SEC", 0.01)
    col = queued_job({"audioUrl": AUDIO_URL})
    calls: list[str] = []

    class CancelOnFirst:
        def call(self, model: str, system: str, user: str, schema: Any, name: str, **_: Any) -> Any:
            calls.append(name)
            col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})  # 앱에서 취소
            time.sleep(0.3)  # 처리기가 상태를 읽어 알아챌 때까지
            return {}  # 쓸 내용이 없어 같은 창을 다른 온도로 다시 물으려 함

    monkeypatch.setattr(handlers, "_llm", lambda: CancelOnFirst())
    monkeypatch.setattr(handlers, "_speech", lambda: FakeSpeech())
    monkeypatch.setattr(handlers, "_voyage", lambda: FakeVoyage())
    store = JobStore(col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: T0)

    assert run_once(store, HANDLERS)

    doc = col.find_one({"_id": "j1"})
    assert calls == [SLIDES]  # 다시 묻는 호출은 보내지 않음
    assert (doc["status"], doc["result"], doc["lockedBy"], doc["lockedUntil"]) == (
        "canceled",
        None,
        None,
        None,
    )


# ---------- 다시 시도 때 인식 결과 재사용 ----------


class ProgressStore(JobStore):
    """쓴 진행률을 모아 둡니다."""

    seen: list[tuple[int, str | None]]

    def progress(self, job: Any, value: int, step: str | None = None) -> None:
        self.seen.append((value, step))
        super().progress(job, value, step)


def attempt(
    monkeypatch: pytest.MonkeyPatch,
    col: Any,
    *,
    llm: Any = None,
    speech: FakeSpeech | None = None,
    voyage: FakeVoyage | None = None,
    seen: list[tuple[int, str | None]] | None = None,
) -> dict[str, Any]:
    """같은 문서로 시도를 하나 더 합니다. 시계는 다시 시도 대기를 넘긴 때로 둠."""
    monkeypatch.setattr(handlers, "_llm", lambda: llm if llm is not None else WindowLlm(all_starts))
    monkeypatch.setattr(handlers, "_speech", lambda: speech if speech is not None else FakeSpeech())
    monkeypatch.setattr(handlers, "_voyage", lambda: voyage if voyage is not None else FakeVoyage())
    later = T0 + timedelta(hours=col.find_one({"_id": "j1"})["attempts"])
    store = ProgressStore(
        col, "w1", lock_sec=60, max_attempts=3, retry_delay_sec=30, now=lambda: later
    )
    store.seen = seen if seen is not None else []
    assert run_once(store, HANDLERS)
    doc: dict[str, Any] = col.find_one({"_id": "j1"})
    return doc


def llm_down() -> FakeLlm:
    return FakeLlm({SLIDES: [LlmError("HTTP 429")]})


def expired_sas() -> FakeSpeech:
    """다시 부르면 바로 실패로 끝나는 STT(읽기 주소 만료)."""
    return FakeSpeech(SpeechError("HTTP 403"))


def test_stt_result_is_saved_when_the_llm_fails_after_it(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})
    speech = FakeSpeech()

    doc = attempt(monkeypatch, col, llm=llm_down(), speech=speech)

    assert (doc["status"], doc["attempts"]) == ("queued", 1)
    assert speech.urls == [AUDIO_URL]
    assert set(doc["checkpoint"]) == {"sentences", "durationMs"}
    assert doc["checkpoint"]["durationMs"] == DURATION_MS
    assert [s["text"] for s in doc["checkpoint"]["sentences"]] == [f"s{i} 문장" for i in range(4)]
    assert "secret-sas" not in json.dumps(doc["checkpoint"])


def test_retry_skips_stt_and_starts_at_organize(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})
    saved = attempt(monkeypatch, col, llm=llm_down())["checkpoint"]
    speech = expired_sas()
    seen: list[tuple[int, str | None]] = []

    doc = attempt(monkeypatch, col, speech=speech, seen=seen)

    assert (doc["status"], doc["attempts"], doc["error"]) == ("succeeded", 2, None)
    assert speech.urls == []
    assert doc["result"]["sentences"] == saved["sentences"]
    assert doc["result"]["durationMs"] == saved["durationMs"]
    assert seen[0] == (20, "organize")
    assert "stt" not in [s for _, s in seen]
    values = [v for v, _ in seen]
    assert values == sorted(values)
    assert seen[-1] == (100, "embed")
    assert "checkpoint" not in doc


def test_retry_after_voyage_failure_also_skips_stt(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})
    down = FakeVoyage(EmbedUnavailableError("HTTP 503"))
    assert attempt(monkeypatch, col, voyage=down)["status"] == "queued"
    speech = expired_sas()

    doc = attempt(monkeypatch, col, speech=speech)

    assert doc["status"] == "succeeded"
    assert speech.urls == []


def test_stalled_job_taken_again_reuses_the_stt_result(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})
    col.update_one(
        {"_id": "j1"},
        {
            "$set": {
                "status": "running",
                "attempts": 1,
                "lockedBy": "w0",
                "lockedUntil": T0,
                "checkpoint": again_input(saved_sentence(0), saved_sentence(1)),
            }
        },
    )
    speech = expired_sas()

    doc = attempt(monkeypatch, col, speech=speech)

    assert (doc["status"], doc["attempts"]) == ("succeeded", 2)
    assert speech.urls == []


@pytest.mark.parametrize(
    "broken",
    [
        "글",
        {},
        {"durationMs": DURATION_MS},
        {"sentences": [saved_sentence()]},
        {"sentences": [], "durationMs": DURATION_MS},
        {"sentences": "글", "durationMs": DURATION_MS},
        {"sentences": [{"text": "빠진 필드"}], "durationMs": DURATION_MS},
        {"sentences": [saved_sentence(2), saved_sentence(1)], "durationMs": DURATION_MS},
        {"sentences": [saved_sentence()], "durationMs": "1"},
        {"sentences": [saved_sentence()], "durationMs": RECORDING_MAX_MS + 1},
        {"sentences": [saved_sentence(100)], "durationMs": DURATION_MS},
    ],
)
def test_broken_checkpoint_is_ignored_and_stt_runs_again(
    monkeypatch: pytest.MonkeyPatch, broken: object
) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})
    col.update_one({"_id": "j1"}, {"$set": {"checkpoint": broken}})
    speech = FakeSpeech()
    seen: list[tuple[int, str | None]] = []

    doc = attempt(monkeypatch, col, speech=speech, seen=seen)

    assert (doc["status"], doc["error"]) == ("succeeded", None)
    assert speech.urls == [AUDIO_URL]
    assert seen[0] == (0, "stt")
    assert "checkpoint" not in doc


def test_broken_checkpoint_is_replaced_by_the_new_stt_result(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})
    col.update_one({"_id": "j1"}, {"$set": {"checkpoint": {"durationMs": DURATION_MS}}})

    doc = attempt(monkeypatch, col, llm=llm_down())

    assert len(doc["checkpoint"]["sentences"]) == 4


def test_nothing_is_saved_when_canceled_during_stt(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})
    llm = WindowLlm(all_starts)

    class CanceledSpeech(FakeSpeech):
        def transcribe(self, audio_url: str) -> Transcript:
            col.update_one({"_id": "j1"}, {"$set": {"status": "canceled"}})
            return super().transcribe(audio_url)

    doc = attempt(monkeypatch, col, llm=llm, speech=CanceledSpeech())

    assert doc["status"] == "canceled"
    assert "checkpoint" not in doc
    assert llm.windows == []


def test_nothing_is_saved_when_another_worker_took_the_job(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})
    llm = WindowLlm(all_starts)

    class SlowSpeech(FakeSpeech):
        def transcribe(self, audio_url: str) -> Transcript:
            col.update_one({"_id": "j1"}, {"$set": {"lockedBy": "w2"}})
            return super().transcribe(audio_url)

    doc = attempt(monkeypatch, col, llm=llm, speech=SlowSpeech())

    assert (doc["status"], doc["lockedBy"]) == ("running", "w2")
    assert "checkpoint" not in doc
    assert llm.windows == []


def test_rejected_stt_result_is_not_saved(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})

    doc = attempt(monkeypatch, col, speech=FakeSpeech(transcript(duration_ms=RECORDING_MIN_MS - 1)))

    assert doc["status"] == "failed"
    assert "checkpoint" not in doc


def test_checkpoint_stays_after_the_last_attempt_and_app_retry_reuses_it(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})
    for _ in range(3):
        doc = attempt(monkeypatch, col, llm=llm_down())
    assert (doc["status"], doc["attempts"]) == ("failed", 3)
    assert len(doc["checkpoint"]["sentences"]) == 4
    # 앱의 '다시 시도'(NestJS)
    col.update_one({"_id": "j1"}, {"$set": {"status": "queued", "attempts": 0, "retryAt": None}})
    speech = expired_sas()

    doc = attempt(monkeypatch, col, speech=speech)

    assert (doc["status"], doc["attempts"]) == ("succeeded", 1)
    assert speech.urls == []
    assert "checkpoint" not in doc


def test_permanent_failure_keeps_the_checkpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job({"audioUrl": AUDIO_URL})

    doc = attempt(monkeypatch, col, voyage=FakeVoyage(EmbedError("HTTP 401")))

    assert doc["status"] == "failed"
    assert len(doc["checkpoint"]["sentences"]) == 4


def test_organizing_again_saves_no_checkpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    col = queued_job(again_input(saved_sentence(0), saved_sentence(1)))

    doc = attempt(monkeypatch, col, llm=llm_down())

    assert doc["status"] == "queued"
    assert "checkpoint" not in doc


# ---------- PARTIAL ----------


class TickingLlm(WindowLlm):
    """창을 하나 처리할 때마다 시계가 흐름."""

    def __init__(self, now: list[float], sec_per_window: float) -> None:
        super().__init__(all_starts)
        self.now, self.sec_per_window = now, sec_per_window

    def call(
        self,
        model: str,
        system: str,
        user: str,
        schema: JsonObject,
        name: str,
        *,
        max_tokens: int = 1500,
        temperature: float = 0.0,
    ) -> JsonObject:
        self.now[0] += self.sec_per_window
        return super().call(
            model, system, user, schema, name, max_tokens=max_tokens, temperature=temperature
        )


def test_time_limit_stops_between_windows_with_warning(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "recording_job_max_sec", 100)
    now = [0.0]
    llm = TickingLlm(now, 40.0)
    voyage = FakeVoyage()
    data = long_transcript()

    result = run_direct(
        {"audioUrl": AUDIO_URL},
        llm=llm,
        speech=FakeSpeech(data),
        voyage=voyage,
        clock=lambda: now[0],
    )

    assert len(llm.windows) == 3  # 0 · 40 · 80초에 시작, 120초에는 부르지 않음
    slides = result["slides"]
    assert result["warnings"] == [{"code": "PARTIAL", "untilMs": slides[-1]["endMs"]}]
    last = llm.windows[-1][-1]
    assert slides[-1]["sentenceEnd"] == last + 1 < len(data.phrases)
    assert slides[0]["sentenceStart"] == 0
    for prev, nxt in zip(slides, slides[1:], strict=False):
        assert prev["sentenceEnd"] == nxt["sentenceStart"]
    # 대본은 전체를 담음
    assert len(result["sentences"]) == len(data.phrases)
    assert result["transcript"].count("\n") == len(data.phrases) - 1
    # 끝난 슬라이드만 임베딩
    assert len(result["chunks"]) == len(slides) == len(voyage.texts)


def test_time_limit_during_fill_keeps_chunks_matching_slides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "recording_job_max_sec", 100)
    now = [0.0]
    llm = TickingLlm(now, 60.0)  # 창 60초, 첫 묶음 120초: 다음 묶음 전에 기한이 지남
    voyage = FakeVoyage()
    data = Transcript(
        DURATION_MS,
        tuple(
            Phrase(f"s{i} ".ljust(WINDOW_CHARS // 2, "가"), i * 60_000, 59_900, ())
            for i in range(3)
        ),
    )

    result = run_direct(
        {"audioUrl": AUDIO_URL},
        llm=llm,
        speech=FakeSpeech(data),
        voyage=voyage,
        clock=lambda: now[0],
    )

    assert llm.fills == [2]
    slides = result["slides"]
    assert [s["sentenceStart"] for s in slides] == [0, 1]
    assert result["warnings"] == [{"code": "PARTIAL", "untilMs": slides[-1]["endMs"]}]
    assert len(result["sentences"]) == 3
    assert len(result["chunks"]) == len(voyage.texts) == 2
    assert [c["slideIndex"] for c in result["chunks"]] == [0, 1]


def test_at_least_one_window_runs_even_when_stt_used_all_the_time(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "recording_job_max_sec", 100)
    now = [0.0]

    class SlowSpeech(FakeSpeech):
        def transcribe(self, audio_url: str) -> Transcript:
            now[0] += 500
            return super().transcribe(audio_url)

    llm = WindowLlm(all_starts)
    result = run_direct(
        {"audioUrl": AUDIO_URL},
        llm=llm,
        speech=SlowSpeech(long_transcript()),
        clock=lambda: now[0],
    )

    assert len(llm.windows) == 1
    assert result["slides"]
    assert result["warnings"][0]["code"] == "PARTIAL"


def test_no_warning_when_time_is_left() -> None:
    result = run_direct({"audioUrl": AUDIO_URL}, speech=FakeSpeech(long_transcript()))

    assert result["warnings"] == []
    assert result["slides"][-1]["sentenceEnd"] == 60


def test_partial_is_success_with_warning_through_runner(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "recording_job_max_sec", 0)

    doc = run_job(monkeypatch, {"audioUrl": AUDIO_URL}, speech=FakeSpeech(long_transcript()))

    assert doc["status"] == "succeeded"
    assert doc["error"] is None
    assert doc["result"]["warnings"][0]["code"] == "PARTIAL"


# ---------- 임베딩 조각 ----------


def test_chunks_follow_slides_with_title_first() -> None:
    llm = FakeLlm(
        {
            SLIDES: [
                {
                    "slides": [
                        item(1, "앞 제목", "앞이다."),
                        item(3, "뒤 제목", "뒤다."),
                    ]
                }
            ]
        }
    )
    voyage = FakeVoyage()

    result = run_direct({"audioUrl": AUDIO_URL}, llm=llm, voyage=voyage)

    assert voyage.input_types == ["document"]
    assert voyage.texts == ["앞 제목\ns0 문장\ns1 문장", "뒤 제목\ns2 문장\ns3 문장"]
    assert result["chunks"] == [
        {
            "order": 0,
            "slideIndex": 0,
            "startMs": 0,
            "endMs": 59_900,
            "text": "앞 제목\ns0 문장\ns1 문장",
            "embedding": [0.5, 0.5],
        },
        {
            "order": 1,
            "slideIndex": 1,
            "startMs": 60_000,
            "endMs": 119_900,
            "text": "뒤 제목\ns2 문장\ns3 문장",
            "embedding": [1.5, 1.5],
        },
    ]


def test_result_is_json_serializable() -> None:
    result = run_direct({"audioUrl": AUDIO_URL})

    assert json.loads(json.dumps(result)) == result


def two_hour_result() -> tuple[JsonObject, JsonObject]:
    """가장 큰 경우에 가까운 2시간: 슬라이드 최소 길이(15초) · 초당 8자 · 4글자 단어 · 1,024차원."""
    n = RECORDING_MAX_MS // 15_000
    phrases = []
    for i in range(n):
        start = i * 15_000
        words = tuple(Word("가나다라", start + k * 400, 400) for k in range(30))
        phrases.append(Phrase(f"s{i} " + "가나다라 " * 24, start, 14_900, words))
    data = Transcript(RECORDING_MAX_MS, tuple(phrases))
    result = run_direct(
        {"audioUrl": AUDIO_URL}, speech=FakeSpeech(data), voyage=FakeVoyage(dims=1024)
    )
    inp: JsonObject = {"sentences": result["sentences"], "durationMs": result["durationMs"]}
    return result, inp


def test_two_hour_result_fits_in_a_mongo_document() -> None:
    result, inp = two_hour_result()

    assert len(result["slides"]) == 479  # 마지막 슬라이드는 최소 길이가 안 돼 앞에 붙음
    # 다시 정리하기는 input에도 sentences가 들어가므로 함께 잼
    assert len(bson.encode({"result": result, "input": inp})) < MONGO_DOC_LIMIT


def test_two_hour_checkpoint_fits_in_a_mongo_document() -> None:
    _, checkpoint = two_hour_result()

    # 실패한 작업 문서에는 input(주소 · 크기)과 함께 남음. 결과와 함께 있는 때는 없음(성공 때 지움)
    assert len(bson.encode({"checkpoint": checkpoint})) < MONGO_DOC_LIMIT
