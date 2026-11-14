#!/usr/bin/env bats
# AI 서버 배포(kudu-zip-deploy.sh) 테스트. az · curl은 정해 둔 응답을 내는 가짜로 바꾼다.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../kudu-zip-deploy.sh"
  BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BIN"
  export POLLS="$BATS_TEST_TMPDIR/polls" CALLS="$BATS_TEST_TMPDIR/calls" START="202"
  export LOCATION="https://app.scm/api/deployments/new"
  : > "$CALLS"
  printf 'PK' > "$BATS_TEST_TMPDIR/ai.zip"
  cat > "$BIN/az" <<'SH'
#!/usr/bin/env bash
[ "${AZ_FAIL:-}" = 1 ] && exit 1
echo token
SH
  # POST(배포 시작)는 START 코드와 LOCATION 헤더를 낸다. GET(상태 확인)은 POLLS의 줄을 차례로 낸다
  # ("fail"이면 조회 실패, 다 쓰면 마지막 줄을 되풀이)
  cat > "$BIN/curl" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
if [[ " $* " == *" -X POST "* ]]; then
  while [ $# -gt 0 ]; do [ "$1" = -D ] && { printf 'HTTP/1.1 %s\r\nLocation: %s\r\n' "$START" "$LOCATION" > "$2"; }; shift; done
  printf '%s' "$START"
  exit 0
fi
n=$(grep -vc -- '-X POST' "$CALLS")
line=$(sed -n "${n}p" "$POLLS")
[ -n "$line" ] || line=$(tail -n 1 "$POLLS")
[ "$line" = fail ] && { echo "curl: (22) 403 Forbidden"; exit 22; }
printf '%s' "$line"
SH
  chmod +x "$BIN/az" "$BIN/curl"
  PATH="$BIN:$PATH"
}

run_deploy() { run bash "$SCRIPT" app "$BATS_TEST_TMPDIR/ai.zip" "${1:-5}" 0; }

@test "진행 중이면 기다리고, 성공(status 4)으로 끝나면 0" {
  printf '%s\n' '{"complete":false,"status":1}' '{"complete":true,"status":4}' > "$POLLS"
  run_deploy
  [ "$status" -eq 0 ]
  [[ "$output" == *"배포 시작: https://app.scm/api/deployments/new"* ]]
  [[ "$output" == *"확인 2/5: status=4 complete=true"* ]]
}

@test "실패(status 3)로 끝나면 1이고 배포 로그 주소를 남긴다" {
  printf '%s\n' '{"complete":true,"status":3}' > "$POLLS"
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"https://app.scm/api/deployments/new/log"* ]]
}

@test "조회 실패는 다시 시도하고, 그 뒤 성공하면 0" {
  printf '%s\n' fail '{"complete":true,"status":4}' > "$POLLS"
  run_deploy
  [ "$status" -eq 0 ]
  [[ "$output" == *"확인 1/5: 상태를 읽지 못함"* ]]
}

@test "끝까지 안 끝나면 1이고, 마지막 조회 오류를 남긴다" {
  printf '%s\n' '{"complete":false,"status":1}' fail > "$POLLS"
  run_deploy 3
  [ "$status" -eq 1 ]
  [[ "$output" == *"마지막 조회 오류: curl: (22) 403 Forbidden"* ]]
}

@test "배포 시작이 202가 아니면 바로 1" {
  START=409
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"HTTP 409"* ]]
}

@test "Azure 토큰을 못 받으면 바로 1" {
  AZ_FAIL=1 run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"az login"* ]]
}

# 실제 Kudu의 Location은 그 배포가 아니라 가장 최근 배포의 주소(쿼리 포함)라, 처음 읽은 id로 고정한다
# (Codex 리뷰 #387)
KUDU_LATEST="https://app.scm/api/deployments/latest?deployer=Push-Deployer&time=2026-11-14_01-00-00Z"

polled() { grep -v -- '-X POST' "$CALLS" | awk '{ print $NF }'; }

@test "처음 읽은 배포 id로 고정해, 그 뒤로는 그 배포의 주소를 확인한다" {
  LOCATION="$KUDU_LATEST"
  printf '%s\n' '{"id":"abc","complete":false,"status":1}' '{"id":"abc","complete":true,"status":4}' > "$POLLS"
  run_deploy
  [ "$status" -eq 0 ]
  [[ "$output" == *"배포 id: abc"* ]]
  [ "$(polled | sed -n 1p)" = "$KUDU_LATEST" ]
  [ "$(polled | sed -n 2p)" = "https://app.scm/api/deployments/abc" ]
}

@test "고정한 뒤 다른 배포 id의 상태가 오면 그 결과로 판정하지 않고 1" {
  LOCATION="$KUDU_LATEST"
  printf '%s\n' '{"id":"abc","complete":false,"status":1}' '{"id":"zzz","complete":true,"status":4}' > "$POLLS"
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"다른 배포(id=zzz)"* ]]
}

@test "실패하면 로그 주소를 배포 id로 만든다(쿼리 뒤에 /log를 잇지 않음)" {
  LOCATION="$KUDU_LATEST"
  printf '%s\n' '{"id":"abc","complete":true,"status":3}' > "$POLLS"
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"로그: https://app.scm/api/deployments/abc/log"* ]]
  [[ "$output" != *"time=2026-11-14_01-00-00Z/log"* ]]
}

@test "id 없이 실패하면 쿼리를 뗀 Location으로 로그 주소를 만든다" {
  LOCATION="$KUDU_LATEST"
  printf '%s\n' '{"complete":true,"status":3}' > "$POLLS"
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"로그: https://app.scm/api/deployments/latest/log"* ]]
}
