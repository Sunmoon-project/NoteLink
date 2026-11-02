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
  PREV_USAGE=""; USAGE_ERR=0; no_usage  # no_usage는 scripts/codex-usage-lib.sh
}

need_jq() { command -v jq > /dev/null || skip "jq 없음"; }

# decide를 부른 뒤 저장될 값을 다음 확인의 지난 상태로 넘김
next_check() {
  PREV_STATUS=$NEW_STATUS; PREV_SINCE=$NEW_SINCE; PREV_STUCK=$NEW_STUCK; PREV_ERR=$NEW_ERR
  PREV_USAGE=${NEW_USAGE:-$PREV_USAGE}
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
    *"actions/artifacts?name="*)  # 결과 파일 목록: codex-paused는 paused.json, 그 밖은 artifacts.json (없으면 빈 목록)
      local list="$TMP/artifacts.json"
      [[ "$path" == *"name=codex-paused&"* ]] && list="$TMP/paused.json"
      if [ -f "$list" ]; then jq -r "$filter" "$list"
      else jq -r "$filter" <<< '{"artifacts":[]}'; fi ;;
    *actions/artifacts/*/zip)  # 결과 파일 내려받기: id마다 $TMP/artifact-<id>.zip
      local id=${path#*artifacts/}; id=${id%/zip}
      [ -f "$TMP/artifact-$id.zip" ] || { echo "gh: Not Found (HTTP 404)" >&2; return 1; }
      cat "$TMP/artifact-$id.zip" ;;
    */actions/artifacts/[0-9]*) return "${DELETE_RC:-0}" ;;  # 결과 파일 지우기(-X DELETE)
    */actions/runs/*/rerun) return "${RERUN_RC:-0}" ;;
    */actions/runs/*)  # 실행 정보: $TMP/run-<id>.json
      local run=${path##*/}
      [ -f "$TMP/run-$run.json" ] || { echo "gh: Not Found (HTTP 404)" >&2; return 1; }
      jq -r "$filter" "$TMP/run-$run.json" ;;
    */pulls/[0-9]*)  # PR 정보: $TMP/pull-<번호>.json
      local n=${path##*/}
      [ -f "$TMP/pull-$n.json" ] || { echo "gh: Not Found (HTTP 404)" >&2; return 1; }
      jq -r "$filter" "$TMP/pull-$n.json" ;;
    *created=*) # API처럼 만든 시각(created_at)이 조건보다 이른 실행은 빼고 돌려줌(created_at이 없으면 범위 안)
      local c
      c=$(sed -n 's/.*created=%3E%3D\([^&]*\).*/\1/p' <<< "$path")
      for f in $(pages counts); do
        jq --arg c "$c" '.workflow_runs |= map(select((.created_at // "9999") >= $c))' "$f" | jq -r "$filter"
      done ;;
    *) for f in $(pages runs); do
         jq --arg s "$st" '.workflow_runs |= map(select(.status == $s))' "$f" | jq -r "$filter"
       done ;;
  esac
}

# --paginate 흉내: 첫 쪽은 $1.json, 둘째 쪽부터는 $1.p2.json · $1.p3.json … (있는 것만, 쪽마다 필터 결과가 따로 나옴)
pages() {
  local k
  echo "$TMP/$1.json"
  for (( k = 2; ; k++ )); do
    [ -f "$TMP/$1.p$k.json" ] || break
    echo "$TMP/$1.p$k.json"
  done
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

@test "read_queue: 대기가 101건(100건 + 1건, 두 쪽)이면 모두 세고, 둘째 쪽의 가장 오래된 것을 고른다" {
  need_jq; fixtures
  jq -n '{workflow_runs: [range(100) | {status: "queued", created_at: "2025-10-31T08:00:00Z", run_started_at: "2025-10-31T08:00:00Z"}]}' \
    > "$TMP/runs.json"
  echo '{"workflow_runs":[{"status":"queued","created_at":"2025-10-31T07:10:00Z","run_started_at":"2025-10-31T07:10:00Z"}]}' \
    > "$TMP/runs.p2.json"
  read_queue
  [ "$QUEUED" = 101 ] && [ "$WAIT_MIN" = 90 ]
}

@test "read_queue: 쪽마다 더하고, 둘째 쪽 이후의 가장 오래된 것도 고른다(queued · pending 따로)" {
  need_jq; fixtures
  cat > "$TMP/runs.p2.json" <<'EOF'
{"workflow_runs":[{"status":"queued","created_at":"2025-10-31T06:40:30Z","run_started_at":"2025-10-31T06:40:30Z"},
 {"status":"queued","created_at":"2025-10-31T08:00:00Z","run_started_at":"2025-10-31T08:00:00Z"}]}
EOF
  cat > "$TMP/runs.p3.json" <<'EOF'
{"workflow_runs":[{"status":"pending","created_at":"2025-10-31T08:30:00Z","run_started_at":"2025-10-31T08:30:00Z"}]}
EOF
  read_queue
  # queued: 1(첫 쪽) + 2(둘째 쪽), pending: 1(첫 쪽) + 1(셋째 쪽). 가장 오래된 것은 둘째 쪽의 06:40:30
  [ "$QUEUED" = 5 ] && [ "$WAIT_MIN" = 119 ]
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
  # 만든 시각은 35일 전까지 넓혀 받고(재실행은 만든 시각이 그대로), 쪽을 넘겨 모두 받음
  grep -q 'runs?per_page=100&created=%3E%3D2025-09-26T08:40:00Z --jq .* --paginate' "$TMP/gh.calls"
}

@test "read_counts: 가장 늦은 경우(기한 끝 재실행 · 대기 · 처리 · 다음 날 요약)도 센다" {
  need_jq; fixtures
  # 9/29 08:20 생성 → 29일 23시간 50분째(10/29 08:10) 재실행 → 23시간 50분 대기 → 50분 처리 → 10/30 08:50 완료,
  # 다음 날 10/31 08:40 요약(지난 24시간 = 10/30 08:40부터).
  # 만든 지 32일 20분이라 범위가 32일이면 빠짐
  echo '{"workflow_runs":[{"status":"completed","conclusion":"success","created_at":"2025-09-29T08:20:00Z","updated_at":"2025-10-30T08:50:00Z"}]}' \
    > "$TMP/counts.p2.json"
  read_counts
  [ "$DONE_OK" = 3 ]
}

@test "read_counts: 30일 하고 조금 전에 만들어, 기한 안에 재실행해 오늘 끝낸 것도 센다" {
  need_jq; fixtures
  # 10/01 08:00에 만들고(30일 40분 전) 10/31 07:30에 재실행, 08:00에 끝남. 범위가 30일이면 빠짐
  echo '{"workflow_runs":[{"status":"completed","conclusion":"success","created_at":"2025-10-01T08:00:00Z","updated_at":"2025-10-31T08:00:00Z"}]}' \
    > "$TMP/counts.p2.json"
  read_counts
  [ "$DONE_OK" = 3 ]
}

@test "read_counts: 둘째 쪽 이후의 결과도 센다(20일 전에 만들어 오늘 재실행해 끝낸 것 포함)" {
  need_jq; fixtures
  cat > "$TMP/counts.p2.json" <<'EOF'
{"workflow_runs":[
 {"status":"completed","conclusion":"success","created_at":"2025-10-11T09:00:00Z","updated_at":"2025-10-31T07:00:00Z"},
 {"status":"completed","conclusion":"failure","created_at":"2025-10-11T08:00:00Z","updated_at":"2025-10-11T08:30:00Z"}]}
EOF
  read_counts
  [ "$DONE_OK" = 3 ] && [ "$DONE_FAIL" = 2 ] && [ "$DONE_CANCEL" = 1 ]
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

# ---------- Codex 사용량 ----------
# NOW = 10/31 17:40 서울. 아래 기록은 10/31 17:00(서울) 리뷰에서 뽑은 것
U_AT_FIX=1761897600
H5_RESET=1761904800    # 10/31 19:00 서울 (5시간 창)
WEEK_RESET=1762261200  # 11/04 22:00 서울 (주간 창)

weekly() {  # $1 = 주간 사용률
  no_usage
  U_AT=$U_AT_FIX; U_PLAN=plus; U_P_USED=$1; U_P_WINDOW=10080; U_P_RESET=$WEEK_RESET
}

two_windows() {  # $1 = 5시간 사용률, $2 = 주간 사용률
  weekly "$2"
  U_S_USED=$U_P_USED; U_S_WINDOW=$U_P_WINDOW; U_S_RESET=$U_P_RESET
  U_P_USED=$1; U_P_WINDOW=300; U_P_RESET=$H5_RESET
}

@test "save_state · load_state: Codex 사용량 단계를 저장하고, 이상한 값은 무시한다" {
  NEW_STATUS=online; NEW_SINCE=0; NEW_STUCK=0; NEW_ERR=0; NEW_USAGE=stop
  save_state
  load_state
  [ "$PREV_USAGE" = stop ]
  write_state 'status=online\nusage=$(touch pwned)\n'
  load_state
  [ -z "$PREV_USAGE" ] && [ "$PREV_STATUS" = online ]
}

@test "window_name: 5시간 · 주간 · 일 · 시간 · 분" {
  [ "$(window_name 300)" = "5시간" ]
  [ "$(window_name 10080)" = "주간" ]
  [ "$(window_name 1440)" = "1일" ]
  [ "$(window_name 90)" = "90분" ]
}

@test "usage_level: 기록이 없으면 판단하지 않는다" {
  usage_level
  [ -z "$CUR_USAGE" ]
}

@test "usage_level: 남은 양 20% 이상은 ok, 20% 미만은 warn, 10% 이하는 stop" {
  weekly 34; usage_level; [ "$CUR_USAGE" = ok ] && [ "$USAGE_LEFT" = 66 ]
  weekly 80; usage_level; [ "$CUR_USAGE" = ok ]      # 20% 남음
  weekly 81; usage_level; [ "$CUR_USAGE" = warn ]    # 19% 남음
  weekly 89; usage_level; [ "$CUR_USAGE" = warn ]    # 11% 남음
  weekly 90; usage_level; [ "$CUR_USAGE" = stop ] && [ "$USAGE_REASON" = low ] && [ "$USAGE_LEFT" = 10 ]
  [ "$USAGE_RETRY" = "$WEEK_RESET" ]
  two_windows 12 85; usage_level; [ "$CUR_USAGE" = warn ] && [ "$USAGE_LEFT" = 15 ]
}

@test "usage_level: 두 창이 모두 10% 이하면 늦게 초기화되는 쪽까지 멈춘다" {
  two_windows 95 100; usage_level
  [ "$CUR_USAGE" = stop ] && [ "$USAGE_RETRY" = "$WEEK_RESET" ] && [ "$USAGE_LEFT" = 0 ]
  # 한 창만 10% 이하 · 다른 창은 경고 수준이어도 stop
  two_windows 95 85; usage_level
  [ "$CUR_USAGE" = stop ] && [ "$USAGE_RETRY" = "$H5_RESET" ]
}

@test "usage_level: 초기화 시각이 지난 창은 다 남은 것으로 본다" {
  two_windows 100 40; NOW=$(( H5_RESET + 60 )); usage_level
  [ "$CUR_USAGE" = ok ] && [ "$USAGE_LEFT" = 60 ]
  two_windows 100 85; NOW=$(( H5_RESET + 60 )); usage_level
  [ "$CUR_USAGE" = warn ]
}

@test "usage_level: 한도 문구가 있으면 다시 가능한 시각까지 stop, 지나면 창 사용률로 판단" {
  no_usage; U_AT=$U_AT_FIX; U_LIMIT=1; U_RETRY=$H5_RESET
  usage_level
  [ "$CUR_USAGE" = stop ] && [ "$USAGE_REASON" = limit ] && [ "$USAGE_RETRY" = "$H5_RESET" ]
  NOW=$(( H5_RESET + 1 )); usage_level
  [ "$CUR_USAGE" = ok ]
}

@test "usage_level: 다시 가능한 시각을 모르면 기록 1시간 뒤에 다시 시도한다(영영 멈추지 않음)" {
  no_usage; U_AT=$U_AT_FIX; U_LIMIT=1
  NOW=$(( U_AT_FIX + 3599 )); usage_level
  [ "$CUR_USAGE" = stop ] && [ "$USAGE_RETRY" = $(( U_AT_FIX + 3600 )) ]
  NOW=$(( U_AT_FIX + 3601 )); usage_level
  [ "$CUR_USAGE" = ok ]
  # 초기화 시각을 모르는 창을 다 쓴 경우도 같음
  no_usage; U_AT=$U_AT_FIX; U_P_USED=100; U_P_WINDOW=300
  NOW=$(( U_AT_FIX + 60 )); usage_level
  [ "$CUR_USAGE" = stop ] && [ "$USAGE_RETRY" = $(( U_AT_FIX + 3600 )) ]
  NOW=$(( U_AT_FIX + 3601 )); usage_level
  [ "$CUR_USAGE" = ok ]
}

@test "decide_usage: 처음 확인은 ok면 조용히, warn · stop이면 알린다" {
  CUR_USAGE=ok; decide_usage; [ -z "$USAGE_EVENT" ] && [ "$NEW_USAGE" = ok ]
  CUR_USAGE=warn; decide_usage; [ "$USAGE_EVENT" = usage_warn ]
  CUR_USAGE=stop; decide_usage; [ "$USAGE_EVENT" = usage_stop ]
}

@test "decide_usage: ok → warn → stop → (초기화) ok 마다 한 번씩만 알린다" {
  PREV_USAGE=ok
  CUR_USAGE=warn; decide_usage; [ "$USAGE_EVENT" = usage_warn ]
  next_check; decide_usage; [ -z "$USAGE_EVENT" ]
  CUR_USAGE=stop; next_check; decide_usage; [ "$USAGE_EVENT" = usage_stop ]
  next_check; decide_usage; [ -z "$USAGE_EVENT" ]
  CUR_USAGE=ok; next_check; decide_usage; [ "$USAGE_EVENT" = usage_resume ] && [ "$NEW_USAGE" = ok ]
}

@test "decide_usage: stop에서 다른 창이 경고 수준인 채 풀려도 다시 시작을 알리고, warn → ok는 조용히" {
  PREV_USAGE=stop; CUR_USAGE=warn; decide_usage
  [ "$USAGE_EVENT" = usage_resume ] && [ "$NEW_USAGE" = warn ]
  PREV_USAGE=warn; CUR_USAGE=ok; decide_usage
  [ -z "$USAGE_EVENT" ] && [ "$NEW_USAGE" = ok ]
}

@test "decide_usage: 기록을 읽지 못하면 지난 단계를 그대로 둔다" {
  PREV_USAGE=stop; CUR_USAGE=""; decide_usage
  [ -z "$USAGE_EVENT" ] && [ "$NEW_USAGE" = stop ]
}

@test "usage_line: 창별 남은 양 · 초기화 시각 · 몇 시 리뷰 기준인지 적는다" {
  weekly 34; usage_level
  [ "$(usage_line)" = "Codex 사용량: 주간 66% 남음 (11/04 22:00 초기화) — 10/31 17:00 리뷰 기준 · 플랜 plus" ]
  two_windows 85 40; usage_level
  [ "$(usage_line)" = "Codex 사용량: 🟡 5시간 15% 남음 (10/31 19:00 초기화) · 주간 60% 남음 (11/04 22:00 초기화) — 10/31 17:00 리뷰 기준 · 플랜 plus" ]
}

@test "usage_line: 멈춤은 이유와 다시 시작할 시각을, 지난 창은 초기화됨을 적는다" {
  two_windows 92 40; usage_level
  [ "$(usage_line)" = "Codex 사용량: ⏸️ 리뷰 멈춤(남은 양 10% 이하), 10/31 19:00에 다시 시작 · 5시간 8% 남음 (10/31 19:00 초기화) · 주간 60% 남음 (11/04 22:00 초기화) — 10/31 17:00 리뷰 기준 · 플랜 plus" ]
  NOW=$(( H5_RESET + 60 )); usage_level
  [ "$(usage_line)" = "Codex 사용량: 5시간 초기화됨 (10/31 19:00) · 주간 60% 남음 (11/04 22:00 초기화) — 10/31 17:00 리뷰 기준 · 플랜 plus" ]
}

@test "usage_line: 로그의 한도 문구만 있을 때 · 기록이 없을 때 · 못 읽었을 때" {
  no_usage; U_AT=$U_AT_FIX; U_LIMIT=1; U_RETRY=$H5_RESET; usage_level
  [ "$(usage_line)" = "Codex 사용량: ⏸️ 리뷰 멈춤(한도 도달), 10/31 19:00에 다시 시작 — 10/31 17:00 리뷰 기준" ]
  NOW=$(( H5_RESET + 60 )); usage_level
  [ "$(usage_line)" = "Codex 사용량: 한도가 풀림 — 10/31 17:00 리뷰 기준" ]
  no_usage; usage_level
  [ "$(usage_line)" = "Codex 사용량: 기록 없음 (최근에 Codex를 돌린 리뷰가 없음)" ]
  USAGE_ERR=1
  [ "$(usage_line)" = "Codex 사용량: 확인하지 못함" ]
}

@test "compose usage_warn · usage_stop: 제목 · 다시 시작 시각 · 안내" {
  two_windows 85 40; usage_level
  compose usage_warn
  [ "$TITLE" = "🟡 Codex 남은 사용량 20% 미만" ] && [ "$COLOR" = "$COLOR_YELLOW" ]
  [[ "$TEXT" == *"10% 이하가 되면 리뷰를 멈추고"* ]]
  two_windows 92 40; usage_level
  compose usage_stop
  [ "$TITLE" = "⏸️ Codex 리뷰 멈춤 — 남은 사용량 10% 이하" ] && [ "$COLOR" = "$COLOR_ORANGE" ]
  [[ "$TEXT" == "10/31 19:00에 사용량이 초기화될 때까지"* ]]
  no_usage; U_AT=$U_AT_FIX; U_LIMIT=1; U_RETRY=$H5_RESET; usage_level
  compose usage_stop
  [ "$TITLE" = "⏸️ Codex 리뷰 멈춤 — 사용량 한도 도달" ]
}

@test "compose usage_resume: 다시 돌린 PR과 돌리지 못한 PR을 적는다" {
  weekly 0; usage_level
  RESUMED="#12 #34"; RESUME_FAILED=""
  compose usage_resume
  [ "$TITLE" = "▶️ Codex 리뷰 다시 시작" ] && [ "$COLOR" = "$COLOR_GREEN" ]
  [[ "$TEXT" == *"멈췄던 리뷰를 다시 돌립니다: #12 #34"* ]] && [[ "$TEXT" != *"다시 돌리지 못함"* ]]
  RESUMED=""; RESUME_FAILED="#56"
  compose usage_resume
  [[ "$TEXT" == *"멈춘 리뷰는 없습니다."* ]]
  [[ "$TEXT" == *"다시 돌리지 못함: #56"*"(https://github.com/team/repo/actions/workflows/codex-review.yml?query=is%3Afailure)"* ]]
}

# 결과 파일 zip을 만듦: $1 = id, $2 = 안의 파일 내용(printf %b), $3 = 안의 파일 이름(기본 codex-usage.txt)
artifact_zip() {
  command -v zip > /dev/null && command -v unzip > /dev/null || skip "zip · unzip 없음"
  local name=${3:-codex-usage.txt}
  mkdir -p "$TMP/z$1"
  printf '%b' "$2" > "$TMP/z$1/$name"
  (cd "$TMP/z$1" && zip -q "$TMP/artifact-$1.zip" "$name") || skip "zip 실패"
}

# 실행 정보: $1 = 실행 id, $2 = 워크플로 파일, $3 = 이벤트, $4 = 상태
run_info() {
  printf '{"path":"%s","event":"%s","status":"%s"}\n' "$2" "$3" "${4:-completed}" > "$TMP/run-$1.json"
}

USAGE_TXT='at=1761897600\nplan=plus\nlimit=0\nretry=\np_used=34\np_window=10080\np_reset=1762261200\ns_used=\ns_window=\ns_reset=\n'
REVIEW_WF=".github/workflows/codex-review.yml"

artifacts_fixture() {
  # 30: 만료됨 · 25: 다른 워크플로가 같은 이름으로 올림 · 20: 리뷰 워크플로(이것을 씀) · 10: 더 오래됨
  printf '%s\n' '{"artifacts":[' \
    ' {"id":10,"expired":false,"created_at":"2025-10-30T08:00:00Z","workflow_run":{"id":110}},' \
    ' {"id":30,"expired":true,"created_at":"2025-10-31T08:30:00Z","workflow_run":{"id":130}},' \
    ' {"id":25,"expired":false,"created_at":"2025-10-31T08:10:00Z","workflow_run":{"id":125}},' \
    ' {"id":20,"expired":false,"created_at":"2025-10-31T08:00:00Z","workflow_run":{"id":120}}]}' > "$TMP/artifacts.json"
  run_info 110 "$REVIEW_WF" pull_request_target
  run_info 125 ".github/workflows/ci.yml" pull_request
  run_info 120 "$REVIEW_WF" pull_request_target
}

@test "read_usage: 리뷰 워크플로가 올린 만료되지 않은 가장 최근 결과 파일을 읽는다(다른 워크플로가 올린 것은 건너뜀)" {
  need_jq; artifacts_fixture
  artifact_zip 25 'at=1761897600\nlimit=1\nretry=1761904800\n'
  artifact_zip 20 "$USAGE_TXT"
  artifact_zip 10 'at=1\np_used=99\n'
  read_usage
  [ "$USAGE_ERR" = 0 ] && [ "$U_AT" = 1761897600 ] && [ "$U_PLAN" = plus ] && [ "$U_LIMIT" = 0 ]
  [ "$U_P_USED" = 34 ] && [ "$U_P_WINDOW" = 10080 ] && [ "$U_P_RESET" = 1762261200 ] && [ -z "$U_S_USED" ]
  grep -q 'actions/artifacts?name=codex-usage' "$TMP/gh.calls"
  not grep -q 'artifacts/25/zip' "$TMP/gh.calls"
}

@test "read_usage: 같은 이름의 이벤트가 pull_request면(PR 브랜치의 워크플로) 믿지 않는다" {
  need_jq; artifacts_fixture
  run_info 120 "$REVIEW_WF" pull_request
  run_info 110 "$REVIEW_WF" pull_request
  artifact_zip 20 "$USAGE_TXT"
  read_usage
  [ -z "$U_AT" ] && [ "$USAGE_ERR" = 0 ]
}

@test "read_usage: 결과 파일 안의 이상한 값은 무시한다" {
  need_jq; artifacts_fixture
  artifact_zip 20 'at=1761897600\nplan=$(touch pwned)\np_used=1000\np_window=0\nlimit=yes\nevil=1\n'
  read_usage
  [ "$U_AT" = 1761897600 ] && [ -z "$U_PLAN" ] && [ -z "$U_P_USED" ] && [ -z "$U_P_WINDOW" ] && [ "$U_LIMIT" = 0 ]
  [ ! -e pwned ]
}

@test "read_usage: 결과 파일이 없으면 기록 없음, 목록 · 내려받기에 실패하면 확인 실패" {
  need_jq
  read_usage
  [ -z "$U_AT" ] && [ "$USAGE_ERR" = 0 ]
  artifacts_fixture  # zip이 없어 내려받기 실패
  read_usage
  [ -z "$U_AT" ] && [ "$USAGE_ERR" = 1 ]
  GH_FAIL=1 read_usage
  [ -z "$U_AT" ] && [ "$USAGE_ERR" = 1 ]
}

# 멈춘 리뷰 표시(codex-paused). NOW = 1761900000
#   PR 12: 52(실행 152, 최근) · 51(실행 150, 옛것) — 다시 가능한 시각이 지남
#   PR 34: 53(실행 153) — 닫힌 PR
#   PR 56: 54(실행 125) — CI 워크플로가 같은 이름으로 올림(믿지 않음)
#   PR 90: 57(실행 157, 최근 · 아직 멈춤 시각 전) · 56(실행 156, 옛것)
#   55(실행 155) — 만료됨
paused_marker() {  # $1 = 결과 파일 id, $2 = PR, $3 = 다시 가능한 시각
  artifact_zip "$1" "pr=$2\nsha=abc\nretry=$3\nreason=low\n" codex-paused.txt
}

prs_fixture() {
  printf '%s\n' '{"artifacts":[' \
    ' {"id":51,"expired":false,"created_at":"2025-10-31T01:00:00Z","workflow_run":{"id":150}},' \
    ' {"id":53,"expired":false,"created_at":"2025-10-31T02:00:00Z","workflow_run":{"id":153}},' \
    ' {"id":52,"expired":false,"created_at":"2025-10-31T03:00:00Z","workflow_run":{"id":152}},' \
    ' {"id":54,"expired":false,"created_at":"2025-10-31T04:00:00Z","workflow_run":{"id":125}},' \
    ' {"id":55,"expired":true,"created_at":"2025-10-31T04:30:00Z","workflow_run":{"id":155}},' \
    ' {"id":56,"expired":false,"created_at":"2025-10-31T05:00:00Z","workflow_run":{"id":156}},' \
    ' {"id":57,"expired":false,"created_at":"2025-10-31T06:00:00Z","workflow_run":{"id":157}}]}' > "$TMP/paused.json"
  paused_marker 51 12 $(( NOW - 7200 ))
  paused_marker 52 12 $(( NOW - 60 ))
  paused_marker 53 34 $(( NOW - 60 ))
  paused_marker 54 56 $(( NOW - 60 ))
  paused_marker 55 78 $(( NOW - 60 ))
  paused_marker 56 90 $(( NOW - 60 ))
  paused_marker 57 90 $(( NOW + 3600 ))
  echo '{"state":"open"}' > "$TMP/pull-12.json"
  echo '{"state":"closed"}' > "$TMP/pull-34.json"
  echo '{"state":"open"}' > "$TMP/pull-90.json"
  for r in 150 152 153 156 157; do run_info "$r" "$REVIEW_WF" pull_request_target; done
  run_info 125 ".github/workflows/ci.yml" pull_request
}

@test "resume_paused: 다시 가능한 시각이 지난 PR마다 가장 최근 멈춘 실행 하나만 다시 돌리고, 그 PR의 표시를 모두 지운다" {
  need_jq; prs_fixture
  resume_paused
  [ "$RESUMED" = "#12" ] && [ -z "$RESUME_FAILED" ]
  grep -qx 'api repos/team/repo/actions/runs/152/rerun -X POST' "$TMP/gh.calls"
  not grep -q 'runs/150/rerun' "$TMP/gh.calls"
  grep -qx 'api repos/team/repo/actions/artifacts/52 -X DELETE' "$TMP/gh.calls"
  grep -qx 'api repos/team/repo/actions/artifacts/51 -X DELETE' "$TMP/gh.calls"
  grep -q 'actions/artifacts?name=codex-paused&' "$TMP/gh.calls"
}

@test "resume_paused: 닫힌 PR은 돌리지 않고 표시만 지우며, 리뷰 워크플로가 아닌 표시 · 만료된 표시는 건드리지 않는다" {
  need_jq; prs_fixture
  resume_paused
  not grep -q 'runs/153/rerun' "$TMP/gh.calls"
  grep -qx 'api repos/team/repo/actions/artifacts/53 -X DELETE' "$TMP/gh.calls"
  not grep -qE 'runs/125/rerun|artifacts/54 |artifacts/54/zip|pulls/56' "$TMP/gh.calls"
  not grep -qE 'runs/155|artifacts/55' "$TMP/gh.calls"
}

@test "resume_paused: 가장 최근 표시의 다시 가능한 시각이 아직이면 그 PR은 옛 표시까지 그대로 둔다" {
  need_jq; prs_fixture
  resume_paused
  not grep -qE 'runs/15[67]/rerun|artifacts/5[67] -X DELETE' "$TMP/gh.calls"
  [[ " $RESUMED $RESUME_FAILED " != *"#90"* ]]
}

@test "resume_paused: 다시 돌리기에 실패하면 알리고 표시를 지우며, 실행이 아직 안 끝났으면 기다린다" {
  need_jq; prs_fixture
  RERUN_RC=1 resume_paused
  [ -z "$RESUMED" ] && [ "$RESUME_FAILED" = "#12" ]
  grep -qx 'api repos/team/repo/actions/artifacts/52 -X DELETE' "$TMP/gh.calls"
  : > "$TMP/gh.calls"
  run_info 152 "$REVIEW_WF" pull_request_target in_progress
  resume_paused
  [ -z "$RESUMED" ] && [ -z "$RESUME_FAILED" ]
  not grep -qE 'runs/152/rerun|artifacts/5[12] -X DELETE' "$TMP/gh.calls"
}

@test "resume_paused: 멈춘 리뷰가 없거나 목록을 읽지 못하면 아무것도 하지 않는다" {
  need_jq
  resume_paused
  [ -z "$RESUMED" ] && [ -z "$RESUME_FAILED" ]
  prs_fixture
  GH_FAIL=1 resume_paused
  [ -z "$RESUMED" ] && [ -z "$RESUME_FAILED" ]
}

@test "main check: 러너 오프라인과 리뷰 멈춤을 한 메시지(embed 두 개)로 보내고 둘 다 저장한다" {
  need_jq; fixtures; artifacts_fixture; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  artifact_zip 20 'at=1761897600\nlimit=1\nretry=1761904800\n'
  sed -i 's/"status":"online","busy":true/"status":"offline","busy":false/' "$TMP/runners.json"
  write_state 'status=online\nsince=5\nstuck=0\nerr=0\nusage=ok\n'
  run main check
  [ "$status" -eq 0 ]
  [ "$(jq '.embeds | length' "$TMP/posted.json")" = 2 ]
  [[ "$(jq -r '.embeds[0].title' "$TMP/posted.json")" == "🔴"* ]]
  [ "$(jq -r '.embeds[1].title' "$TMP/posted.json")" = "⏸️ Codex 리뷰 멈춤 — 사용량 한도 도달" ]
  grep -qx 'status=offline' "$STATE_FILE"
  grep -qx 'usage=stop' "$STATE_FILE"
}

@test "main check: 경고만 바뀌어도 알리고 저장하며, 그대로면 저장하지 않는다" {
  need_jq; fixtures; artifacts_fixture; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  artifact_zip 20 'at=1761897600\np_used=85\np_window=10080\np_reset=1762261200\n'
  write_state 'status=online\nsince=5\nstuck=0\nerr=0\nusage=ok\n'
  GITHUB_OUTPUT="$TMP/out"
  run main check
  [ "$status" -eq 0 ]
  [ "$(jq '.embeds | length' "$TMP/posted.json")" = 1 ]
  [ "$(jq -r '.embeds[0].title' "$TMP/posted.json")" = "🟡 Codex 남은 사용량 20% 미만" ]
  grep -qx 'usage=warn' "$STATE_FILE" && grep -qx 'changed=true' "$TMP/out"
  rm -f "$TMP/posted.json" "$TMP/out"
  run main check
  [ "$status" -eq 0 ]
  [ ! -e "$TMP/posted.json" ] && [ ! -e "$TMP/out" ]
}

@test "main check: 멈춘 뒤 초기화 시각이 지나면 멈춘 리뷰를 다시 돌리고 ▶️를 알린다" {
  need_jq; fixtures; artifacts_fixture; prs_fixture; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  artifact_zip 20 'at=1761890000\np_used=95\np_window=300\np_reset=1761899000\n'  # 10/31 17:23 서울에 초기화됨
  write_state 'status=online\nsince=5\nstuck=0\nerr=0\nusage=stop\n'
  run main check
  [ "$status" -eq 0 ]
  [ "$(jq -r '.embeds[0].title' "$TMP/posted.json")" = "▶️ Codex 리뷰 다시 시작" ]
  [[ "$(jq -r '.embeds[0].description' "$TMP/posted.json")" == *"다시 돌립니다: #12"* ]]
  grep -qx 'api repos/team/repo/actions/runs/152/rerun -X POST' "$TMP/gh.calls"
  grep -qx 'usage=ok' "$STATE_FILE"
}

@test "main check: 멈춤 단계가 이어지면 표시의 시각이 지났어도 다시 돌리지 않는다" {
  need_jq; fixtures; artifacts_fixture; prs_fixture; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  artifact_zip 20 'at=1761897600\np_used=95\np_window=300\np_reset=1761904800\n'
  write_state 'status=online\nsince=5\nstuck=0\nerr=0\nusage=stop\n'
  run main check
  [ "$status" -eq 0 ]
  [ ! -e "$TMP/posted.json" ]
  not grep -qE '/rerun|codex-paused' "$TMP/gh.calls"
}

@test "main check: 사용량 기록이 없어도 표시의 다시 가능한 시각이 지나면 다시 돌리고 ▶️를 알린다" {
  need_jq; fixtures; prs_fixture; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  write_state 'status=online\nsince=5\nstuck=0\nerr=0\nusage=ok\n'
  run main check
  [ "$status" -eq 0 ]
  [ "$(jq '.embeds | length' "$TMP/posted.json")" = 1 ]
  [ "$(jq -r '.embeds[0].title' "$TMP/posted.json")" = "▶️ Codex 리뷰 다시 시작" ]
  [[ "$(jq -r '.embeds[0].description' "$TMP/posted.json")" == *"다시 돌립니다: #12"*"Codex 사용량: 기록 없음"* ]]
  grep -qx 'api repos/team/repo/actions/runs/152/rerun -X POST' "$TMP/gh.calls"
  # 다음 확인에서는 표시가 지워졌으므로(흉내에서는 남아 있어 여기서는 확인하지 않음) 같은 알림이 반복되지 않음
}

@test "main check: 사용량을 읽지 못해도 러너 판단은 그대로 하고 사용량 단계는 유지한다" {
  need_jq; fixtures; artifacts_fixture; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  write_state 'status=online\nsince=5\nstuck=0\nerr=0\nusage=stop\n'
  GITHUB_OUTPUT="$TMP/out"
  run main check
  [ "$status" -eq 0 ]
  [ ! -e "$TMP/posted.json" ] && [ ! -e "$TMP/out" ]
  grep -qx 'usage=stop' "$STATE_FILE"
}

@test "main summary: 아침 요약에 Codex 남은 사용량 줄이 들어간다" {
  need_jq; fixtures; artifacts_fixture; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  artifact_zip 20 "$USAGE_TXT"
  run main summary
  [ "$status" -eq 0 ]
  [[ "$(jq -r '.embeds[0].description' "$TMP/posted.json")" == *$'\nCodex 사용량: 주간 66% 남음 (11/04 22:00 초기화) — 10/31 17:00 리뷰 기준 · 플랜 plus\n'* ]]
}

@test "워크플로: 멈춘 리뷰를 다시 돌리고 PR 상태를 읽을 권한이 있다" {
  grep -qE '^  actions: write' "$WF"
  grep -qE '^  pull-requests: read' "$WF"
}

# bats에서 `! cmd` 한 줄은 실패해도 테스트를 실패시키지 않으므로 대신 씀
not() { if "$@"; then return 1; fi; }

@test "main summary: 아침 요약은 멈춘 리뷰를 다시 돌리지 않는다(15분 확인과 겹치지 않게)" {
  need_jq; fixtures; artifacts_fixture; prs_fixture; STATUS_TOKEN=t; DISCORD_WEBHOOK=https://discord.test/hook
  artifact_zip 20 "$USAGE_TXT"
  run main summary
  [ "$status" -eq 0 ]
  not grep -qE '/rerun|codex-paused' "$TMP/gh.calls"
}
