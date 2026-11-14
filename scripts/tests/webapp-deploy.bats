#!/usr/bin/env bats
# App Service 배포(webapp-deploy.sh) 테스트. az · curl은 정해 둔 응답을 내는 가짜로 바꾼다.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../webapp-deploy.sh"
  BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BIN"
  export CALLS="$BATS_TEST_TMPDIR/calls" LATEST="$BATS_TEST_TMPDIR/latest" STATUS="$BATS_TEST_TMPDIR/status"
  export START="202" SCM_HOST="app.scm.azurewebsites.net"
  : > "$CALLS"
  printf 'PK' > "$BATS_TEST_TMPDIR/ai.zip"
  cat > "$BIN/az" <<'SH'
#!/usr/bin/env bash
case "$*" in
  *"account get-access-token"*) [ "${AZ_FAIL:-}" = 1 ] && exit 1; echo token ;;
  *"account show"*) echo sub-1 ;;
  *"webapp show"*) echo "$SCM_HOST" ;;
esac
SH
  # 배포 시작(/api/publish)은 START 코드를 낸다. /api/deployments/latest와 배포 상태(deploymentStatus)는
  # 각각 LATEST · STATUS의 줄을 차례로 낸다("fail"이면 조회 실패, 다 쓰면 마지막 줄을 되풀이).
  # latest의 첫 줄은 배포를 시작하기 전의 최근 배포다
  cat > "$BIN/curl" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
url="${*: -1}"
answer() { # $1: 응답 파일, $2: 이 주소를 부른 횟수
  local line
  line=$(sed -n "${2}p" "$1")
  [ -n "$line" ] || line=$(tail -n 1 "$1")
  [ "$line" = fail ] && { echo "curl: (22) The requested URL returned error: 404"; exit 22; }
  printf '%s' "$line"
}
case "$url" in
  */api/publish*) printf '%s' "$START" ;;
  */api/deployments/latest) answer "$LATEST" "$(grep -c '/api/deployments/latest' "$CALLS")" ;;
  */deploymentStatus/*) answer "$STATUS" "$(grep -c '/deploymentStatus/' "$CALLS")" ;;
  *) echo "모르는 주소: $url"; exit 22 ;;
esac
SH
  chmod +x "$BIN/az" "$BIN/curl"
  PATH="$BIN:$PATH"
}

run_deploy() { run bash "$SCRIPT" rg-1 app "$BATS_TEST_TMPDIR/ai.zip" "${1:-30}" 0; }
called() { grep -- "$1" "$CALLS"; }
status_of() { printf '{"properties":{"status":"%s"%s}}' "$1" "${2:-}"; }

@test "설치 · 앱 시작까지 기다리고, RuntimeSuccessful이면 0" {
  printf '%s\n' '{"id":"old"}' '{"id":"abc"}' > "$LATEST"
  { status_of BuildInProgress; echo; status_of RuntimeStarting; echo; status_of RuntimeSuccessful; echo; } > "$STATUS"
  run_deploy
  [ "$status" -eq 0 ]
  [[ "$output" == *"배포 id: abc"* ]]
  [[ "$output" == *"상태: RuntimeStarting"* ]]
  called "https://app.scm.azurewebsites.net/api/publish?type=zip&async=true"
  called "https://management.azure.com/subscriptions/sub-1/resourceGroups/rg-1/providers/Microsoft.Web/sites/app/deploymentStatus/abc?api-version=2025-05-01"
}

@test "Kudu의 임시 배포(temp-…)와 시작 전 배포 id는 이 배포로 잡지 않는다" {
  # Codex 리뷰 #410: temp-… 기록은 실제 배포가 생기면 지워져, 잡으면 성공한 배포도 404만 보다 실패
  printf '%s\n' '{"id":"old"}' '{"id":"old"}' '{"id":"temp-1b2c"}' '{"id":"abc"}' > "$LATEST"
  status_of RuntimeSuccessful > "$STATUS"
  run_deploy
  [ "$status" -eq 0 ]
  [[ "$output" == *"배포 id: abc"* ]]
  ! called "/deploymentStatus/temp"
  ! called "/deploymentStatus/old"
}

@test "패키지 설치가 실패하면(BuildFailed) 1이고 빌드 로그 주소와 오류를 남긴다" {
  printf '%s\n' '{"id":"old"}' '{"id":"abc"}' > "$LATEST"
  status_of BuildFailed ',"errors":[{"message":"pip install failed","extendedCode":"54000"}]' > "$STATUS"
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"빌드 로그: https://app.scm.azurewebsites.net/api/deployments/abc/log"* ]]
  [[ "$output" == *"오류: pip install failed 54000"* ]]
}

@test "앱이 시작하지 못하면(RuntimeFailed) 1이고 실패 수 · 인스턴스 로그 · 시작 로그 명령을 남긴다" {
  # Codex 리뷰 #410: 배포 완료(status 4)만 보면 앱 시작 실패를 놓침
  printf '%s\n' '{"id":"old"}' '{"id":"abc"}' > "$LATEST"
  status_of RuntimeFailed ',"numberOfInstancesFailed":1,"failedInstancesLogs":["https://app.scm/logs/1"]' > "$STATUS"
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"실패한 인스턴스 1개"* ]]
  [[ "$output" == *"실패한 인스턴스 로그: https://app.scm/logs/1"* ]]
  [[ "$output" == *"az webapp log startup show -n app -g rg-1"* ]]
}

@test "설치가 성공해도(BuildSuccessful) 그 뒤 앱이 시작하지 못하면 1" {
  # Codex 리뷰 #410: 설치 성공을 배포 성공으로 보지 않고 앱 시작 결과까지 봄
  printf '%s\n' '{"id":"old"}' '{"id":"abc"}' > "$LATEST"
  { status_of BuildSuccessful; echo; status_of RuntimeStarting; echo; status_of RuntimeFailed; echo; } > "$STATUS"
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"상태: BuildSuccessful"* ]]
  [[ "$output" == *"앱이 시작하지 못했습니다"* ]]
}

@test "배포 상태가 아직 없으면(404) 다시 보고, 그 뒤 성공하면 0" {
  printf '%s\n' '{"id":"old"}' '{"id":"abc"}' > "$LATEST"
  { echo fail; status_of RuntimeSuccessful; echo; } > "$STATUS"
  run_deploy
  [ "$status" -eq 0 ]
}

@test "끝나지 않으면 정한 시간(경과 시간)에 1이고 마지막 상태를 남긴다" {
  printf '%s\n' '{"id":"old"}' '{"id":"abc"}' > "$LATEST"
  status_of BuildInProgress > "$STATUS"
  SECONDS=0
  run_deploy 6 # 배포 id를 찾는 데 쓰는 시간도 같은 상한에 듦: 느린 PC에서도 상태 확인까지 가게 넉넉히
  [ "$status" -eq 1 ]
  [ "$SECONDS" -lt 20 ]
  [[ "$output" == *"6초 안에 끝나지 않았습니다(마지막 상태: BuildInProgress)"* ]]
}

@test "이 배포의 id가 끝내 나오지 않으면 1" {
  printf '%s\n' '{"id":"old"}' '{"id":"temp-1"}' > "$LATEST"
  run_deploy 2
  [ "$status" -eq 1 ]
  [[ "$output" == *"이 배포의 id를 찾지 못했습니다"* ]]
}

@test "시작 전 최근 배포가 없어도(조회 실패) 이 배포를 찾는다" {
  printf '%s\n' fail '{"id":"abc"}' > "$LATEST"
  status_of RuntimeSuccessful > "$STATUS"
  run_deploy
  [ "$status" -eq 0 ]
  [[ "$output" == *"배포 id: abc"* ]]
}

@test "배포 시작이 202 · 200이 아니면 바로 1" {
  START=409
  printf '%s\n' '{"id":"old"}' > "$LATEST"
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"HTTP 409"* ]]
}

@test "Azure 토큰을 못 받으면 바로 1" {
  AZ_FAIL=1 run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"az login"* ]]
}

@test "앱의 배포(scm) 주소를 못 읽으면 바로 1" {
  SCM_HOST=""
  run_deploy
  [ "$status" -eq 1 ]
  [[ "$output" == *"배포(scm) 주소를 읽지 못했습니다"* ]]
}
