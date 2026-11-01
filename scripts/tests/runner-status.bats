#!/usr/bin/env bats
# scripts/runner-status.sh 의 판단 로직 테스트
#   실행: npx --yes bats@1.13.0 scripts/tests
# gh · curl은 함수로 바꿔치기합니다. gh 흉내는 API처럼 status로 거른 고정 JSON에 받은 --jq 필터를
# 그대로 적용하므로 jq 필터도 함께 검사합니다(jq가 있을 때만, CI ubuntu 러너에는 기본 설치).

setup() {
  # shellcheck source=../runner-status.sh
  source "$BATS_TEST_DIRNAME/../runner-status.sh"
  TMP="$BATS_TEST_TMPDIR"
  REPO="team/repo"
  STATE_FILE="$TMP/state/state"
  NOW=1761900000  # 2025-10-31 08:40:00 UTC = 17:40 서울
  PREV_STATUS=""; PREV_SINCE=0; PREV_STUCK=0; PREV_ERR=0
  CUR_STATUS=online; BUSY=false; QUEUED=0; WAIT_MIN=0; ERROR_MSG=""
}

need_jq() { command -v jq > /dev/null || skip "jq 없음"; }

# decide를 부른 뒤 저장될 값을 다음 확인의 지난 상태로 넘김
next_check() {
  PREV_STATUS=$NEW_STATUS; PREV_SINCE=$NEW_SINCE; PREV_STUCK=$NEW_STUCK; PREV_ERR=$NEW_ERR
}

# ---------- kst · duration ----------

@test "Actions가 채우는 RUNNER_NAME · RUNNER_TOKEN과 상관없이 notelink-codex를 본다" {
  RUNNER_NAME="GitHub Actions 3" RUNNER_TOKEN=x bash -c \
    'unset CODEX_RUNNER STATUS_TOKEN; source "$1"; [ "$CODEX_RUNNER" = notelink-codex ] && [ -z "${STATUS_TOKEN:-}" ]' \
    _ "$BATS_TEST_DIRNAME/../runner-status.sh"
}

@test "kst: 서울 시간(UTC+9)으로 적는다" {
  [ "$(kst 0)" = "01/01 09:00" ]
  [ "$(kst "$NOW")" = "10/31 17:40" ]
}

@test "duration: 일 · 시간 · 분으로 나눠 적고 0인 단위는 뺀다" {
  [ "$(duration 0)" = "0분" ]
  [ "$(duration 45)" = "45분" ]
  [ "$(duration 60)" = "1시간" ]
  [ "$(duration 125)" = "2시간 5분" ]
  [ "$(duration 1440)" = "1일" ]
  [ "$(duration 3065)" = "2일 3시간 5분" ]
  [ "$(duration -5)" = "0분" ]
}

# ---------- 상태 파일 ----------

@test "load_state: 파일이 없으면 처음 상태" {
  load_state
  [ -z "$PREV_STATUS" ] && [ "$PREV_SINCE" = 0 ] && [ "$PREV_STUCK" = 0 ] && [ "$PREV_ERR" = 0 ]
}

@test "save_state · load_state: 저장한 값을 그대로 읽는다" {
  NEW_STATUS=offline; NEW_SINCE=1761890000; NEW_STUCK=1; NEW_ERR=3
  save_state
  load_state
  [ "$PREV_STATUS" = offline ] && [ "$PREV_SINCE" = 1761890000 ] && [ "$PREV_STUCK" = 1 ] && [ "$PREV_ERR" = 3 ]
}

@test "load_state: 모르는 키 · 이상한 값은 무시한다(캐시 내용을 실행하지 않음)" {
  mkdir -p "$(dirname "$STATE_FILE")"
  printf 'status=$(touch %s/pwned)\nsince=12abc\nstuck=7\nerr=-1\nevil=1\n' "$TMP" > "$STATE_FILE"
  load_state
  [ -z "$PREV_STATUS" ] && [ "$PREV_SINCE" = 0 ] && [ "$PREV_STUCK" = 0 ] && [ "$PREV_ERR" = 0 ]
  [ ! -e "$TMP/pwned" ]
  printf 'status=error\n' > "$STATE_FILE"
  load_state
  [ -z "$PREV_STATUS" ]
}

# ---------- decide: 온라인 · 오프라인 ----------

@test "decide: 처음 확인에서 온라인이면 알리지 않고, 언제부터인지는 모름(0)으로 둔다" {
  decide
  [ -z "$EVENT" ] && [ "$NEW_STATUS" = online ] && [ "$NEW_SINCE" = 0 ]
}

@test "decide: 처음 확인에서 오프라인이면 알리고 지금부터 센다" {
  CUR_STATUS=offline
  decide
  [ "$EVENT" = offline ] && [ "$NEW_SINCE" = "$NOW" ]
}

@test "decide: 온라인 → 오프라인이면 알리고 그때부터 센다" {
  PREV_STATUS=online; PREV_SINCE=100; CUR_STATUS=offline
  decide
  [ "$EVENT" = offline ] && [ "$NEW_STATUS" = offline ] && [ "$NEW_SINCE" = "$NOW" ]
}

@test "decide: 계속 오프라인이면 다시 알리지 않고 시작 시각을 유지한다" {
  PREV_STATUS=offline; PREV_SINCE=100; CUR_STATUS=offline
  decide
  [ -z "$EVENT" ] && [ "$NEW_SINCE" = 100 ]
}

@test "decide: 오프라인 → 온라인이면 복구를 알린다" {
  PREV_STATUS=offline; PREV_SINCE=100
  decide
  [ "$EVENT" = online ] && [ "$NEW_SINCE" = "$NOW" ]
}

@test "decide: 막 다시 온라인이 됐을 때는 쌓인 대기열로 '처리되지 않음'을 알리지 않는다" {
  PREV_STATUS=offline; PREV_SINCE=100; QUEUED=11; WAIT_MIN=2000
  decide
  [ "$EVENT" = online ] && [ "$NEW_STUCK" = 0 ]
}

# ---------- decide: 상태를 읽지 못함 ----------

@test "decide: 상태를 한 번 못 읽은 것은 넘기고, 연속 두 번째에 한 번만 알린다" {
  PREV_STATUS=online; PREV_SINCE=100; CUR_STATUS=error
  decide
  [ -z "$EVENT" ] && [ "$NEW_ERR" = 1 ]
  next_check; decide
  [ "$EVENT" = error ] && [ "$NEW_ERR" = 2 ]
  next_check; decide
  [ -z "$EVENT" ] && [ "$NEW_ERR" = 3 ]
  # 마지막으로 안 상태와 시각은 그대로
  [ "$NEW_STATUS" = online ] && [ "$NEW_SINCE" = 100 ]
}

@test "decide: 오프라인 중에 상태를 못 읽어도 멈춘 시각이 이어지고, 다시 온라인이면 🟢를 알린다" {
  PREV_STATUS=offline; PREV_SINCE=100; CUR_STATUS=error
  decide; next_check; decide; next_check
  [ "$PREV_STATUS" = offline ] && [ "$PREV_SINCE" = 100 ] && [ "$PREV_ERR" = 2 ]
  CUR_STATUS=offline
  decide
  [ "$EVENT" = recovered ] && [ "$NEW_SINCE" = 100 ] && [ "$NEW_ERR" = 0 ]
  next_check; CUR_STATUS=error; decide; next_check
  CUR_STATUS=online
  decide
  [ "$EVENT" = online ] && [ "$PREV_SINCE" = 100 ]
}

@test "decide: 알린 뒤 같은 상태로 다시 읽히면 ✅ 복구, 알리기 전이면 조용히 넘긴다" {
  PREV_STATUS=online; PREV_ERR=2
  decide
  [ "$EVENT" = recovered ] && [ "$NEW_ERR" = 0 ]
  PREV_ERR=1
  decide
  [ -z "$EVENT" ] && [ "$NEW_ERR" = 0 ]
}

@test "decide: 알린 뒤 다른 상태로 읽히면 그 변화를 알린다" {
  PREV_STATUS=online; PREV_ERR=5; CUR_STATUS=offline
  decide
  [ "$EVENT" = offline ]
}

@test "decide: 다시 읽히는 순간 리뷰도 막혀 있으면 🟡를 보내고, 보낸 것으로 기록한다" {
  PREV_STATUS=online; PREV_ERR=2; QUEUED=2; WAIT_MIN=45
  decide
  [ "$EVENT" = stuck ] && [ "$NEW_STUCK" = 1 ] && [ "$NEW_ERR" = 0 ]
  # 다음 확인: 같은 정체가 이어져도 ✅ · 🟡를 다시 보내지 않음
  next_check; decide
  [ -z "$EVENT" ] && [ "$NEW_STUCK" = 1 ]
}

@test "decide: 🟡를 이미 보냈으면 다시 읽힐 때 ✅만 보낸다" {
  PREV_STATUS=online; PREV_ERR=2; PREV_STUCK=1; QUEUED=2; WAIT_MIN=45
  decide
  [ "$EVENT" = recovered ] && [ "$NEW_STUCK" = 1 ]
}

@test "decide: missing(러너 없음)도 상태를 못 읽은 것으로 센다" {
  PREV_STATUS=online; PREV_ERR=1; CUR_STATUS=missing
  decide
  [ "$EVENT" = error ]
}

# ---------- decide: 리뷰가 처리되지 않음 ----------

@test "decide: 온라인 · 작업 없음 · 리뷰가 30분 넘게 대기하면 한 번만 알린다" {
  PREV_STATUS=online; PREV_SINCE=100; QUEUED=2; WAIT_MIN=45
  decide
  [ "$EVENT" = stuck ] && [ "$NEW_STUCK" = 1 ] && [ "$NEW_SINCE" = 100 ]
  next_check; decide
  [ -z "$EVENT" ] && [ "$NEW_STUCK" = 1 ]
}

@test "decide: 대기가 풀리면 '처리되지 않음' 표시를 지워 다음에 다시 알릴 수 있게 한다" {
  PREV_STATUS=online; PREV_STUCK=1; QUEUED=0
  decide
  [ -z "$EVENT" ] && [ "$NEW_STUCK" = 0 ]
}

@test "decide: 대기열을 읽지 못하면 '처리되지 않음' 표시를 그대로 둔다(같은 알림이 다시 가지 않게)" {
  PREV_STATUS=online; PREV_STUCK=1; QUEUED=""
  decide
  [ -z "$EVENT" ] && [ "$NEW_STUCK" = 1 ]
  next_check; QUEUED=2; WAIT_MIN=60
  decide
  [ -z "$EVENT" ]
}

@test "decide: 리뷰 중이거나 대기가 짧으면 알리지 않는다" {
  PREV_STATUS=online; QUEUED=3; WAIT_MIN=45; BUSY=true
  decide
  [ -z "$EVENT" ] && [ "$NEW_STUCK" = 0 ]
  BUSY=false; WAIT_MIN=29
  decide
  [ -z "$EVENT" ]
}

# ---------- 메시지 ----------

@test "compose online: 멈춰 있던 시간과 구간을 서울 시간으로 적는다" {
  PREV_STATUS=offline; PREV_SINCE=$(( NOW - 1500 * 60 )); QUEUED=3; WAIT_MIN=1490
  compose online
  [[ "$TITLE" == "🟢"* ]]
  [[ "$TEXT" == *"멈춰 있던 시간: 약 1일 1시간 (10/30 16:40 ~ 10/31 17:40)"* ]]
  [[ "$TEXT" == *"대기 중인 Codex 리뷰: 3건 (가장 오래 기다린 것 1일 50분)"* ]]
}

@test "compose offline: 러너 목록 · 실행 목록 링크를 붙인다" {
  CUR_STATUS=offline; QUEUED=0
  compose offline
  [ "$COLOR" = "$COLOR_RED" ]
  [[ "$TEXT" == *"10/31 17:40 확인"* ]]
  [[ "$TEXT" == *"대기 중인 Codex 리뷰: 없음"* ]]
  [[ "$TEXT" == *"https://github.com/team/repo/settings/actions/runners"* ]]
  [[ "$TEXT" == *"https://github.com/team/repo/actions/workflows/codex-review.yml"* ]]
}

@test "compose error: 원인과 토큰 확인 안내를 적는다" {
  ERROR_MSG="HTTP 401: Bad credentials"
  compose error
  [[ "$TEXT" == "HTTP 401: Bad credentials"* ]]
  [[ "$TEXT" == *"RUNNER_STATUS_TOKEN"* ]]
}

@test "compose summary: 언제부터인지 알 때만 적고, 집계를 못 읽으면 그렇다고 적는다" {
  PREV_STATUS=online; PREV_SINCE=$(( NOW - 3600 )); BUSY=true; QUEUED=1; WAIT_MIN=3
  DONE_OK=5; DONE_FAIL=1; DONE_CANCEL=2
  compose summary
  [[ "$TITLE" == *"(10/31)" ]]
  [[ "$TEXT" == *"🟢 온라인 (리뷰 중) — 10/31 16:40부터"* ]]
  [[ "$TEXT" == *"성공 5 · 실패 1 · 취소 2"* ]]
  PREV_SINCE=0  # 처음 확인에서 온라인이었음(언제부터인지 모름)
  compose summary
  [[ "$TEXT" != *"부터"* ]]
  DONE_OK=""; PREV_STATUS=offline; PREV_SINCE=100
  compose summary
  [[ "$TEXT" != *"부터"* ]]
  [[ "$TEXT" == *"지난 24시간에 끝난 Codex 리뷰: 확인하지 못함"* ]]
}

@test "queue_line: 대기 수를 모르면 그렇다고 적는다" {
  QUEUED=""
  [ "$(queue_line)" = "대기 중인 Codex 리뷰: 확인하지 못함" ]
}

@test "payload: 디스코드 embed 형식이고 멘션을 막는다" {
  need_jq
  TITLE="제목"; TEXT=$'줄1\n"따옴표" @everyone'; COLOR=$COLOR_BLUE
  run payload
  [ "$status" -eq 0 ]
  [ "$(jq -r '.embeds[0].description' <<< "$output")" = "$TEXT" ]
  [ "$(jq -r '.embeds[0].color' <<< "$output")" = "$COLOR_BLUE" ]
  [ "$(jq -c '.allowed_mentions' <<< "$output")" = '{"parse":[]}' ]
}

# ---------- GitHub 조회 (gh 흉내 + jq 필터) ----------

# 러너 목록 · 집계(created=)는 고정 JSON에, 대기열은 API처럼 ?status=로 거른 뒤 --jq 필터를 적용
gh() {
  echo "$*" >> "$TMP/gh.calls"
  [ -n "${GH_FAIL:-}" ] && { echo "gh: Bad credentials (HTTP 401)" >&2; return 1; }
  [ -n "${GH_WARN:-}" ] && echo "A new release of gh is available" >&2
  local path=$2 filter=$4 st
  st=$(sed -n 's/.*[?&]status=\([a-z_]*\).*/\1/p' <<< "$path")
  case "$path" in
    *actions/runners*) jq -r "$filter" "$TMP/runners.json" ;;
    *created=*) jq -r "$filter" "$TMP/counts.json" ;;
    *) # --paginate: GH_PAGES쪽이면 쪽마다 필터 결과가 한 줄씩 나옴(같은 내용을 여러 쪽으로 흉내)
      local i
      for (( i = 0; i < ${GH_PAGES:-1}; i++ )); do
        jq --arg s "$st" '.workflow_runs |= map(select(.status == $s))' "$TMP/runs.json" | jq -r "$filter"
      done ;;
  esac
}

fixtures() {
  cat > "$TMP/runners.json" <<'EOF'
{"runners":[{"name":"other","status":"offline","busy":false},{"name":"notelink-codex","status":"online","busy":true}]}
EOF
  # queued는 사흘 전 실행을 07:40:30에 재실행한 것(created_at은 처음 그대로)
  cat > "$TMP/runs.json" <<'EOF'
{"workflow_runs":[
 {"status":"in_progress","created_at":"2025-10-31T08:39:00Z","run_started_at":"2025-10-31T08:39:00Z"},
 {"status":"pending","created_at":"2025-10-31T08:10:00Z","run_started_at":"2025-10-31T08:10:00Z"},
 {"status":"queued","created_at":"2025-10-28T01:00:00Z","run_started_at":"2025-10-31T07:40:30Z"},
 {"status":"completed","conclusion":"success","created_at":"2025-10-31T06:00:00Z"}]}
EOF
  # 지난 24시간은 10/30 08:40:00Z부터. 첫 success는 이틀 전에 만들어져 오래 기다리다 오늘 끝난 것,
  # 마지막 success는 24시간 전에 끝난 것
  cat > "$TMP/counts.json" <<'EOF'
{"workflow_runs":[
 {"status":"completed","conclusion":"success","created_at":"2025-10-29T09:00:00Z","updated_at":"2025-10-31T02:00:00Z"},
 {"status":"completed","conclusion":"success","updated_at":"2025-10-31T03:00:00Z"},
 {"status":"completed","conclusion":"failure","updated_at":"2025-10-31T04:00:00Z"},
 {"status":"completed","conclusion":"timed_out","updated_at":"2025-10-31T05:00:00Z"},
 {"status":"completed","conclusion":"cancelled","updated_at":"2025-10-30T08:40:00Z"},
 {"status":"completed","conclusion":"skipped","updated_at":"2025-10-31T06:00:00Z"},
 {"status":"completed","conclusion":"success","updated_at":"2025-10-30T08:39:59Z"},
 {"status":"queued","conclusion":null,"updated_at":"2025-10-31T07:00:00Z"}]}
EOF
}

@test "read_runner: 이름이 같은 러너의 상태 · 작업 중 여부를 읽는다" {
  need_jq; fixtures; STATUS_TOKEN=t
  read_runner
  [ "$CUR_STATUS" = online ] && [ "$BUSY" = true ] && [ -z "$ERROR_MSG" ]
}

@test "read_runner: 성공했을 때 gh가 stderr에 남긴 안내는 결과에 섞이지 않는다" {
  need_jq; fixtures; STATUS_TOKEN=t; GH_WARN=1
  read_runner
  [ "$CUR_STATUS" = online ] && [ -z "$ERROR_MSG" ]
}

@test "read_runner: 러너가 없으면 missing" {
  need_jq; fixtures; STATUS_TOKEN=t; CODEX_RUNNER=nope
  read_runner
  [ "$CUR_STATUS" = missing ] && [[ "$ERROR_MSG" == *"nope"* ]]
}

@test "read_runner: 조회에 실패하면 error와 gh 오류 첫 줄" {
  fixtures; STATUS_TOKEN=t; GH_FAIL=1
  read_runner
  [ "$CUR_STATUS" = error ] && [ "$ERROR_MSG" = "gh: Bad credentials (HTTP 401)" ]
}

@test "read_runner: 토큰이 없으면 gh를 부르지 않고 error" {
  STATUS_TOKEN=""
  read_runner
  [ "$CUR_STATUS" = error ] && [[ "$ERROR_MSG" == *"RUNNER_STATUS_TOKEN"* ]]
  [ ! -e "$TMP/gh.calls" ]
}

@test "read_queue: 대기 · 동시 실행 대기만 세고, 재실행은 다시 시작한 시각부터 잰다" {
  need_jq; fixtures
  read_queue
  [ "$QUEUED" = 2 ] && [ "$WAIT_MIN" = 59 ]
  grep -q 'runs?status=queued&per_page=100 --jq .* --paginate' "$TMP/gh.calls"
  grep -q 'runs?status=pending&per_page=100 --jq .* --paginate' "$TMP/gh.calls"
}

@test "read_queue: 대기가 여러 쪽(100건 넘게)이면 쪽마다 더하고 가장 오래된 것을 고른다" {
  need_jq; fixtures; GH_PAGES=3
  read_queue
  [ "$QUEUED" = 6 ] && [ "$WAIT_MIN" = 59 ]
}

@test "read_queue: 조회에 실패하면 대기 수를 모름(빈 값)" {
  fixtures; GH_FAIL=1
  read_queue
  [ -z "$QUEUED" ] && [ "$WAIT_MIN" = 0 ]
}

@test "read_counts: 지난 24시간에 끝난 결과를 성공 · 실패(시간 초과 포함) · 취소로 센다(건너뜀 제외)" {
  need_jq; fixtures
  read_counts
  [ "$DONE_OK" = 2 ] && [ "$DONE_FAIL" = 2 ] && [ "$DONE_CANCEL" = 1 ]
  # 만든 시각은 7일 전까지 넓혀 받고(재실행은 만든 시각이 그대로), 쪽을 넘겨 모두 받음
  grep -q 'runs?per_page=100&created=%3E%3D2025-10-24T08:40:00Z --jq .* --paginate' "$TMP/gh.calls"
}

@test "read_counts: 끝난 리뷰가 없으면 모두 0" {
  need_jq; fixtures
  echo '{"workflow_runs":[]}' > "$TMP/counts.json"
  read_counts
  [ "$DONE_OK" = 0 ] && [ "$DONE_FAIL" = 0 ] && [ "$DONE_CANCEL" = 0 ]
}

@test "read_counts: 못 읽으면 모두 빈 값" {
  fixtures; GH_FAIL=1
  read_counts
  [ -z "$DONE_OK" ] && [ -z "$DONE_FAIL" ] && [ -z "$DONE_CANCEL" ]
}

# ---------- main ----------

curl() {
  local a
  while [ $# -gt 0 ]; do
    a=$1; shift
    [ "$a" = "-d" ] && { printf '%s' "$1" > "$TMP/posted.json"; shift; }
  done
  return "${CURL_RC:-0}"
}

write_state() {  # $1 = 상태 파일 내용
  mkdir -p "$(dirname "$STATE_FILE")"; printf '%b' "$1" > "$STATE_FILE"
}

@test "main check: 처음 확인(온라인)은 알리지 않고 상태만 저장한다" {
  need_jq; fixtures; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  GITHUB_OUTPUT="$TMP/out"
  run main check
  [ "$status" -eq 0 ]
  [ ! -e "$TMP/posted.json" ]
  grep -qx 'status=online' "$STATE_FILE"
  grep -qx 'since=0' "$STATE_FILE"
  grep -qx 'changed=true' "$TMP/out"
}

@test "main check: 상태가 그대로면 저장하지 않는다(캐시를 새로 만들지 않음)" {
  need_jq; fixtures; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  write_state 'status=online\nsince=5\nstuck=0\nerr=0\n'
  GITHUB_OUTPUT="$TMP/out"
  run main check
  [ "$status" -eq 0 ]
  [ ! -e "$TMP/out" ]
  grep -qx 'since=5' "$STATE_FILE"
}

@test "main check: 오프라인을 알리고 저장한다" {
  need_jq; fixtures; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  sed -i 's/"status":"online","busy":true/"status":"offline","busy":false/' "$TMP/runners.json"
  write_state 'status=online\nsince=5\nstuck=0\nerr=0\n'
  run main check
  [ "$status" -eq 0 ]
  [[ "$(jq -r '.embeds[0].title' "$TMP/posted.json")" == "🔴"* ]]
  grep -qx 'status=offline' "$STATE_FILE"
  grep -qx "since=$NOW" "$STATE_FILE"
}

@test "main check: 상태를 한 번 못 읽으면 알리지 않고 횟수만 저장한다" {
  need_jq; fixtures; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook; GH_FAIL=1
  write_state 'status=offline\nsince=5\nstuck=0\nerr=0\n'
  run main check
  [ "$status" -eq 0 ]
  [ ! -e "$TMP/posted.json" ]
  grep -qx 'status=offline' "$STATE_FILE"
  grep -qx 'since=5' "$STATE_FILE"
  grep -qx 'err=1' "$STATE_FILE"
}

@test "main check: 디스코드로 못 보내면 실패하고 상태를 저장하지 않는다(다음에 다시 보냄)" {
  need_jq; fixtures; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook; CURL_RC=22
  sed -i 's/"status":"online","busy":true/"status":"offline","busy":false/' "$TMP/runners.json"
  write_state 'status=online\nsince=5\nstuck=0\nerr=0\n'
  run main check
  [ "$status" -eq 1 ]
  grep -qx 'status=online' "$STATE_FILE"
}

@test "main summary: 요약을 보내고 상태는 건드리지 않는다" {
  need_jq; fixtures; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  run main summary
  [ "$status" -eq 0 ]
  [[ "$(jq -r '.embeds[0].title' "$TMP/posted.json")" == "📋"* ]]
  [[ "$(jq -r '.embeds[0].description' "$TMP/posted.json")" == *"성공 2 · 실패 2 · 취소 1"* ]]
  [ ! -e "$STATE_FILE" ]
}

@test "main: 웹후크 비밀값이 없으면 실패한다" {
  DISCORD_WEBHOOK=""
  run main check
  [ "$status" -eq 1 ]
  [[ "$output" == *"DISCORD_RUNNER_WEBHOOK"* ]]
}

@test "main: 모르는 모드는 사용법을 보여 준다" {
  run main nope
  [ "$status" -eq 2 ]
  [[ "$output" == *"사용법"* ]]
}

# ---------- 워크플로 ----------

WF="$BATS_TEST_DIRNAME/../../.github/workflows/runner-status.yml"

@test "워크플로: summary 예약 cron과 MODE · concurrency 식의 cron이 같다" {
  # GitHub 식은 여기서 실행할 수 없으므로, 세 곳의 '0 0 * * *'가 어긋나지 않았는지만 봄
  cron=$(sed -n "s/^ *- cron: '\(0 0 [^']*\)'.*/\1/p" "$WF")
  [ -n "$cron" ]
  [ "$(grep -cF "github.event.schedule == '$cron' && 'summary' || inputs.mode || 'check'" "$WF")" -eq 2 ]
}

@test "워크플로: 상태가 바뀐 check에서만 캐시를 저장한다" {
  grep -qF "if: steps.check.outputs.changed == 'true'" "$WF"
  grep -qF 'echo "changed=true" >> "$GITHUB_OUTPUT"' "$BATS_TEST_DIRNAME/../runner-status.sh"
}
