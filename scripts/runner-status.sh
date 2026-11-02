#!/usr/bin/env bash
# 리뷰 컴퓨터 러너(notelink-codex)의 상태를 디스코드로 알립니다.
#
#   scripts/runner-status.sh check     # 지난 상태와 비교해 바뀌었을 때만 알림 (15분마다)
#   scripts/runner-status.sh summary   # 아침 요약을 보냄 (매일 9시 서울, 수동 실행 시험 알림)
#
# - check 알림: 🔴 오프라인이 됨 · 🟢 다시 온라인(멈춰 있던 시간) · 🟡 온라인인데 Codex 리뷰가
#   STUCK_MINUTES분 넘게 대기(작업을 못 받는 상태) · ⚠️ 러너 상태를 ERR_ALERT_AFTER번 연속 읽지 못함 · ✅ 다시 읽힘
#   Codex 사용량(기준은 scripts/codex-usage-lib.sh): 🟡 남은 양이 20% 미만 · ⏸️ 10% 이하이거나 한도에 걸려
#   리뷰 컴퓨터가 리뷰를 멈춤 · ▶️ 다시 시작(초기화됨) · 멈춘 리뷰를 다시 돌림
#   멈춘 실행은 PR 댓글 없이 codex-paused 결과 파일(PR 번호 · 다시 가능한 시각)만 남기고, check가 15분마다
#   그 시각이 지난 것을 다시 돌림(Re-run). summary는 다시 돌리지 않음(check와 겹쳐 같은 실행을 두 번 돌리지 않게)
#   (한 번 확인에서 러너 알림과 함께 생기면 한 메시지에 embed 두 개로 보냄)
# - summary: 지금 상태, 대기 중인 리뷰, 지난 24시간에 끝난 Codex 리뷰 성공 · 실패 · 취소, Codex 남은 사용량
# - Codex 사용량은 리뷰가 끝날 때 리뷰 컴퓨터가 올린 결과 파일(codex-review.yml의 codex-usage,
#   scripts/codex-usage.mjs)의 가장 최근 것을 읽습니다. 리뷰가 돌 때만 바뀌므로 몇 시 리뷰 기준인지 함께 적습니다.
#   리뷰 워크플로(pull_request_target)가 올린 것만 씁니다(같은 이름으로 다른 워크플로가 올린 것은 건너뜀).
# - 지난 상태는 STATE_FILE에 둡니다(워크플로가 Actions 캐시로 이어 줌). 처음이면 온라인은 알리지 않습니다.
#   상태를 읽지 못한 동안에는 마지막으로 안 상태와 그 시각을 그대로 둡니다(멈춘 시간이 끊기지 않게).
# - 디스코드로 보내지 못하면 상태를 저장하지 않고 실패합니다(다음 실행에서 다시 보냄).
#
# 필요한 환경 변수: REPO(owner/name), DISCORD_WEBHOOK, STATUS_TOKEN(러너 목록을 읽는 토큰,
#   Administration: Read-only), GH_TOKEN(실행 목록 · 결과 파일을 읽고 멈춘 리뷰를 다시 돌리는 토큰,
#   워크플로의 GITHUB_TOKEN: actions: write · pull-requests: read), STATE_FILE
# 필요한 것: gh, jq, curl, unzip, GNU date. 시각은 서울 시간으로 적습니다.
#
# 테스트: scripts/tests/runner-status.bats (source하면 main은 실행되지 않습니다)

# 감시할 러너 이름. RUNNER_NAME · RUNNER_OS처럼 RUNNER_로 시작하는 이름은 Actions가 지금 작업을 돌리는
# 러너의 정보로 채우므로 쓰지 않습니다(CI에서 RUNNER_NAME="GitHub Actions N"을 찾다가 missing이 됐음).
CODEX_RUNNER="${CODEX_RUNNER:-notelink-codex}"
REVIEW_WORKFLOW="${REVIEW_WORKFLOW:-codex-review.yml}"
STUCK_MINUTES="${STUCK_MINUTES:-30}"
ERR_ALERT_AFTER="${ERR_ALERT_AFTER:-2}"  # 15분 × 2 = 30분 넘게 못 읽으면 알림(일시적인 API 오류는 넘김)
STATE_FILE="${STATE_FILE:-.runner-status/state}"
USAGE_ARTIFACT="${USAGE_ARTIFACT:-codex-usage}"  # codex-review.yml이 올리는 결과 파일 이름
USAGE_FILE_NAME="codex-usage.txt"                  # 결과 파일(zip) 안의 파일 이름
USAGE_CANDIDATES="${USAGE_CANDIDATES:-5}"          # 출처를 확인할 최근 결과 파일 수
REVIEW_WORKFLOW_PATH=".github/workflows/$REVIEW_WORKFLOW"

# 디스코드 embed 색
COLOR_RED=15026253     # #E5484D
COLOR_GREEN=3187820    # #30A46C
COLOR_ORANGE=15761187  # #F08223
COLOR_YELLOW=16098596  # #F5A524
COLOR_GRAY=9145752     # #8B8D98
COLOR_BLUE=4088797     # #3E63DD

# gh --jq 필터 (테스트에서 jq로 같은 필터를 검증합니다)
# 러너 목록에서 이름이 같은 러너: status \t busy   ($name은 --arg 대신 문자열로 끼움)
runner_jq() {  # $1 = 러너 이름
  printf '.runners[] | select(.name == "%s") | [.status, (.busy | tostring)] | @tsv' "$1"
}
# 상태로 거른 실행 목록: 개수 \t 가장 오래 기다린 시작 시각 (없으면 빈 값)
# 재실행(Re-run)한 실행은 created_at이 처음 만든 시각으로 남으므로 run_started_at(재실행 때 바뀜)을 씀
QUEUE_JQ='[.workflow_runs[] | (.run_started_at // .created_at)] | [length, (min // "")] | @tsv'
# 이 시각 이후에 끝난 실행의 결론을 한 줄씩 (ISO 시각은 문자열 비교로 순서가 맞음)
done_jq() {  # $1 = 시작 시각(UTC ISO)
  printf '.workflow_runs[] | select(.status == "completed" and .updated_at >= "%s") | .conclusion' "$1"
}
# 이름으로 거른 결과 파일 중 만료되지 않은 것을 최근 것부터: 결과 파일 id \t 올린 실행 id
ARTIFACT_JQ='[.artifacts[] | select(.expired | not)] | sort_by(.created_at) | reverse | .[] | [.id, .workflow_run.id] | @tsv'
# 실행 정보: 워크플로 파일 \t 이벤트 \t 상태
RUN_JQ='[.path, .event, .status] | @tsv'
# 멈춘 리뷰 표시 결과 파일 (codex-review.yml이 올림, 안에 pr= · retry= …)
PAUSED_ARTIFACT="${PAUSED_ARTIFACT:-codex-paused}"
PAUSED_FILE_NAME="codex-paused.txt"
# 만료되지 않은 멈춤 표시: created_at 	 결과 파일 id 	 실행 id (쪽마다 나오므로 합친 뒤 정렬)
PAUSED_JQ='.artifacts[] | select(.expired | not) | [.created_at, .id, .workflow_run.id] | @tsv'

# kst · load_usage · usage_level (리뷰 컴퓨터와 같은 기준)
# shellcheck source=codex-usage-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/codex-usage-lib.sh"

duration() {  # $1 = 분 → "2일 3시간 5분" / "45분"
  local m=$(( $1 < 0 ? 0 : $1 )) out=""
  (( m >= 1440 )) && out+="$(( m / 1440 ))일 "
  (( m % 1440 >= 60 )) && out+="$(( m % 1440 / 60 ))시간 "
  if (( m % 60 > 0 || m == 0 )); then out+="$(( m % 60 ))분"; fi
  printf '%s' "${out% }"
}

# ---------- 상태 파일 ----------

# → PREV_STATUS(마지막으로 안 상태: online|offline, 처음이면 빈 값) · PREV_SINCE(그 상태가 된 시각, 모르면 0)
#   · PREV_STUCK(🟡 알림을 보냈는지 0|1) · PREV_ERR(연속으로 상태를 읽지 못한 횟수)
#   · PREV_USAGE(마지막으로 안 Codex 사용량 단계: ok|warn|stop, 처음이면 빈 값)
#   · PREV_FAILED(다시 돌리기에 실패해 이미 알린 멈춤 표시 id, 쉼표로 구분)
load_state() {
  PREV_STATUS=""; PREV_SINCE=0; PREV_STUCK=0; PREV_ERR=0; PREV_USAGE=""; PREV_FAILED=""
  [ -f "$STATE_FILE" ] || return 0
  local k v
  while IFS='=' read -r k v; do
    case "$k" in
      status) [[ "$v" =~ ^(online|offline)$ ]] && PREV_STATUS=$v ;;
      since) [[ "$v" =~ ^[0-9]+$ ]] && PREV_SINCE=$v ;;
      stuck) [[ "$v" =~ ^[01]$ ]] && PREV_STUCK=$v ;;
      err) [[ "$v" =~ ^[0-9]+$ ]] && PREV_ERR=$v ;;
      usage) [[ "$v" =~ ^(ok|warn|stop)$ ]] && PREV_USAGE=$v ;;
      failed) [[ "$v" =~ ^[0-9]+(,[0-9]+)*$ ]] && PREV_FAILED=$v ;;
    esac
  done < "$STATE_FILE"
  return 0
}

save_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  printf 'status=%s\nsince=%s\nstuck=%s\nerr=%s\nusage=%s\nfailed=%s\n' \
    "$NEW_STATUS" "$NEW_SINCE" "$NEW_STUCK" "$NEW_ERR" "$NEW_USAGE" "${NEW_FAILED:-}" > "$STATE_FILE"
}

state_changed() {
  [ ! -f "$STATE_FILE" ] || [ "$NEW_STATUS" != "$PREV_STATUS" ] || [ "$NEW_SINCE" != "$PREV_SINCE" ] \
    || [ "$NEW_STUCK" != "$PREV_STUCK" ] || [ "$NEW_ERR" != "$PREV_ERR" ] || [ "$NEW_USAGE" != "$PREV_USAGE" ] \
    || [ "${NEW_FAILED:-}" != "${PREV_FAILED:-}" ]
}

# ---------- GitHub 조회 ----------

# → CUR_STATUS(online|offline|error|missing) · BUSY(true|false) · ERROR_MSG
read_runner() {
  CUR_STATUS=""; BUSY=false; ERROR_MSG=""
  if [ -z "${STATUS_TOKEN:-}" ]; then
    CUR_STATUS=error; ERROR_MSG="RUNNER_STATUS_TOKEN 비밀값이 없습니다"
    return
  fi
  local out errf
  errf=$(mktemp)
  # 성공했을 때 gh가 stderr에 남기는 안내가 결과에 섞이지 않게 stderr는 따로 받음
  if ! out=$(GH_TOKEN="$STATUS_TOKEN" gh api "repos/$REPO/actions/runners?per_page=100" \
      --jq "$(runner_jq "$CODEX_RUNNER")" 2> "$errf"); then
    CUR_STATUS=error; ERROR_MSG=$(head -n 1 "$errf" | cut -c 1-200)
    : "${ERROR_MSG:=러너 목록을 읽지 못했습니다}"
    rm -f "$errf"
    return
  fi
  rm -f "$errf"
  if [ -z "$out" ]; then
    CUR_STATUS=missing; ERROR_MSG="저장소에서 러너 $CODEX_RUNNER 을 찾지 못했습니다"
    return
  fi
  IFS=$'\t' read -r CUR_STATUS BUSY <<< "$(head -n 1 <<< "$out")"
  [[ "$CUR_STATUS" =~ ^(online|offline)$ ]] || { ERROR_MSG="알 수 없는 상태: $CUR_STATUS"; CUR_STATUS=error; }
}

# → QUEUED(대기 · 동시 실행 대기 개수, 읽지 못하면 빈 값) · WAIT_MIN(가장 오래 기다린 분, 없으면 0)
# 최근 실행 목록에서 고르면 건너뜀 · 취소가 쌓였을 때 오래된 대기가 밀려나므로 API에서 상태로 거름.
# 100건이 넘어도 빠지지 않게 쪽마다(--paginate) 받음(쪽마다 "개수 \t 가장 오래된 시각" 한 줄)
read_queue() {
  QUEUED=""; WAIT_MIN=0
  local s out n t total=0 oldest=""
  for s in queued pending; do
    out=$(gh api "repos/$REPO/actions/workflows/$REVIEW_WORKFLOW/runs?status=$s&per_page=100" \
      --jq "$QUEUE_JQ" --paginate 2> /dev/null) || return 0
    while IFS=$'\t' read -r n t; do
      [[ "$n" =~ ^[0-9]+$ ]] || return 0
      total=$(( total + n ))
      if [ -n "$t" ] && { [ -z "$oldest" ] || [[ "$t" < "$oldest" ]]; }; then oldest=$t; fi
    done <<< "$out"
  done
  QUEUED=$total
  if [ -n "$oldest" ]; then
    WAIT_MIN=$(( (NOW - $(date -u -d "$oldest" +%s)) / 60 ))
  fi
}

# 지난 24시간에 끝난 Codex 리뷰 → DONE_OK · DONE_FAIL(시간 초과 포함) · DONE_CANCEL (읽지 못하면 빈 값)
# API의 created는 만든 시각이라, 오래 기다리다 오늘 끝난 리뷰도 세도록 끝난 시각(updated_at)으로 거름.
# 재실행하면 만든 시각은 그대로인데, GitHub는 처음 실행 후 30일까지만 재실행을 허용함. 가장 늦은 경우는
# 재실행 기한 30일 + 대기 최대 24시간 + 리뷰 처리 최대 60분(codex-review.yml timeout) + 요약 구간 24시간 = 32일 1시간.
# 여유를 두어 35일 안에 만든 실행을 쪽마다(--paginate) 받아 봄(하루 한 번, 하루 20건 안팎이라 7~8쪽)
read_counts() {
  DONE_OK=""; DONE_FAIL=""; DONE_CANCEL=""
  local from since out
  from=$(date -u -d "@$(( NOW - 86400 ))" '+%Y-%m-%dT%H:%M:%SZ')
  since=$(date -u -d "@$(( NOW - 35 * 86400 ))" '+%Y-%m-%dT%H:%M:%SZ')
  out=$(gh api "repos/$REPO/actions/workflows/$REVIEW_WORKFLOW/runs?per_page=100&created=%3E%3D$since" \
    --jq "$(done_jq "$from")" --paginate 2> /dev/null) || return 0
  DONE_OK=$(grep -cx 'success' <<< "$out" || true)
  DONE_FAIL=$(grep -cxE 'failure|timed_out' <<< "$out" || true)
  DONE_CANCEL=$(grep -cx 'cancelled' <<< "$out" || true)
}

# 가장 최근 codex-usage 결과 파일 → U_* (없으면 U_AT 빈 값) · USAGE_ERR(조회 · 내려받기에 실패했으면 1)
# 리뷰 워크플로가 pull_request_target으로 올린 것만 씀. 최근 USAGE_CANDIDATES개 중 처음 맞는 것
read_usage() {
  no_usage; USAGE_ERR=0
  local list id run src dir
  if ! list=$(gh api "repos/$REPO/actions/artifacts?name=$USAGE_ARTIFACT&per_page=100" \
      --jq "$ARTIFACT_JQ" 2> /dev/null); then
    USAGE_ERR=1; return 0
  fi
  [ -n "$list" ] || return 0  # 보관 기간 안에 Codex를 돌린 리뷰가 없음
  while IFS=$'\t' read -r id run; do
    [[ "$id" =~ ^[0-9]+$ ]] && [[ "$run" =~ ^[0-9]+$ ]] || continue
    src=$(gh api "repos/$REPO/actions/runs/$run" --jq "$RUN_JQ" 2> /dev/null) || { USAGE_ERR=1; return 0; }
    [ "$(cut -f 1,2 <<< "$src")" = "$REVIEW_WORKFLOW_PATH"$'\t'"pull_request_target" ] || continue
    dir=$(mktemp -d)
    if gh api "repos/$REPO/actions/artifacts/$id/zip" > "$dir/usage.zip" 2> /dev/null \
        && unzip -p "$dir/usage.zip" "$USAGE_FILE_NAME" > "$dir/usage" 2> /dev/null; then
      load_usage "$dir/usage"
    fi
    rm -rf "$dir"
    [ -n "$U_AT" ] || USAGE_ERR=1
    return 0
  done < <(head -n "$USAGE_CANDIDATES" <<< "$list")
  return 0  # 최근 것 중 리뷰 워크플로가 올린 것이 없음 → 기록 없음
}

# 결과 파일 하나를 내려받아 안의 파일을 $3에 씀 (실패하면 1)
download_artifact() {  # $1 = 결과 파일 id, $2 = 안의 파일 이름, $3 = 쓸 파일
  local dir ok=1
  dir=$(mktemp -d)
  if gh api "repos/$REPO/actions/artifacts/$1/zip" > "$dir/a.zip" 2> /dev/null \
      && unzip -p "$dir/a.zip" "$2" > "$3" 2> /dev/null; then
    ok=0
  fi
  rm -rf "$dir"
  return "$ok"
}

sort_prs() {  # "#34 #12" → "#12 #34"
  tr ' ' '\n' | grep -E '^#[0-9]+$' | sort -t '#' -k 2 -n | paste -sd ' ' -
}

# 다시 가능한 시각이 지난 멈춘 리뷰를 다시 돌림 → RESUMED · RESUME_FAILED("#12 #34" 꼴, 새로 알릴 실패만)
#   · NEW_FAILED(다시 돌리기에 실패한 표시 id. 상태 파일에 남겨 같은 실패를 15분마다 다시 알리지 않음)
# - codex-paused 결과 파일을 모든 쪽(--paginate)에서 최근 것부터 봄. PR마다 가장 최근 표시 하나로 정함
#   (다시 돌렸거나 닫힌 PR이면 그 PR의 옛 표시도 함께 지움)
# - 표시의 retry가 지나지 않았거나, 그 실행이 아직 끝나지 않았으면 그대로 둠(다음 확인에서 다시 봄)
# - 리뷰 워크플로(pull_request_target)가 올린 표시만 믿고, 다른 것은 건너뜀
# - 닫힌 PR은 돌리지 않고 표시만 지움
# - 다시 돌리기에 실패하면 표시를 남겨 다음 확인에서 다시 시도하고, 처음 실패했을 때만 알림
# - 목록을 읽지 못하면 아무것도 하지 않음(다음 확인에서 다시, 알린 실패 기록은 그대로)
resume_paused() {
  RESUMED=""; RESUME_FAILED=""
  local list id run src pr retry state tmp failed=""
  local -A decided=()
  if ! list=$(gh api "repos/$REPO/actions/artifacts?name=$PAUSED_ARTIFACT&per_page=100" \
      --jq "$PAUSED_JQ" --paginate 2> /dev/null); then
    NEW_FAILED=${PREV_FAILED:-}
    return 0
  fi
  NEW_FAILED=""
  list=$(sort -r <<< "$list" | cut -f 2,3)  # 모든 쪽을 합쳐 최근 것부터
  [ -n "$list" ] || return 0
  tmp=$(mktemp)
  while IFS=$'\t' read -r id run; do
    [[ "$id" =~ ^[0-9]+$ ]] && [[ "$run" =~ ^[0-9]+$ ]] || continue
    src=$(gh api "repos/$REPO/actions/runs/$run" --jq "$RUN_JQ" 2> /dev/null) || continue
    [ "$(cut -f 1,2 <<< "$src")" = "$REVIEW_WORKFLOW_PATH"$'\t'"pull_request_target" ] || continue
    download_artifact "$id" "$PAUSED_FILE_NAME" "$tmp" || continue
    pr=$(sed -n 's/^pr=\([0-9]\{1,\}\)$/\1/p' "$tmp" | head -n 1)
    retry=$(sed -n 's/^retry=\([0-9]\{1,\}\)$/\1/p' "$tmp" | head -n 1)
    [ -n "$pr" ] || continue
    if [ -n "${decided[$pr]:-}" ]; then
      # 같은 PR의 더 오래된 표시: 가장 최근 표시로 다시 돌렸거나 닫힌 PR이면 함께 지움
      case "${decided[$pr]}" in
        resumed | closed) gh api "repos/$REPO/actions/artifacts/$id" -X DELETE > /dev/null 2>&1 || true ;;
      esac
      continue
    fi
    if [ -n "$retry" ] && [ "$retry" -gt "$NOW" ]; then decided[$pr]=wait; continue; fi
    if [ "$(cut -f 3 <<< "$src")" != completed ]; then decided[$pr]=wait; continue; fi
    state=$(gh api "repos/$REPO/pulls/$pr" --jq .state 2> /dev/null) || { decided[$pr]=wait; continue; }
    if [ "$state" = closed ]; then
      decided[$pr]=closed
    elif gh api "repos/$REPO/actions/runs/$run/rerun" -X POST > /dev/null 2>&1; then
      decided[$pr]=resumed; RESUMED+=" #$pr"
    else
      # 표시를 남겨 다음 확인에서 다시 시도. 이미 알린 실패면 다시 알리지 않음
      decided[$pr]=failed; failed+="${failed:+,}$id"
      [[ ",${PREV_FAILED:-}," == *",$id,"* ]] || RESUME_FAILED+=" #$pr"
      continue
    fi
    gh api "repos/$REPO/actions/artifacts/$id" -X DELETE > /dev/null 2>&1 || true
  done <<< "$list"
  rm -f "$tmp"
  NEW_FAILED=$failed
  RESUMED=$(sort_prs <<< "$RESUMED"); RESUME_FAILED=$(sort_prs <<< "$RESUME_FAILED")
  return 0
}

# ---------- 판단 ----------

# 지난 상태(PREV_*)와 지금(CUR_STATUS · BUSY · QUEUED · WAIT_MIN · NOW)으로
# EVENT(offline|online|stuck|error|recovered, 알릴 것이 없으면 빈 값)와 저장할 NEW_*를 정함
decide() {
  EVENT=""; NEW_STATUS=$PREV_STATUS; NEW_SINCE=$PREV_SINCE; NEW_STUCK=$PREV_STUCK; NEW_ERR=0
  if [ "$CUR_STATUS" = error ] || [ "$CUR_STATUS" = missing ]; then
    # 지금 상태를 모르므로 마지막으로 안 상태 · 시각 · 🟡 표시는 그대로 둠
    NEW_ERR=$(( PREV_ERR + 1 ))
    [ "$NEW_ERR" -eq "$ERR_ALERT_AFTER" ] && EVENT=error
    return 0
  fi
  NEW_STATUS=$CUR_STATUS
  if [ "$CUR_STATUS" != "$PREV_STATUS" ]; then
    NEW_STUCK=0
    if [ -n "$PREV_STATUS" ]; then
      NEW_SINCE=$NOW; EVENT=$CUR_STATUS
      return 0  # 막 다시 온라인이 됐으면 쌓인 대기열을 처리할 시간을 줌
    fi
    # 처음 확인: 온라인은 언제부터인지 모름(0). 오프라인은 지금부터로 보고 알림
    if [ "$CUR_STATUS" = offline ]; then
      NEW_SINCE=$NOW; EVENT=offline
      return 0
    fi
    NEW_SINCE=0
  fi
  [ "$PREV_ERR" -ge "$ERR_ALERT_AFTER" ] && EVENT=recovered
  # 온라인인데 작업 중이 아니고 리뷰가 오래 기다리면 작업을 못 받는 상태로 봄(한 번만 알림).
  # 대기열을 읽지 못했으면 판단하지 않고 표시를 그대로 둠.
  [ -n "$QUEUED" ] || return 0
  if [ "$CUR_STATUS" = online ] && [ "$BUSY" != true ] && [ "$QUEUED" -gt 0 ] \
      && [ "$WAIT_MIN" -ge "$STUCK_MINUTES" ]; then
    # 아직 알리지 않았으면 ✅ 복구보다 🟡를 보냄(상태를 다시 읽는다는 것도 함께 알 수 있음).
    # 보내지 않은 알림을 보낸 것으로 기록하면 같은 정체가 이어져도 다시 알리지 않게 됨
    NEW_STUCK=1
    [ "$PREV_STUCK" = 1 ] || EVENT=stuck
  else
    NEW_STUCK=0
  fi
}

# 지난 단계(PREV_USAGE)와 지금(CUR_USAGE, usage_level)으로 USAGE_EVENT(usage_warn|usage_stop|usage_resume)와
# NEW_USAGE를 정함. 기록을 읽지 못했으면 판단하지 않고 그대로 둠. 처음 확인이라도 warn · stop은 알림
decide_usage() {
  USAGE_EVENT=""; NEW_USAGE=$PREV_USAGE
  [ -n "$CUR_USAGE" ] || return 0
  NEW_USAGE=$CUR_USAGE
  [ "$CUR_USAGE" = "$PREV_USAGE" ] && return 0
  case "$CUR_USAGE" in
    stop) USAGE_EVENT=usage_stop ;;
    warn) if [ "$PREV_USAGE" = stop ]; then USAGE_EVENT=usage_resume; else USAGE_EVENT=usage_warn; fi ;;
    ok) [ "$PREV_USAGE" = stop ] && USAGE_EVENT=usage_resume ;;
  esac
  return 0
}

# ---------- 메시지 ----------

queue_line() {  # 대기 중인 리뷰 한 줄
  if [ -z "$QUEUED" ]; then
    echo "대기 중인 Codex 리뷰: 확인하지 못함"
  elif [ "$QUEUED" -eq 0 ]; then
    echo "대기 중인 Codex 리뷰: 없음"
  else
    echo "대기 중인 Codex 리뷰: ${QUEUED}건 (가장 오래 기다린 것 $(duration "$WAIT_MIN"))"
  fi
}

status_word() {  # $1 = 상태 → 한국어
  case "$1" in
    online) [ "$BUSY" = true ] && echo "🟢 온라인 (리뷰 중)" || echo "🟢 온라인 (대기 중)" ;;
    offline) echo "🔴 오프라인" ;;
    *) echo "⚠️ 확인하지 못함" ;;
  esac
}

window_name() {  # $1 = 창 길이(분) → "5시간" · "주간" · "3일" …
  case "$1" in
    10080) echo "주간" ;;
    *) if (( $1 % 1440 == 0 )); then echo "$(( $1 / 1440 ))일"
       elif (( $1 % 60 == 0 )); then echo "$(( $1 / 60 ))시간"
       else echo "$1분"; fi ;;
  esac
}

# 창별 남은 양: "5시간 88% 남음 (11/02 15:01 초기화) · 주간 66% 남음 (11/07 15:01 초기화)"
usage_windows() {
  local out="" w used win reset part
  for w in P S; do
    used="U_${w}_USED"; win="U_${w}_WINDOW"; reset="U_${w}_RESET"
    used=${!used}; win=${!win}; reset=${!reset}
    [ -n "$used" ] || continue
    part=$( [ -n "$win" ] && window_name "$win" || echo "사용량")
    if [ -n "$reset" ] && [ "$reset" -le "$NOW" ]; then
      part+=" 초기화됨 ($(kst "$reset"))"
    else
      part+=" $(( used >= 100 ? 0 : 100 - used ))% 남음"
      [ -n "$reset" ] && part+=" ($(kst "$reset") 초기화)"
    fi
    out+="${out:+ · }$part"
  done
  printf '%s' "$out"
}

usage_line() {  # Codex 사용량 한 줄 (read_usage · usage_level 뒤)
  if [ -z "$U_AT" ]; then
    if [ "$USAGE_ERR" = 1 ]; then echo "Codex 사용량: 확인하지 못함"
    else echo "Codex 사용량: 기록 없음 (최근에 Codex를 돌린 리뷰가 없음)"; fi
    return
  fi
  local wins basis why
  wins=$(usage_windows)
  basis="$(kst "$U_AT") 리뷰 기준${U_PLAN:+ · 플랜 $U_PLAN}"
  case "$CUR_USAGE" in
    stop)
      why="남은 양 ${USAGE_STOP_LEFT}% 이하"
      [ "$USAGE_REASON" = limit ] && why="한도 도달"
      echo "Codex 사용량: ⏸️ 리뷰 멈춤($why), $(kst "$USAGE_RETRY")에 다시 시작${wins:+ · $wins} — $basis" ;;
    warn) echo "Codex 사용량: 🟡 $wins — $basis" ;;
    *)
      if [ -z "$wins" ] && [ "$U_LIMIT" = 1 ]; then wins="한도가 풀림"; fi
      echo "Codex 사용량: ${wins:-남은 양 모름} — $basis" ;;
  esac
}

# EVENT(또는 summary)에 맞는 TITLE · TEXT · COLOR를 채움
compose() {  # $1 = offline|online|stuck|error|recovered|usage_warn|usage_stop|usage_resume|summary
  local runners="https://github.com/$REPO/settings/actions/runners"
  local queue="https://github.com/$REPO/actions/workflows/$REVIEW_WORKFLOW"
  local failed="$queue?query=is%3Afailure"
  case "$1" in
    usage_warn)
      TITLE="🟡 Codex 남은 사용량 ${USAGE_WARN_LEFT}% 미만"; COLOR=$COLOR_YELLOW
      TEXT="$(usage_line)
남은 양이 ${USAGE_STOP_LEFT}% 이하가 되면 리뷰를 멈추고, 초기화되면 멈춘 리뷰를 자동으로 다시 돌립니다." ;;
    usage_stop)
      COLOR=$COLOR_ORANGE
      if [ "$USAGE_REASON" = limit ]; then TITLE="⏸️ Codex 리뷰 멈춤 — 사용량 한도 도달"
      else TITLE="⏸️ Codex 리뷰 멈춤 — 남은 사용량 ${USAGE_STOP_LEFT}% 이하"; fi
      TEXT="$(kst "$USAGE_RETRY")에 사용량이 초기화될 때까지 리뷰 컴퓨터가 Codex 리뷰를 하지 않습니다.
그동안의 리뷰 실행은 PR 댓글 없이 실행 화면에 ⏸️로 남고, 초기화되면 자동으로 다시 돌립니다.
[Codex 리뷰 실행]($queue)
$(usage_line)" ;;
    usage_resume)
      TITLE="▶️ Codex 리뷰 다시 시작"; COLOR=$COLOR_GREEN
      TEXT="Codex 사용량이 초기화됐습니다."
      if [ -n "$RESUMED" ]; then TEXT+=" 멈췄던 리뷰를 다시 돌립니다: $RESUMED"
      elif [ -z "$RESUME_FAILED" ]; then TEXT+=" 다시 돌릴 멈춘 리뷰는 없습니다."; fi
      if [ -n "$RESUME_FAILED" ]; then TEXT+="
다시 돌리지 못함: $RESUME_FAILED — 15분마다 다시 시도합니다. 계속 안 되면 PR의 Codex 리뷰 실행을 직접 Re-run 하세요. [실패한 Codex 리뷰]($failed)"; fi
      TEXT+="
$(usage_line)" ;;
    offline)
      TITLE="🔴 리뷰 컴퓨터 러너 오프라인"; COLOR=$COLOR_RED
      TEXT="\`$CODEX_RUNNER\` 러너가 오프라인입니다. ($(kst "$NOW") 확인)
$(queue_line)
리뷰 컴퓨터가 켜져 있는지, 러너 서비스가 돌고 있는지 확인하세요.
[러너 목록]($runners) · [Codex 리뷰 실행]($queue)" ;;
    online)
      TITLE="🟢 리뷰 컴퓨터 러너 다시 온라인"; COLOR=$COLOR_GREEN
      TEXT="\`$CODEX_RUNNER\` 러너가 다시 온라인입니다.
멈춰 있던 시간: 약 $(duration $(( (NOW - PREV_SINCE) / 60 ))) ($(kst "$PREV_SINCE") ~ $(kst "$NOW"))
$(queue_line)" ;;
    stuck)
      TITLE="🟡 Codex 리뷰가 처리되지 않음"; COLOR=$COLOR_YELLOW
      TEXT="\`$CODEX_RUNNER\` 러너는 온라인인데 리뷰를 받지 못하고 있습니다.
$(queue_line)
리뷰 컴퓨터에서 러너 서비스를 다시 시작하세요.
[Codex 리뷰 실행]($queue)" ;;
    error)
      TITLE="⚠️ 러너 상태를 확인하지 못함"; COLOR=$COLOR_GRAY
      TEXT="$ERROR_MSG
\`RUNNER_STATUS_TOKEN\`의 기한 · 권한(Administration: Read-only)과 러너 등록을 확인하세요.
[러너 목록]($runners)" ;;
    recovered)
      TITLE="✅ 러너 상태 확인 복구"; COLOR=$COLOR_GREEN
      TEXT="러너 상태를 다시 읽을 수 있습니다. 지금 상태: $(status_word "$CUR_STATUS")
$(queue_line)" ;;
    summary)
      TITLE="📋 리뷰 컴퓨터 아침 요약 ($(kst "$NOW" | cut -d ' ' -f 1))"; COLOR=$COLOR_BLUE
      local since="" done_line
      if [ "$CUR_STATUS" = "$PREV_STATUS" ] && [ "$PREV_SINCE" -gt 0 ]; then
        since=" — $(kst "$PREV_SINCE")부터"
      fi
      if [ -n "$DONE_OK" ]; then
        done_line="지난 24시간에 끝난 Codex 리뷰: 성공 ${DONE_OK} · 실패 ${DONE_FAIL} · 취소 ${DONE_CANCEL}"
      else
        done_line="지난 24시간에 끝난 Codex 리뷰: 확인하지 못함"
      fi
      TEXT="러너 \`$CODEX_RUNNER\`: $(status_word "$CUR_STATUS")$since"
      [ -n "$ERROR_MSG" ] && TEXT+="
($ERROR_MSG)"
      TEXT+="
$(queue_line)
$done_line
$(usage_line)
[Codex 리뷰 실행]($queue)" ;;
  esac
}

# compose로 채운 TITLE · TEXT · COLOR를 보낼 embed 목록(EMBEDS, JSON 배열)에 더함
add_embed() {
  EMBEDS=$(jq -c --arg title "$TITLE" --arg text "$TEXT" --argjson color "$COLOR" \
    '. + [{title: $title, description: $text, color: $color}]' <<< "${EMBEDS:-[]}")
}

# 디스코드 웹후크 본문 (멘션은 막음). EMBEDS가 없으면 지금 TITLE · TEXT · COLOR 하나
payload() {
  [ -n "${EMBEDS:-}" ] || add_embed
  jq -n --argjson embeds "$EMBEDS" '{username: "NoteLink 러너", allowed_mentions: {parse: []}, embeds: $embeds}'
}

post() {
  curl -fsS --retry 2 -H 'Content-Type: application/json' -d "$(payload)" "$DISCORD_WEBHOOK" > /dev/null
}

# ---------- 실행 ----------

main() {
  local mode="${1:-check}"
  case "$mode" in check | summary) ;; *) echo "사용법: $0 check|summary" >&2; return 2 ;; esac
  : "${REPO:?REPO(owner/name)가 필요합니다}"
  if [ -z "${DISCORD_WEBHOOK:-}" ]; then
    echo "::error::DISCORD_RUNNER_WEBHOOK 비밀값이 없습니다." >&2
    return 1
  fi
  NOW=${NOW:-$(date +%s)}
  load_state
  read_runner
  read_queue
  read_usage
  usage_level
  echo "러너 $CODEX_RUNNER: $CUR_STATUS (작업 중: $BUSY) ${ERROR_MSG:+— $ERROR_MSG}"
  echo "지난 상태: ${PREV_STATUS:-없음} (연속 확인 실패 $PREV_ERR번) · $(queue_line)"
  echo "$(usage_line) · 지난 단계: ${PREV_USAGE:-없음}"

  EMBEDS=""
  if [ "$mode" = summary ]; then
    read_counts
    compose summary
    post || { echo "::error::디스코드로 보내지 못했습니다." >&2; return 1; }
    echo "아침 요약을 보냈습니다."
    return 0
  fi

  decide
  decide_usage
  # 지금 멈춤 단계로 확인되지 않으면(기록을 못 읽은 경우 포함) 다시 가능한 시각이 지난 멈춘 리뷰를 다시 돌림.
  # 초기화 전환이 아닐 때 다시 돌린 것이 있어도 ▶️를 보냄
  RESUMED=""; RESUME_FAILED=""; NEW_FAILED=${PREV_FAILED:-}
  [ "$CUR_USAGE" != stop ] && resume_paused
  if [ -z "$USAGE_EVENT" ] && [ -n "$RESUMED$RESUME_FAILED" ]; then USAGE_EVENT=usage_resume; fi
  # 러너 알림과 사용량 알림을 한 메시지로 보냄(하나만 보내지고 하나는 실패하는 일이 없게)
  [ -n "$EVENT" ] && { compose "$EVENT"; add_embed; }
  [ -n "$USAGE_EVENT" ] && { compose "$USAGE_EVENT"; add_embed; }
  if [ -n "$EMBEDS" ]; then
    post || { echo "::error::디스코드로 보내지 못했습니다. 상태를 저장하지 않고 다음 실행에서 다시 보냅니다." >&2; return 1; }
    echo "알림: $EVENT $USAGE_EVENT"
  else
    echo "알릴 것 없음"
  fi
  # 바뀐 것이 있을 때만 저장(워크플로가 이 값을 보고 캐시를 새로 만듦)
  if state_changed; then
    save_state
    [ -n "${GITHUB_OUTPUT:-}" ] && echo "changed=true" >> "$GITHUB_OUTPUT"
  fi
  return 0
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
