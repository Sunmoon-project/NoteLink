#!/usr/bin/env bash
# 리뷰 컴퓨터 러너(notelink-codex)의 상태를 디스코드로 알립니다.
#
#   scripts/runner-status.sh check     # 지난 상태와 비교해 바뀌었을 때만 알림 (15분마다)
#   scripts/runner-status.sh summary   # 아침 요약을 보냄 (매일 9시 서울, 수동 실행 시험 알림)
#
# - check 알림: 🔴 오프라인이 됨 · 🟢 다시 온라인(멈춰 있던 시간) · 🟡 온라인인데 Codex 리뷰가
#   STUCK_MINUTES분 넘게 대기(작업을 못 받는 상태) · ⚠️ 러너 상태를 ERR_ALERT_AFTER번 연속 읽지 못함 · ✅ 다시 읽힘
# - summary: 지금 상태, 대기 중인 리뷰, 지난 24시간 Codex 리뷰 성공 · 실패 · 취소
# - 지난 상태는 STATE_FILE에 둡니다(워크플로가 Actions 캐시로 이어 줌). 처음이면 온라인은 알리지 않습니다.
#   상태를 읽지 못한 동안에는 마지막으로 안 상태와 그 시각을 그대로 둡니다(멈춘 시간이 끊기지 않게).
# - 디스코드로 보내지 못하면 상태를 저장하지 않고 실패합니다(다음 실행에서 다시 보냄).
#
# 필요한 환경 변수: REPO(owner/name), DISCORD_WEBHOOK, STATUS_TOKEN(러너 목록을 읽는 토큰,
#   Administration: Read-only), GH_TOKEN(실행 목록을 읽는 토큰, 워크플로의 GITHUB_TOKEN), STATE_FILE
# 필요한 것: gh, jq, curl, GNU date. 시각은 서울 시간으로 적습니다.
#
# 테스트: scripts/tests/runner-status.bats (source하면 main은 실행되지 않습니다)

# 감시할 러너 이름. RUNNER_NAME · RUNNER_OS처럼 RUNNER_로 시작하는 이름은 Actions가 지금 작업을 돌리는
# 러너의 정보로 채우므로 쓰지 않습니다(CI에서 RUNNER_NAME="GitHub Actions N"을 찾다가 missing이 됐음).
CODEX_RUNNER="${CODEX_RUNNER:-notelink-codex}"
REVIEW_WORKFLOW="${REVIEW_WORKFLOW:-codex-review.yml}"
STUCK_MINUTES="${STUCK_MINUTES:-30}"
ERR_ALERT_AFTER="${ERR_ALERT_AFTER:-2}"  # 15분 × 2 = 30분 넘게 못 읽으면 알림(일시적인 API 오류는 넘김)
STATE_FILE="${STATE_FILE:-.runner-status/state}"

# 디스코드 embed 색
COLOR_RED=15026253     # #E5484D
COLOR_GREEN=3187820    # #30A46C
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

kst() {  # $1 = epoch → "11/01 14:42" (서울은 서머타임이 없어 +9시간)
  date -u -d "@$(( $1 + 9 * 3600 ))" '+%m/%d %H:%M'
}

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
load_state() {
  PREV_STATUS=""; PREV_SINCE=0; PREV_STUCK=0; PREV_ERR=0
  [ -f "$STATE_FILE" ] || return 0
  local k v
  while IFS='=' read -r k v; do
    case "$k" in
      status) [[ "$v" =~ ^(online|offline)$ ]] && PREV_STATUS=$v ;;
      since) [[ "$v" =~ ^[0-9]+$ ]] && PREV_SINCE=$v ;;
      stuck) [[ "$v" =~ ^[01]$ ]] && PREV_STUCK=$v ;;
      err) [[ "$v" =~ ^[0-9]+$ ]] && PREV_ERR=$v ;;
    esac
  done < "$STATE_FILE"
  return 0
}

save_state() {
  mkdir -p "$(dirname "$STATE_FILE")"
  printf 'status=%s\nsince=%s\nstuck=%s\nerr=%s\n' "$NEW_STATUS" "$NEW_SINCE" "$NEW_STUCK" "$NEW_ERR" > "$STATE_FILE"
}

state_changed() {
  [ ! -f "$STATE_FILE" ] || [ "$NEW_STATUS" != "$PREV_STATUS" ] || [ "$NEW_SINCE" != "$PREV_SINCE" ] \
    || [ "$NEW_STUCK" != "$PREV_STUCK" ] || [ "$NEW_ERR" != "$PREV_ERR" ]
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
# 최근 실행 목록에서 고르면 건너뜀 · 취소가 쌓였을 때 오래된 대기가 밀려나므로 API에서 상태로 거름
read_queue() {
  QUEUED=""; WAIT_MIN=0
  local s out n t total=0 oldest=""
  for s in queued pending; do
    out=$(gh api "repos/$REPO/actions/workflows/$REVIEW_WORKFLOW/runs?status=$s&per_page=100" \
      --jq "$QUEUE_JQ" 2> /dev/null) || return 0
    IFS=$'\t' read -r n t <<< "$out"
    [[ "$n" =~ ^[0-9]+$ ]] || return 0
    total=$(( total + n ))
    if [ -n "$t" ] && { [ -z "$oldest" ] || [[ "$t" < "$oldest" ]]; }; then oldest=$t; fi
  done
  QUEUED=$total
  if [ -n "$oldest" ]; then
    WAIT_MIN=$(( (NOW - $(date -u -d "$oldest" +%s)) / 60 ))
  fi
}

# 지난 24시간의 Codex 리뷰 결과 → DONE_OK · DONE_FAIL(시간 초과 포함) · DONE_CANCEL (읽지 못하면 빈 값)
# 한 쪽(100개)을 넘어도 맞게 세도록 결론별 total_count를 씀
read_counts() {
  DONE_OK=""; DONE_FAIL=""; DONE_CANCEL=""
  local from c n
  local -A got=()
  from=$(date -u -d "@$(( NOW - 86400 ))" '+%Y-%m-%dT%H:%M:%SZ')
  for c in success failure timed_out cancelled; do
    n=$(gh api "repos/$REPO/actions/workflows/$REVIEW_WORKFLOW/runs?status=$c&created=%3E%3D$from&per_page=1" \
      --jq '.total_count' 2> /dev/null) || return 0
    [[ "$n" =~ ^[0-9]+$ ]] || return 0
    got[$c]=$n
  done
  DONE_OK=${got[success]}
  DONE_FAIL=$(( ${got[failure]} + ${got[timed_out]} ))
  DONE_CANCEL=${got[cancelled]}
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
    NEW_STUCK=1
    [ "$PREV_STUCK" = 1 ] || [ -n "$EVENT" ] || EVENT=stuck
  else
    NEW_STUCK=0
  fi
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

# EVENT(또는 summary)에 맞는 TITLE · TEXT · COLOR를 채움
compose() {  # $1 = offline|online|stuck|error|recovered|summary
  local runners="https://github.com/$REPO/settings/actions/runners"
  local queue="https://github.com/$REPO/actions/workflows/$REVIEW_WORKFLOW"
  case "$1" in
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
        done_line="지난 24시간 Codex 리뷰: 성공 ${DONE_OK} · 실패 ${DONE_FAIL} · 취소 ${DONE_CANCEL}"
      else
        done_line="지난 24시간 Codex 리뷰: 확인하지 못함"
      fi
      TEXT="러너 \`$CODEX_RUNNER\`: $(status_word "$CUR_STATUS")$since"
      [ -n "$ERROR_MSG" ] && TEXT+="
($ERROR_MSG)"
      TEXT+="
$(queue_line)
$done_line
[Codex 리뷰 실행]($queue)" ;;
  esac
}

# 디스코드 웹후크 본문 (멘션은 막음)
payload() {
  jq -n --arg title "$TITLE" --arg text "$TEXT" --argjson color "$COLOR" \
    '{username: "NoteLink 러너", allowed_mentions: {parse: []},
      embeds: [{title: $title, description: $text, color: $color}]}'
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
  echo "러너 $CODEX_RUNNER: $CUR_STATUS (작업 중: $BUSY) ${ERROR_MSG:+— $ERROR_MSG}"
  echo "지난 상태: ${PREV_STATUS:-없음} (연속 확인 실패 $PREV_ERR번) · $(queue_line)"

  if [ "$mode" = summary ]; then
    read_counts
    compose summary
    post || { echo "::error::디스코드로 보내지 못했습니다." >&2; return 1; }
    echo "아침 요약을 보냈습니다."
    return 0
  fi

  decide
  if [ -n "$EVENT" ]; then
    compose "$EVENT"
    post || { echo "::error::디스코드로 보내지 못했습니다. 상태를 저장하지 않고 다음 실행에서 다시 보냅니다." >&2; return 1; }
    echo "알림: $EVENT"
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
