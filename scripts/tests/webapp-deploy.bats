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
  # 배포 시작(/api/publish)은 START 코드를 낸다(PUBLISH_SLEEP초 걸림). /api/deployments/latest와 배포
  # 상태(deploymentStatus)는 각각 LATEST · STATUS의 줄을 차례로 낸다(다 쓰면 마지막 줄을 되풀이).
  #   fail: 연결 실패(curl 7) · 404: 기록 없음(-w로 코드를 받으면 404, --fail이면 curl 22)
  # latest는 배포 전 조회(-w)부터 센다. --max-time보다 오래 걸리는 응답은 curl처럼 28로 끝난다
  cat > "$BIN/curl" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
url="${*: -1}"
max=""
withcode=""
for ((i = 1; i <= $#; i++)); do
  [ "${!i}" = --max-time ] && { j=$((i + 1)); max="${!j}"; }
  [[ "${!i}" == *'%{http_code}'* ]] && withcode=1
done
wait_for() { # $1초 걸리는 응답: --max-time을 넘으면 그때 시간 초과
  if [ -n "$max" ] && [ "$1" -gt "$max" ]; then
    sleep "$max"
    echo "curl: (28) Operation timed out after ${max}000 milliseconds"
    exit 28
  fi
  sleep "$1"
}
answer() { # $1: 응답 파일, $2: 이 주소를 부른 횟수
  local line
  line=$(sed -n "${2}p" "$1")
  [ -n "$line" ] || line=$(tail -n 1 "$1")
  [ "$line" = fail ] && { echo "curl: (7) Failed to connect"; exit 7; }
  if [ "$line" = 404 ]; then
    [ -n "$withcode" ] && { printf '{"Message":"no deployment"}\n404'; exit 0; }
    echo "curl: (22) The requested URL returned error: 404"
    exit 22
  fi
  printf '%s' "$line"
  [ -n "$withcode" ] && printf '\n200'
  return 0
}
case "$url" in
  */api/publish*) wait_for "${PUBLISH_SLEEP:-0}"; printf '%s' "$START" ;;
  */api/deployments/latest)
    [ -n "$withcode" ] && wait_for "${LATEST_SLEEP:-0}" # 배포 전 조회만 LATEST_SLEEP초 걸림
    answer "$LATEST" "$(grep -c '/api/deployments/latest' "$CALLS")"
    ;;
  */deploymentStatus/*) answer "$STATUS" "$(grep -c '/deploymentStatus/' "$CALLS")" ;;
  *) echo "모르는 주소: $url"; exit 22 ;;
esac
SH
  chmod +x "$BIN/az" "$BIN/curl"
  PATH="$BIN:$PATH"
}

# $1: 최대 기다림(초, 기본 30), $2: 조회 간격(초, 기본 0)
run_deploy() { run bash "$SCRIPT" rg-1 app "$BATS_TEST_TMPDIR/ai.zip" "${1:-30}" "${2:-0}"; }
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
  { echo 404; echo fail; status_of RuntimeSuccessful; echo; } > "$STATUS"
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

@test "배포 기록이 없으면(404) 건너뛸 id 없이 이 배포를 찾는다" {
  printf '%s\n' 404 '{"id":"abc"}' > "$LATEST"
  status_of RuntimeSuccessful > "$STATUS"
  run_deploy
  [ "$status" -eq 0 ]
  [[ "$output" == *"이 앱의 배포 기록 없음"* ]]
  [[ "$output" == *"배포 id: abc"* ]]
}

@test "배포 전 조회가 잠깐 실패하면 다시 읽어, 예전 · 임시 id를 건너뛰고 이 배포를 찾는다" {
  # Codex 재리뷰 #410: 조회 실패를 '기록 없음'으로 보면 시작 뒤 잠깐 보이는 예전 배포(성공)를 이
  # 배포로 잡아, 이 배포를 확인하지 않고 성공으로 끝났음
  printf '%s\n' fail '{"id":"old"}' '{"id":"old"}' '{"id":"temp-1"}' '{"id":"abc"}' > "$LATEST"
  status_of RuntimeSuccessful > "$STATUS"
  run_deploy
  [ "$status" -eq 0 ]
  [[ "$output" == *"배포 전 최근 배포를 다시 읽음"* ]]
  [[ "$output" == *"배포 전 최근 배포 id: old"* ]]
  [[ "$output" == *"배포 id: abc"* ]]
  ! called "/deploymentStatus/old"
}

@test "배포 전 조회를 끝내 못 하면 배포를 시작하지 않고 1" {
  echo fail > "$LATEST"
  run_deploy 3
  [ "$status" -eq 1 ]
  [[ "$output" == *"배포 전 최근 배포를 읽지 못해 배포를 시작하지 않았습니다"* ]]
  ! called "/api/publish"
}

@test "배포 전 조회를 다시 기다리다 정한 시간이 지나면 다시 읽지 않고 배포를 시작하지 않는다" {
  # Codex 재리뷰 #410: 시간이 지난 뒤 한 번 더 읽어 성공하면 배포를 시작하고, id 확인은 못 한 채
  # 실패로 끝났음. 간격(5초)이 남은 시간(2초)보다 길어 기다리는 동안 시간이 다 감
  printf '%s\n' fail '{"id":"old"}' > "$LATEST"
  run_deploy 2 5
  [ "$status" -eq 1 ]
  [[ "$output" == *"배포 전 최근 배포를 읽지 못해 배포를 시작하지 않았습니다"* ]]
  [ "$(called '/api/deployments/latest' | wc -l)" -eq 1 ]
  ! called "/api/publish"
}

@test "배포 전 조회에 정한 시간을 다 쓰면 배포를 시작하지 않는다" {
  # 조회가 시간 안에 끝나도(또는 시간 초과로 끝나도) 남은 시간이 없으면 업로드하지 않음
  printf '%s\n' '{"id":"old"}' > "$LATEST"
  export LATEST_SLEEP=2
  run_deploy 2
  [ "$status" -eq 1 ]
  [[ "$output" == *"배포를 시작하지 않았습니다"* ]]
  ! called "/api/publish"
}

@test "업로드도 정한 시간 안에서만 기다린다" {
  # Codex 재리뷰 #410: 업로드는 600초 상한이 따로 있어 짧은 limit을 넘겼음
  printf '%s\n' '{"id":"old"}' > "$LATEST"
  export PUBLISH_SLEEP=60
  SECONDS=0
  run_deploy 3
  [ "$status" -eq 1 ]
  [ "$SECONDS" -lt 15 ]
  [[ "$output" == *"배포를 시작하지 못했습니다"* ]]
  max=$(called "/api/publish" | grep -oE -- '--max-time [0-9]+' | awk '{ print $2 }')
  [ "$max" -le 3 ]
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
