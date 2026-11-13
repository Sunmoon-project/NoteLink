"""scripts/env-vault.sh pull이 쓰는 .env 줄을 AI 서버와 같은 로더
(pydantic-settings · python-dotenv)로 다시 읽어, 받아 준 값은 원문 그대로이고
거르는 값은 실제로 바뀌는 값인지 확인합니다(#375).

스크립트의 env_line을 bash로 불러 줄을 만듭니다. bats 시험은 줄 모양만 보므로
로더와의 차이는 여기서 봅니다.
"""

import shutil
import subprocess
from pathlib import Path

import pytest
from pydantic_settings import BaseSettings

from app.core.config import Settings

SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "env-vault.sh"
BASH = shutil.which("bash")
SOURCE_FAILED = 99  # 스크립트를 source하지 못했을 때의 반환값(거절 1 · 2와 섞이지 않게)


def _bash_skip_reason() -> str | None:
    """bash가 없거나, 있어도 이 경로의 스크립트를 읽지 못하면(Windows의 WSL bash 등) 건너뜀."""
    if BASH is None:
        return "bash 없음"
    probe = subprocess.run([BASH, "-c", '[ -f "$1" ]', "t", SCRIPT.as_posix()], check=False)
    return None if probe.returncode == 0 else f"{BASH}가 {SCRIPT}를 읽지 못함(WSL bash 등)"


SKIP_REASON = _bash_skip_reason() if SCRIPT.is_file() else None
needs_bash = pytest.mark.skipif(SKIP_REASON is not None, reason=SKIP_REASON or "")


class Loaded(BaseSettings):
    """app.core.config.Settings와 같은 설정(env_file 등)으로 읽음 — 서버 설정이 바뀌면 따라감."""

    model_config = Settings.model_config

    token: str = ""


def env_line(value: str, app: str = "ai") -> tuple[int, str]:
    """env-vault.sh의 env_line TOKEN <값> <앱> → (반환값, 쓴 줄)."""
    assert BASH is not None
    # 값은 표준 입력으로(Windows Git Bash는 명령줄 인자의 따옴표를 풀어 버림). $0을 스크립트 경로로
    # 두면 스크립트가 직접 실행된 것으로 보고 main을 돎
    code = (
        f'source "$1" || exit {SOURCE_FAILED}; v=$(cat; printf x); env_line TOKEN "${{v%x}}" "$2"'
    )
    run = subprocess.run(
        [BASH, "-c", code, "t", SCRIPT.as_posix(), app],
        input=value.encode(),  # 바이트로: 텍스트 모드는 Windows에서 \n을 \r\n으로 바꿈
        capture_output=True,
        check=False,
    )
    assert run.returncode != SOURCE_FAILED, run.stderr.decode()
    return run.returncode, run.stdout.decode()


def test_the_script_is_where_these_tests_read_it() -> None:
    assert SCRIPT.is_file(), f"{SCRIPT}가 없음 — 옮겼으면 이 시험의 SCRIPT도 고침"


def load(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, text: str) -> str:
    (tmp_path / ".env").write_bytes(
        text.encode()
    )  # pull처럼 LF 그대로(텍스트 모드는 Windows에서 \r\n)
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("TOKEN", raising=False)
    return Loaded().token


@needs_bash
@pytest.mark.parametrize(
    "value",
    [
        "sk-ant-abc_123",
        "mongodb+srv://u:p@c.mongodb.net/notelink?retryWrites=true&w=majority",
        "local dev",
        "p$q",
        "$HOME",
        "ab${cd",  # 닫는 }가 없으면 python-dotenv도 바꾸지 않음
        'a"b',
        "hash # not a comment",
        "semi;colon",
        " lead and trail ",
        "노트링크",
    ],
)
def test_values_pull_writes_load_back_unchanged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    rc, line = env_line(value)
    assert rc == 0
    assert load(tmp_path, monkeypatch, line) == value


@needs_bash
@pytest.mark.parametrize("value", ["abc${UNSET}def", "x${}y", "p${Q:-d}r"])
def test_closed_dollar_brace_is_refused_because_the_loader_changes_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    rc, _ = env_line(value)
    assert rc == 2
    # 거르지 않고 작은따옴표로 써 두면 로더가 실제로 바꿔 읽음
    assert load(tmp_path, monkeypatch, f"TOKEN='{value}'\n") != value
    # api(Node dotenv)는 바꾸지 않으므로 받음
    assert env_line(value, "api")[0] == 0


def test_a_shell_variable_keeps_dollar_brace_and_wins_over_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """DOLLAR_HINT의 안내: 셸 환경 변수는 .env보다 먼저 쓰이고 ${…}를 바꾸지 않음."""
    (tmp_path / ".env").write_text("TOKEN='from-env-file'\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("TOKEN", "abc${UNSET}def")
    assert Loaded().token == "abc${UNSET}def"


@needs_bash
@pytest.mark.parametrize("value", ["it's", "a\\b", "a\nb", "a\rb"])
def test_quote_backslash_newline_are_refused(value: str) -> None:
    assert env_line(value)[0] == 1
