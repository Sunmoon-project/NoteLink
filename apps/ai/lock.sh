#!/usr/bin/env bash
# requirements*.txt(직접 의존성)에서 간접 의존성까지 고정한 lock 파일을 만듭니다(#278).
#   bash lock.sh          패키지를 더하거나 버전을 바꾼 뒤 실행해 lock 파일을 함께 커밋
#   bash lock.sh --check  lock 파일이 requirements*.txt와 맞는지 확인만(CI)
# 이미 있는 lock 파일의 버전을 그대로 두고 바뀐 것만 다시 고릅니다(uv). Windows · Linux 모두
# 같은 파일을 쓰도록 --universal로 만듭니다.
set -euo pipefail
cd "$(dirname "$0")"

UV="${UV:-uv}"
compile() { # <입력> <출력> [추가 인자...]
  local in="$1" out="$2"
  shift 2
  "$UV" pip compile "$in" --universal --python-version 3.13 -q \
    --custom-compile-command "bash apps/ai/lock.sh" -o "$out" "$@"
}

if [[ "${1:-}" == "--check" ]]; then
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  cp requirements.lock requirements-dev.lock "$tmp/"
  compile requirements.txt "$tmp/requirements.lock"
  compile requirements-dev.txt "$tmp/requirements-dev.lock" -c "$tmp/requirements.lock"
  # 주석(via -c 경로)은 다를 수 있어 버전 줄만 비교
  for f in requirements.lock requirements-dev.lock; do
    if ! diff <(grep -E '^[A-Za-z0-9]' "$f") <(grep -E '^[A-Za-z0-9]' "$tmp/$f"); then
      echo "::error::apps/ai/$f가 requirements*.txt와 맞지 않습니다. bash apps/ai/lock.sh를 실행해 커밋하세요"
      exit 1
    fi
  done
  echo "lock 파일 최신"
  exit 0
fi

compile requirements.txt requirements.lock
compile requirements-dev.txt requirements-dev.lock -c requirements.lock
