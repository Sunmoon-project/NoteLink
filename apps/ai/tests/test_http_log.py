import logging

import httpx2
import pytest

import app
from app.clients.speech import Speech, SpeechError
from app.core.http_log import HTTP_LOGGER, HideQueryFilter, hide_query, install

FAKE_SAS = "sv=2025-01-01&sp=r&sig=FAKESIG"


@pytest.mark.parametrize(
    ("url", "shown"),
    [
        (f"https://blob.test/a.jpg?{FAKE_SAS}", "https://blob.test/a.jpg?REDACTED"),
        (f"http://blob.test/a.jpg?{FAKE_SAS}#x", "http://blob.test/a.jpg?REDACTED"),
        ("https://blob.test/a.jpg", "https://blob.test/a.jpg"),  # 쿼리가 없으면 그대로
        ("GET", "GET"),  # 주소가 아니면 그대로
        ("note?sig=x", "note?sig=x"),
    ],
)
def test_hide_query(url: str, shown: str) -> None:
    assert hide_query(url) == shown


def test_filter_is_installed_once_when_app_is_imported() -> None:
    assert app is not None
    install()  # 여러 번 불러도 하나
    filters = [f for f in logging.getLogger(HTTP_LOGGER).filters if isinstance(f, HideQueryFilter)]
    assert len(filters) == 1


def test_filter_hides_url_args_but_keeps_the_record() -> None:
    record = logging.LogRecord(
        HTTP_LOGGER,
        logging.INFO,
        __file__,
        1,
        "HTTP Request: %s %s %d",
        ("GET", httpx2.URL(f"https://blob.test/a.jpg?{FAKE_SAS}"), 200),
        None,
    )
    assert HideQueryFilter().filter(record) is True
    assert record.getMessage() == "HTTP Request: GET https://blob.test/a.jpg?REDACTED 200"


@pytest.mark.parametrize("status", [200, 404])
def test_speech_does_not_log_the_audio_sas(status: int, caplog: pytest.LogCaptureFixture) -> None:
    # 녹음 주소(SAS)는 요청 본문에만 담기고, 요청 주소는 api-version뿐
    caplog.set_level(logging.DEBUG)
    transport = httpx2.MockTransport(lambda request: httpx2.Response(status, json={}))
    client = Speech("https://speech.test", "key", transport=transport, sleep=lambda s: None)
    with pytest.raises(SpeechError):
        client.transcribe(f"https://blob.test/r.m4a?{FAKE_SAS}")
    assert [r for r in caplog.records if r.name == HTTP_LOGGER]
    assert "FAKESIG" not in caplog.text
