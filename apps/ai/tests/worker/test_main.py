import signal
import threading
from collections.abc import Iterator

import pytest
from pydantic import SecretStr

from app.core.config import settings
from app.worker import __main__ as entry


def test_worker_refuses_to_start_without_db_address(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "mongodb_uri", SecretStr(""))
    with pytest.raises(SystemExit, match="MONGODB_URI"):
        entry.main()


def test_worker_with_jobs_refuses_to_start_without_llm_address(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "mongodb_uri", SecretStr("mongodb://127.0.0.1:27017"))
    monkeypatch.setattr(settings, "school_llm_base_url", "")
    monkeypatch.setitem(entry.HANDLERS, "quiz_generate", lambda inp, report: {})
    with pytest.raises(SystemExit, match="SCHOOL_LLM_BASE_URL"):
        entry.main()


@pytest.fixture
def keep_signal_handlers() -> Iterator[None]:
    saved = {sig: signal.getsignal(sig) for sig in entry.STOP_SIGNALS}
    yield
    for sig, handler in saved.items():
        signal.signal(sig, handler)


@pytest.mark.usefixtures("keep_signal_handlers")
@pytest.mark.parametrize("first", list(entry.STOP_SIGNALS))
def test_first_signal_asks_to_stop_and_the_next_one_ends_at_once(first: signal.Signals) -> None:
    stop = threading.Event()
    entry.stop_on_signal(stop)
    handler = signal.getsignal(first)
    assert callable(handler) and not stop.is_set()
    handler(first, None)
    assert stop.is_set()  # 지금 작업을 끝낸 뒤 멈춤
    assert all(signal.getsignal(sig) == signal.SIG_DFL for sig in entry.STOP_SIGNALS)
