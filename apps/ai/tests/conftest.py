import pytest

from app.core.config import LLM_DEFAULTS, settings


@pytest.fixture(autouse=True)
def claude_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    """시험은 Claude 설정(LLM_PROVIDER=claude와 그 모델)으로 돌립니다.

    코드 기본값은 개발 · 테스트 기간에 학교 LLM(school)이고 배포 때 claude로 되돌리므로, 시험이
    기본값이나 각자 로컬 .env를 따라 달라지지 않게 고정합니다. 학교 LLM을 보는 시험은 지금처럼
    그 시험 안에서 settings를 바꿉니다.
    """
    monkeypatch.setattr(settings, "llm_provider", "claude")
    for field, model in LLM_DEFAULTS["claude"].items():
        monkeypatch.setattr(settings, field, model)
