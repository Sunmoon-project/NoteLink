import json
from email.parser import BytesParser
from email.policy import HTTP

import httpx2
import pytest

from app.clients import speech as speech_module
from app.clients.llm import USER_AGENT
from app.clients.speech import (
    API_VERSION,
    NoSpeechError,
    Phrase,
    Speech,
    SpeechError,
    SpeechUnavailableError,
    Transcript,
    Word,
)

AUDIO_URL = "https://blob.example.test/recordings/a.m4a?sig=secret-sas"


class Server:
    """보낸 요청을 모아 두고 준비한 응답을 차례로 돌려주는 가짜 서버."""

    def __init__(self, *responses: httpx2.Response | Exception) -> None:
        self.responses = list(responses)
        self.requests: list[httpx2.Request] = []
        self.slept: list[float] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response

    def client(self) -> Speech:
        return Speech(
            "https://speech.example.test/",
            "speech-key",
            transport=httpx2.MockTransport(self.handle),
            sleep=self.slept.append,
        )


def word(text: str, offset: int, duration: int) -> dict[str, object]:
    return {"text": text, "offsetMilliseconds": offset, "durationMilliseconds": duration}


def result(*phrases: dict[str, object], duration: int = 182439) -> httpx2.Response:
    return httpx2.Response(
        200,
        json={
            "durationMilliseconds": duration,
            "combinedPhrases": [{"text": "전체 글"}],
            "phrases": list(phrases),
        },
    )


HELLO: dict[str, object] = {
    "offsetMilliseconds": 960,
    "durationMilliseconds": 640,
    "text": "안녕하세요 여러분.",
    "words": [word("안녕하세요", 960, 240), word("여러분.", 1200, 400)],
    "locale": "ko-KR",
    "confidence": 0.93,
}


def definition(request: httpx2.Request) -> dict[str, object]:
    head = f"Content-Type: {request.headers['content-type']}\r\n\r\n".encode()
    parts = BytesParser(policy=HTTP).parsebytes(head + request.content).iter_parts()
    fields = {part.get_param("name", header="content-disposition"): part for part in parts}
    assert list(fields) == ["definition"]  # 파일은 주소로 넘기므로 audio 칸이 없음
    payload = fields["definition"].get_payload(decode=True)
    assert isinstance(payload, bytes)
    out: dict[str, object] = json.loads(payload)
    return out


def test_transcribe_converts_phrases_and_word_times() -> None:
    assert Server(result(HELLO)).client().transcribe(AUDIO_URL) == Transcript(
        duration_ms=182439,
        phrases=(
            Phrase(
                text="안녕하세요 여러분.",
                start_ms=960,
                duration_ms=640,
                words=(Word("안녕하세요", 960, 240), Word("여러분.", 1200, 400)),
            ),
        ),
    )


def test_transcribe_keeps_phrase_without_word_times() -> None:
    no_words = {k: v for k, v in HELLO.items() if k != "words"}
    out = Server(result(no_words)).client().transcribe(AUDIO_URL)
    assert out.phrases[0].words == ()


def test_transcribe_request_shape() -> None:
    s = Server(result(HELLO))
    s.client().transcribe(AUDIO_URL)
    request = s.requests[0]
    assert request.method == "POST"
    assert request.url.host == "speech.example.test"
    assert request.url.path == "/speechtotext/transcriptions:transcribe"
    assert request.url.params["api-version"] == API_VERSION
    assert request.headers["ocp-apim-subscription-key"] == "speech-key"
    assert request.headers["user-agent"] == USER_AGENT
    assert request.headers["content-type"].startswith("multipart/form-data")
    assert definition(request) == {"locales": ["ko-KR"], "audioUrl": AUDIO_URL}


@pytest.mark.parametrize(
    "phrases",
    [[], [{**HELLO, "text": ""}], [{**HELLO, "text": "  "}]],
    ids=["empty", "blank-text", "spaces-only"],
)
def test_transcribe_no_speech(phrases: list[dict[str, object]]) -> None:
    with pytest.raises(NoSpeechError):
        Server(result(*phrases)).client().transcribe(AUDIO_URL)


def test_transcribe_no_phrases_field_is_no_speech() -> None:
    body = httpx2.Response(200, json={"durationMilliseconds": 5000})
    with pytest.raises(NoSpeechError):
        Server(body).client().transcribe(AUDIO_URL)


def test_transcribe_drops_blank_phrase_among_real_ones() -> None:
    out = Server(result({**HELLO, "text": " "}, HELLO)).client().transcribe(AUDIO_URL)
    assert [p.text for p in out.phrases] == ["안녕하세요 여러분."]


@pytest.mark.parametrize("status", [429, 500, 503])
def test_transcribe_retries_transient_status_then_succeeds(status: int) -> None:
    s = Server(httpx2.Response(status), result(HELLO))
    assert s.client().transcribe(AUDIO_URL).duration_ms == 182439
    assert len(s.requests) == 2
    assert s.slept == [2.0]


def test_transcribe_retries_connection_error_then_succeeds() -> None:
    s = Server(httpx2.ConnectError("끊김"), result(HELLO))
    assert s.client().transcribe(AUDIO_URL).duration_ms == 182439
    assert s.slept == [2.0]


def test_transcribe_retries_read_timeout_then_succeeds() -> None:
    s = Server(httpx2.ReadTimeout("시간 초과"), result(HELLO))
    assert s.client().transcribe(AUDIO_URL).duration_ms == 182439


def test_transcribe_follows_retry_after() -> None:
    s = Server(httpx2.Response(429, headers={"retry-after": "7"}), result(HELLO))
    s.client().transcribe(AUDIO_URL)
    assert s.slept == [7.0]


@pytest.mark.parametrize("value", ["Wed, 21 Oct 2026 07:28:00 GMT", "-3", "nan", "inf"])
def test_transcribe_ignores_unusable_retry_after(value: str) -> None:
    s = Server(httpx2.Response(429, headers={"retry-after": value}), result(HELLO))
    s.client().transcribe(AUDIO_URL)
    assert s.slept == [2.0]


def test_transcribe_gives_up_after_retry_limit_with_doubling_waits() -> None:
    s = Server(*[httpx2.Response(503) for _ in range(6)])
    with pytest.raises(SpeechUnavailableError, match="503"):
        s.client().transcribe(AUDIO_URL)
    assert len(s.requests) == 6  # 처음 1번 + 다시 5번
    assert s.slept == [2.0, 4.0, 8.0, 16.0, 32.0]  # 마지막 실패 뒤에는 기다리지 않음


def test_transcribe_connection_error_message_hides_audio_url() -> None:
    s = Server(*[httpx2.ConnectError(f"끊김 {AUDIO_URL}") for _ in range(6)])
    with pytest.raises(SpeechUnavailableError) as e:
        s.client().transcribe(AUDIO_URL)
    assert "secret-sas" not in str(e.value)


@pytest.mark.parametrize("status", [400, 401, 403, 404, 415, 422])
def test_transcribe_does_not_retry_permanent_status(status: int) -> None:
    s = Server(httpx2.Response(status, json={"message": f"bad {AUDIO_URL}"}))
    with pytest.raises(SpeechError, match=str(status)) as e:
        s.client().transcribe(AUDIO_URL)
    assert not isinstance(e.value, SpeechUnavailableError | NoSpeechError)
    assert "secret-sas" not in str(e.value)
    assert len(s.requests) == 1
    assert s.slept == []


@pytest.mark.parametrize(
    "response",
    [
        httpx2.Response(200, text="not json"),
        httpx2.Response(200, json=[]),
        httpx2.Response(200, json={"phrases": []}),
        httpx2.Response(200, json={"durationMilliseconds": "길다", "phrases": []}),
        httpx2.Response(200, json={"durationMilliseconds": 1, "phrases": [{"text": "글"}]}),
        httpx2.Response(200, json={"durationMilliseconds": 1, "phrases": [{**HELLO, "text": 3}]}),
        httpx2.Response(
            200, json={"durationMilliseconds": 1, "phrases": [{**HELLO, "words": [1]}]}
        ),
    ],
    ids=["not-json", "list", "no-duration", "bad-duration", "no-times", "bad-text", "bad-word"],
)
def test_transcribe_rejects_bad_response_shape(response: httpx2.Response) -> None:
    s = Server(response)
    with pytest.raises(SpeechError, match="응답 모양") as e:
        s.client().transcribe(AUDIO_URL)
    assert not isinstance(e.value, NoSpeechError)
    assert len(s.requests) == 1


def test_speech_factory_requires_endpoint_and_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(speech_module.settings, "azure_speech_endpoint", "")
    with pytest.raises(SpeechError, match="AZURE_SPEECH"):
        speech_module.speech()
