"""녹음 정리에 강의 자료(PPT) · 같은 폴더 필기를 함께 쓰기(FR-23, #123)."""

import json
import time
from collections.abc import Callable
from typing import Any

import pytest

from app.clients.docint import TOO_LARGE, DownloadError
from app.clients.llm import JsonObject
from app.clients.voyage import InputType
from app.services.recording.job import Transcriber, run
from app.services.recording.material import (
    MATERIAL_RULES,
    MATERIAL_WINDOW_CHARS,
    NOTE_MAX_CHARS,
    NOTES_MAX,
)
from app.services.recording.pipeline import FILL_SYSTEM, WINDOW_SYSTEM
from app.services.recording.slides import PAGE_MAX_CHARS
from app.worker import handlers
from tests.fakes import FakeLlm
from tests.services.recording.files import chars, ole_file, ppt_stream, pptx_file
from tests.services.recording.test_job import (
    AUDIO_URL,
    DURATION_MS,
    FakeSpeech,
    FakeVoyage,
    again_input,
    all_starts,
    attempt,
    expired_sas,
    llm_down,
    long_transcript,
    queued_job,
    recorder,
    run_job,
    saved_sentence,
)
from tests.services.recording.test_pipeline import FILL, SLIDES, WindowLlm

SLIDES_URL = "https://blob.example.test/lecture.pptx?sig=slide-sas"
DECK = pptx_file(["TCP 3-way handshake", "SYN, ACK"], [], ["QUIC은 UDP 위에서"])


class SystemLlm(WindowLlm):
    """WindowLlm처럼 답하고 호출마다 (이름, 시스템 프롬프트)를 모음."""

    def __init__(self) -> None:
        super().__init__(all_starts)
        self.systems: list[tuple[str, str]] = []

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
        self.systems.append((name, system))
        return super().call(
            model, system, user, schema, name, max_tokens=max_tokens, temperature=temperature
        )


class Fetch:
    def __init__(self, answer: bytes | Exception = DECK) -> None:
        self.answer = answer
        self.urls: list[str] = []

    def __call__(self, url: str) -> bytes:
        self.urls.append(url)
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def run_with(
    inp: JsonObject,
    *,
    llm: Any = None,
    fetch: Fetch | None = None,
    speech: FakeSpeech | None = None,
    voyage: Any = None,
    report: Callable[[int, str | None], None] | None = None,
) -> JsonObject:
    def on_report(value: int, step: str | None = None) -> None:
        if report is not None:
            report(value, step)

    def make_speech() -> Transcriber:
        return speech if speech is not None else FakeSpeech()

    return run(
        llm if llm is not None else SystemLlm(),
        make_speech,
        voyage if voyage is not None else FakeVoyage(),
        inp,
        on_report,
        clock=time.monotonic,
        fetch=fetch if fetch is not None else Fetch(),
    )


def with_slides(**more: object) -> JsonObject:
    return {"audioUrl": AUDIO_URL, "slidesUrl": SLIDES_URL, **more}


# ---------- 자료 없음: 지금과 같음 ----------


def test_without_material_prompts_are_unchanged_and_counts_are_zero() -> None:
    llm, fetch = SystemLlm(), Fetch()

    result = run_with({"audioUrl": AUDIO_URL}, llm=llm, fetch=fetch)

    assert fetch.urls == []
    assert {s for name, s in llm.systems if name == SLIDES} == {WINDOW_SYSTEM}
    assert result["materialUsed"] == {"slidePages": 0, "notes": 0}
    assert result["warnings"] == []


def test_without_material_fill_prompt_is_unchanged() -> None:
    llm = SystemLlm()
    llm.pick = lambda ids: [2]  # 첫 슬라이드가 비어 글 다시 받기가 불림

    run_with({"audioUrl": AUDIO_URL}, llm=llm)

    assert {s for name, s in llm.systems if name == FILL} == {FILL_SYSTEM}


# ---------- 강의 자료 ----------


def test_pptx_goes_into_every_system_prompt_with_page_numbers() -> None:
    llm, fetch = SystemLlm(), Fetch()
    llm.pick = lambda ids: [2]

    result = run_with(with_slides(), llm=llm, fetch=fetch)

    assert fetch.urls == [SLIDES_URL]
    names = {name for name, _ in llm.systems}
    assert names == {SLIDES, FILL}
    for name, system in llm.systems:
        base = WINDOW_SYSTEM if name == SLIDES else FILL_SYSTEM
        assert system.startswith(f"{base} {MATERIAL_RULES}\n\n<material>\n")
        assert '<page no="1">\nTCP 3-way handshake SYN, ACK\n</page>' in system
        assert '<page no="3">\nQUIC은 UDP 위에서\n</page>' in system
        assert system.endswith("</material>")
    assert result["materialUsed"] == {"slidePages": 2, "notes": 0}
    assert result["warnings"] == []


def test_same_material_gives_the_same_system_prompt_for_every_window() -> None:
    llm = SystemLlm()

    run_with(with_slides(), llm=llm, speech=FakeSpeech(long_transcript()))

    windows = [s for name, s in llm.systems if name == SLIDES]
    assert len(windows) > 2
    assert len(set(windows)) == 1  # 같은 시스템 글: 두 번째 창부터 프롬프트 캐시


def test_ppt_is_read_too() -> None:
    llm = SystemLlm()

    result = run_with(
        with_slides(), llm=llm, fetch=Fetch(ole_file(ppt_stream([chars("옛 형식 쪽")])))
    )

    assert '<page no="1">\n옛 형식 쪽\n</page>' in llm.systems[0][1]
    assert result["materialUsed"]["slidePages"] == 1


def test_material_step_comes_before_stt() -> None:
    seen, record = recorder()

    run_with(with_slides(), report=record)

    assert seen[:2] == [(0, "material"), (0, "stt")]
    values = [v for v, _ in seen]
    assert values == sorted(values)


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        (DownloadError("HTTP 403"), "download"),
        (DownloadError(TOO_LARGE), "size"),
        (b"%PDF-1.7", "format"),
        (b"PK\x03\x04broken", "parse"),
        (pptx_file([], []), "empty"),
    ],
    ids=["download", "size", "format", "parse", "empty"],
)
def test_unusable_slides_warn_and_organize_from_the_transcript_only(
    answer: bytes | Exception, reason: str
) -> None:
    llm = SystemLlm()

    result = run_with(with_slides(), llm=llm, fetch=Fetch(answer))

    assert result["warnings"] == [{"code": "NO_SLIDES", "reason": reason}]
    assert {s for _, s in llm.systems} == {WINDOW_SYSTEM}
    assert result["materialUsed"] == {"slidePages": 0, "notes": 0}
    assert len(result["slides"]) == 4


def test_slides_warning_comes_before_partial(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.config import settings

    monkeypatch.setattr(settings, "recording_job_max_sec", 0)

    result = run_with(
        with_slides(), fetch=Fetch(DownloadError("HTTP 404")), speech=FakeSpeech(long_transcript())
    )

    assert [w["code"] for w in result["warnings"]] == ["NO_SLIDES", "PARTIAL"]


def test_failed_slides_through_runner_succeed_with_warning_and_hide_the_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(handlers, "_fetch_slides", Fetch(DownloadError("HTTP 403")))

    doc = run_job(monkeypatch, with_slides())

    assert (doc["status"], doc["error"]) == ("succeeded", None)
    assert doc["result"]["warnings"] == [{"code": "NO_SLIDES", "reason": "download"}]
    assert "slide-sas" not in json.dumps(doc["result"], ensure_ascii=False)


# ---------- 필기 ----------


def test_notes_only_need_no_download_and_no_material_step() -> None:
    llm, fetch = SystemLlm(), Fetch()
    seen, record = recorder()
    notes = [{"title": "3주차 필기", "text": "TCP는\n  연결형이다"}, {"text": "  "}]

    result = run_with({"audioUrl": AUDIO_URL, "notes": notes}, llm=llm, fetch=fetch, report=record)

    assert fetch.urls == []
    assert seen[0] == (0, "stt")
    system = llm.systems[0][1]
    assert "<note>\n제목: 3주차 필기\nTCP는\n연결형이다\n</note>" in system
    assert "<page" not in system
    assert result["materialUsed"] == {"slidePages": 0, "notes": 1}
    assert result["warnings"] == []


def test_slides_and_notes_together() -> None:
    llm = SystemLlm()

    result = run_with(with_slides(notes=[{"text": "필기 글"}]), llm=llm)

    system = llm.systems[0][1]
    assert system.index("<page") < system.index("<note>")
    assert result["materialUsed"] == {"slidePages": 2, "notes": 1}


def test_notes_over_the_count_are_cut_from_the_front_with_warning() -> None:
    llm = SystemLlm()
    notes = [{"text": f"필기{i}번"} for i in range(NOTES_MAX + 2)]

    result = run_with({"audioUrl": AUDIO_URL, "notes": notes}, llm=llm)

    assert result["warnings"] == [{"code": "MATERIAL_TRIMMED", "reason": "notes"}]
    assert result["materialUsed"]["notes"] == NOTES_MAX
    system = llm.systems[0][1]
    assert f"필기{NOTES_MAX - 1}번" in system
    assert f"필기{NOTES_MAX}번" not in system


def test_long_note_is_cut_with_one_warning() -> None:
    llm = SystemLlm()
    notes = [{"text": "가" * (NOTE_MAX_CHARS + 1)}, {"text": "나" * (NOTE_MAX_CHARS + 1)}]

    result = run_with({"audioUrl": AUDIO_URL, "notes": notes}, llm=llm)

    assert result["warnings"] == [{"code": "MATERIAL_TRIMMED", "reason": "notes"}]
    system = llm.systems[0][1]
    assert "가" * NOTE_MAX_CHARS + "\n</note>" in system
    assert "가" * (NOTE_MAX_CHARS + 1) not in system


# ---------- 상한을 넘는 자료 ----------


class KeywordVoyage(FakeVoyage):
    """'주제N' 글자를 축으로 한 벡터(조각 임베딩도 받음)."""

    def embed(self, texts: list[str], input_type: InputType) -> list[list[float]]:
        self.texts += texts
        self.input_types.append(input_type)
        return [[float(t.count(f"주제{k}")) for k in range(8)] + [0.01] for t in texts]


def test_large_material_is_picked_per_window_by_similarity() -> None:
    filler = "다" * (PAGE_MAX_CHARS - 10)
    deck = pptx_file(*([f"주제{i % 8} {filler}"] for i in range(40)))
    llm = SystemLlm()
    voyage = KeywordVoyage()

    result = run_with(
        with_slides(),
        llm=llm,
        fetch=Fetch(deck),
        voyage=voyage,
        speech=FakeSpeech(long_transcript()),
    )

    windows = [s for name, s in llm.systems if name == SLIDES]
    assert len(windows) > 2
    for system in windows:
        block = system[system.index("<material>") :]
        assert len(block) <= MATERIAL_WINDOW_CHARS + 100
    assert 0 < result["materialUsed"]["slidePages"] < 40
    assert "query" in voyage.input_types
    assert result["warnings"] == []


# ---------- input 형식 ----------


@pytest.mark.parametrize(
    "more",
    [
        {"slidesUrl": 3},
        {"slidesUrl": "  "},
        {"slidesUrl": ["주소"]},
        {"notes": "글"},
        {"notes": {"text": "글"}},
        {"notes": [3]},
        {"notes": [{"title": "제목"}]},
        {"notes": [{"text": 1}]},
        {"notes": [{"text": "글", "title": 2}]},
    ],
)
@pytest.mark.parametrize("path", ["audio", "again"])
def test_bad_material_input_fails_without_calling_anything(
    monkeypatch: pytest.MonkeyPatch, more: JsonObject, path: str
) -> None:
    speech, llm, fetch = FakeSpeech(), FakeLlm(), Fetch()
    monkeypatch.setattr(handlers, "_fetch_slides", fetch)
    base = {"audioUrl": AUDIO_URL} if path == "audio" else again_input()

    doc = run_job(monkeypatch, {**base, **more}, speech=speech, llm=llm)

    assert doc["status"] == "failed"
    assert doc["attempts"] == 1
    assert doc["error"].startswith("입력 오류: ")
    assert (speech.urls, llm.calls, fetch.urls) == ([], [], [])


def test_null_material_fields_are_like_missing() -> None:
    llm = SystemLlm()

    result = run_with({"audioUrl": AUDIO_URL, "slidesUrl": None, "notes": None}, llm=llm)

    assert {s for _, s in llm.systems} == {WINDOW_SYSTEM}
    assert result["materialUsed"] == {"slidePages": 0, "notes": 0}


# ---------- 다시 정리하기 ----------


def test_organizing_again_also_uses_slides_and_notes() -> None:
    llm, fetch = SystemLlm(), Fetch()
    seen, record = recorder()
    inp = {
        **again_input(saved_sentence(0), saved_sentence(1)),
        "slidesUrl": SLIDES_URL,
        "notes": [{"text": "필기"}],
    }

    result = run_with(inp, llm=llm, fetch=fetch, report=record)

    assert fetch.urls == [SLIDES_URL]
    assert '<page no="1">' in llm.systems[0][1]
    assert result["materialUsed"] == {"slidePages": 2, "notes": 1}
    assert seen[:2] == [(0, "material"), (20, "organize")]


# ---------- checkpoint ----------


def test_checkpoint_keeps_the_slides_with_the_stt_result(monkeypatch: pytest.MonkeyPatch) -> None:
    fetch = Fetch()
    monkeypatch.setattr(handlers, "_fetch_slides", fetch)
    col = queued_job(with_slides())

    doc = attempt(monkeypatch, col, llm=llm_down())

    assert doc["status"] == "queued"
    saved = doc["checkpoint"]
    assert set(saved) == {"sentences", "durationMs", "material", "materialWarnings"}
    assert saved["material"] == [
        {"pageNo": 1, "text": "TCP 3-way handshake SYN, ACK"},
        {"pageNo": 3, "text": "QUIC은 UDP 위에서"},
    ]
    assert saved["materialWarnings"] == []
    assert "slide-sas" not in json.dumps(saved, ensure_ascii=False)


def test_retry_reuses_saved_slides_without_downloading_again(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(handlers, "_fetch_slides", Fetch())
    col = queued_job(with_slides())
    attempt(monkeypatch, col, llm=llm_down())
    expired = Fetch(DownloadError("HTTP 403"))  # SAS 만료
    monkeypatch.setattr(handlers, "_fetch_slides", expired)
    speech = expired_sas()
    seen: list[tuple[int, str | None]] = []

    doc = attempt(monkeypatch, col, speech=speech, seen=seen)

    assert (doc["status"], doc["error"]) == ("succeeded", None)
    assert (expired.urls, speech.urls) == ([], [])
    assert doc["result"]["materialUsed"] == {"slidePages": 2, "notes": 0}
    assert doc["result"]["warnings"] == []
    assert "material" not in [s for _, s in seen]


def test_saved_slide_warning_is_kept_on_retry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(handlers, "_fetch_slides", Fetch(b"%PDF"))
    col = queued_job(with_slides())
    attempt(monkeypatch, col, llm=llm_down())
    monkeypatch.setattr(handlers, "_fetch_slides", Fetch())

    doc = attempt(monkeypatch, col)

    assert doc["result"]["warnings"] == [{"code": "NO_SLIDES", "reason": "format"}]


def test_checkpoint_from_before_slides_reads_only_the_slides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fetch = Fetch()
    monkeypatch.setattr(handlers, "_fetch_slides", fetch)
    col = queued_job(with_slides())
    col.update_one(
        {"_id": "j1"},
        {"$set": {"checkpoint": again_input(saved_sentence(0), saved_sentence(1))}},
    )
    speech = expired_sas()

    doc = attempt(monkeypatch, col, llm=llm_down(), speech=speech)

    assert speech.urls == []
    assert fetch.urls == [SLIDES_URL]
    assert set(doc["checkpoint"]) == {"sentences", "durationMs", "material", "materialWarnings"}


@pytest.mark.parametrize(
    "broken",
    [
        {"material": "글", "materialWarnings": []},
        {"material": [], "materialWarnings": "글"},
        {"material": [{"pageNo": 0, "text": "글"}], "materialWarnings": []},
        {
            "material": [{"pageNo": 2, "text": "a"}, {"pageNo": 1, "text": "b"}],
            "materialWarnings": [],
        },
        {"material": [{"pageNo": 1, "text": " "}], "materialWarnings": []},
        {"material": [{"pageNo": 1, "text": "가" * (PAGE_MAX_CHARS + 1)}], "materialWarnings": []},
        {"material": [{"pageNo": 1, "text": "글", "x": 1}], "materialWarnings": []},
        {"material": [], "materialWarnings": [{"code": "NO_SLIDES", "reason": "모름"}]},
        {"material": [], "materialWarnings": [{"code": "PARTIAL", "reason": "slides"}]},
    ],
)
def test_broken_saved_slides_start_over(
    monkeypatch: pytest.MonkeyPatch, broken: JsonObject
) -> None:
    fetch = Fetch()
    monkeypatch.setattr(handlers, "_fetch_slides", fetch)
    col = queued_job(with_slides())
    checkpoint = {**again_input(saved_sentence(0), saved_sentence(1)), **broken}
    col.update_one({"_id": "j1"}, {"$set": {"checkpoint": checkpoint}})
    speech = FakeSpeech()

    doc = attempt(monkeypatch, col, speech=speech)

    assert doc["status"] == "succeeded"
    assert speech.urls == [AUDIO_URL]  # 기존 _from_checkpoint처럼 처음부터
    assert fetch.urls == [SLIDES_URL]


def test_checkpoint_without_slides_url_keeps_its_old_shape(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    col = queued_job({"audioUrl": AUDIO_URL, "notes": [{"text": "필기"}]})

    doc = attempt(monkeypatch, col, llm=llm_down())

    assert set(doc["checkpoint"]) == {"sentences", "durationMs"}


def test_organizing_again_saves_and_reuses_only_the_slides(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(handlers, "_fetch_slides", Fetch())
    inp = {**again_input(saved_sentence(0), saved_sentence(1)), "slidesUrl": SLIDES_URL}
    col = queued_job(inp)

    first = attempt(monkeypatch, col, llm=llm_down())
    assert set(first["checkpoint"]) == {"material", "materialWarnings"}
    expired = Fetch(DownloadError("HTTP 403"))
    monkeypatch.setattr(handlers, "_fetch_slides", expired)

    doc = attempt(monkeypatch, col)

    assert doc["status"] == "succeeded"
    assert expired.urls == []
    assert doc["result"]["materialUsed"]["slidePages"] == 2


def test_result_with_material_is_json_serializable() -> None:
    result = run_with(with_slides(notes=[{"text": "필기"}]), voyage=FakeVoyage())

    assert json.loads(json.dumps(result)) == result
    assert DURATION_MS == result["durationMs"]
