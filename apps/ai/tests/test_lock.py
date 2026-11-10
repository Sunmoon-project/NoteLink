"""apps/ai/lock.sh(#278): 가짜 uv로 lock 파일 만들기 · --check의 통과 · 실패 경로를 봅니다.

실제 uv는 패키지 색인을 읽으므로 쓰지 않습니다. 가짜 uv는 `-o <출력>`을 받으면 같은 폴더의
`next-<출력 이름>`을 그 자리에 복사합니다(= uv가 새로 고른 결과).
"""

import os
import shutil
import subprocess
from pathlib import Path

import pytest

LOCK_SH = Path(__file__).resolve().parents[1] / "lock.sh"
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None, reason="bash가 없음")

FAKE_UV = """#!/usr/bin/env bash
set -euo pipefail
[[ -n "${FAKE_UV_FAIL:-}" ]] && { echo "uv: 색인을 읽지 못함" >&2; exit 3; }
out=""
while (($#)); do
  if [[ "$1" == "-o" ]]; then out="$2"; shift; fi
  shift
done
cp "$(dirname "$0")/next-$(basename "$out")" "$out"
"""
PROD = "# 머리말\nanthropic==2.3.0\n    # via -r requirements.txt\nhttpx2==2.13.1\n"
DEV = "# 머리말\nanthropic==2.3.0\n    # via\n    #   -c requirements.lock\npytest==9.1.1\n"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    shutil.copy(LOCK_SH, tmp_path / "lock.sh")
    (tmp_path / "requirements.txt").write_text("anthropic==2.3.0\n")
    (tmp_path / "requirements-dev.txt").write_text("-r requirements.txt\npytest==9.1.1\n")
    (tmp_path / "fake-uv").write_text(FAKE_UV, newline="\n")
    (tmp_path / "fake-uv").chmod(0o755)
    for name, text in (("requirements.lock", PROD), ("requirements-dev.lock", DEV)):
        (tmp_path / name).write_text(text, newline="\n")
        (tmp_path / f"next-{name}").write_text(text, newline="\n")
    return tmp_path


def run(repo: Path, *args: str, fail: bool = False) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "UV": "./fake-uv"}
    if fail:
        env["FAKE_UV_FAIL"] = "1"
    assert BASH is not None
    return subprocess.run(
        [BASH, "lock.sh", *args],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )


def test_check_passes_when_the_locks_are_current(repo: Path) -> None:
    r = run(repo, "--check")
    assert r.returncode == 0, r.stderr
    assert "lock 파일 최신" in r.stdout


def test_check_ignores_annotation_differences(repo: Path) -> None:
    # --check는 임시 폴더에 만들어 'via -c <임시 경로>' 주석이 달라짐: 버전 줄만 비교
    (repo / "next-requirements-dev.lock").write_text(
        DEV.replace("-c requirements.lock", "-c /tmp/x/requirements.lock"), newline="\n"
    )
    assert run(repo, "--check").returncode == 0


@pytest.mark.parametrize(
    ("name", "changed"),
    [
        ("requirements.lock", PROD.replace("httpx2==2.13.1", "httpx2==2.14.0")),
        ("requirements-dev.lock", DEV.replace("pytest==9.1.1", "pytest==9.1.0")),
        # 환경 표시(marker)만 달라져도 다른 lock
        ("requirements-dev.lock", DEV + "colorama==0.4.6 ; sys_platform == 'win32'\n"),
    ],
)
def test_check_fails_when_a_lock_is_stale(repo: Path, name: str, changed: str) -> None:
    (repo / f"next-{name}").write_text(changed, newline="\n")
    r = run(repo, "--check")
    assert r.returncode == 1
    assert f"::error::apps/ai/{name}" in r.stdout


def test_check_keeps_the_committed_locks(repo: Path) -> None:
    (repo / "next-requirements.lock").write_text(PROD.replace("2.13.1", "2.14.0"), newline="\n")
    run(repo, "--check")
    assert (repo / "requirements.lock").read_text() == PROD
    assert (repo / "requirements-dev.lock").read_text() == DEV


def test_a_uv_failure_fails_the_check(repo: Path) -> None:
    r = run(repo, "--check", fail=True)
    assert r.returncode == 3
    assert "lock 파일 최신" not in r.stdout
    assert (repo / "requirements.lock").read_text() == PROD


def test_without_check_the_locks_are_rewritten(repo: Path) -> None:
    new = PROD.replace("2.13.1", "2.14.0")
    (repo / "next-requirements.lock").write_text(new, newline="\n")
    r = run(repo)
    assert r.returncode == 0, r.stderr
    assert (repo / "requirements.lock").read_text() == new


def test_a_uv_failure_stops_the_rewrite(repo: Path) -> None:
    r = run(repo, fail=True)
    assert r.returncode == 3
    assert (repo / "requirements-dev.lock").read_text() == DEV
