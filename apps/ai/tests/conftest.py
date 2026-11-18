import pytest

from app.core.config import LLM_DEFAULTS, settings
from app.worker import handlers


@pytest.fixture(autouse=True)
def claude_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """시험은 Claude 설정(LLM_PROVIDER=claude와 그 모델)으로 돌립니다.

    코드 기본값은 개발 · 테스트 기간에 학교 LLM(school)이고 배포 때 claude로 되돌리므로, 시험이
    기본값이나 각자 로컬 .env를 따라 달라지지 않게 고정합니다. 학교 LLM을 보는 시험은 지금처럼
    그 시험 안에서 settings를 바꿉니다.
    """
    monkeypatch.setattr(settings, "llm_provider", "claude")
    monkeypatch.setattr(settings, "note_split_provider", None)
    for field, model in LLM_DEFAULTS["claude"].items():
        monkeypatch.setattr(settings, field, model)
    # 문단 나누기도 시험이 바꿔 끼운 handlers._llm을 씀(따로 보는 시험은 그 안에서 바꿈)
    monkeypatch.setattr(handlers, "make_split_llm", lambda *args: None)
    handlers._split_client.cache_clear()
    handlers._clients.cache_clear()  # 앞 시험의 설정으로 만든 클라이언트를 남기지 않음
