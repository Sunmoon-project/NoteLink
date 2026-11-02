#!/usr/bin/env bats
# scripts/codex-usage.mjs (Codex 세션 기록 · 로그에서 남은 사용량 뽑기) 테스트
#   실행: npx --yes bats@1.13.0 scripts/tests
# 가짜 CODEX_HOME에 세션 기록을 만들고, 리뷰 컴퓨터처럼 서울 시간(TZ)으로 돌립니다.

setup() {
  command -v node > /dev/null || skip "node 없음"
  SCRIPT="$BATS_TEST_DIRNAME/../codex-usage.mjs"
  export CODEX_HOME="$BATS_TEST_TMPDIR/codex"
  export TZ=Asia/Seoul
  NOW_MS=1793590000000  # 2026-11-02 03:26:40 UTC = 12:26:40 서울
  DAY="$CODEX_HOME/sessions/2026/11/02"
  mkdir -p "$DAY"
}

# $1 = 파일 이름, 나머지 = 줄. 수정 시각은 NOW 무렵
rollout() {
  local f="$DAY/$1"; shift
  printf '%s\n' "$@" > "$f"
  touch -d @$(( NOW_MS / 1000 )) "$f"
}

token_count() {  # $1 = rate_limits JSON
  printf '{"timestamp":"2026-11-02T03:26:00Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"total_tokens":1}},"rate_limits":%s}}' "$1"
}

WEEKLY='{"limit_id":"codex","primary":{"used_percent":34.0,"window_minutes":10080,"resets_at":1793775042},"secondary":null,"credits":{"has_credits":true,"unlimited":false,"balance":"12.5"},"plan_type":"prolite","rate_limit_reached_type":null}'

run_usage() {  # 나머지 인자는 그대로 넘김
  run node "$SCRIPT" --now "$NOW_MS" "$@"
}

value() {  # $1 = 키 → 출력에서 그 값
  sed -n "s/^$1=//p" <<< "$output"
}

@test "세션 기록의 마지막 rate_limits를 창별로 적는다(크레딧 · 계정은 적지 않음)" {
  rollout rollout-a.jsonl \
    "$(token_count '{"primary":{"used_percent":10,"window_minutes":10080,"resets_at":1}}')" \
    '{"type":"event_msg","payload":{"type":"agent_message"}}' \
    "$(token_count "$WEEKLY")"
  run_usage --since $(( NOW_MS - 60000 ))
  [ "$status" -eq 0 ]
  [ "$output" = "at=1793590000
plan=prolite
limit=0
retry=
p_used=34
p_window=10080
p_reset=1793775042
s_used=
s_window=
s_reset=" ]
  [[ "$output" != *"12.5"* ]] && [[ "$output" != *credit* ]]
}

@test "5시간 · 주간 두 창을 모두 적고, 사용률은 반올림한다" {
  rollout rollout-a.jsonl "$(token_count '{"primary":{"used_percent":12.6,"window_minutes":300,"resets_at":1793600000},"secondary":{"used_percent":85.4,"window_minutes":10080,"resets_at":1793775042},"plan_type":"plus"}')"
  run_usage --since $(( NOW_MS - 60000 ))
  [ "$(value p_used)" = 13 ] && [ "$(value p_window)" = 300 ] && [ "$(value p_reset)" = 1793600000 ]
  [ "$(value s_used)" = 85 ] && [ "$(value s_window)" = 10080 ] && [ "$(value s_reset)" = 1793775042 ]
  [ "$(value plan)" = plus ]
}

@test "옛 버전의 resets_in_seconds는 지금부터의 시각으로 바꾼다" {
  rollout rollout-a.jsonl "$(token_count '{"primary":{"used_percent":50,"window_minutes":300,"resets_in_seconds":600}}')"
  run_usage --since $(( NOW_MS - 60000 ))
  [ "$(value p_reset)" = $(( NOW_MS / 1000 + 600 )) ]
}

@test "시작 전에 끝난 세션 기록은 보지 않고, 그 뒤에 바뀐 것 중 가장 최근 것을 쓴다" {
  rollout rollout-old.jsonl "$(token_count '{"primary":{"used_percent":99,"window_minutes":300,"resets_at":1}}')"
  touch -d @$(( NOW_MS / 1000 - 7200 )) "$DAY/rollout-old.jsonl"
  rollout rollout-mid.jsonl "$(token_count '{"primary":{"used_percent":20,"window_minutes":300,"resets_at":1}}')"
  touch -d @$(( NOW_MS / 1000 - 30 )) "$DAY/rollout-mid.jsonl"
  rollout rollout-new.jsonl "$(token_count "$WEEKLY")"
  run_usage --since $(( NOW_MS - 600000 ))
  [ "$(value p_used)" = 34 ]
  # 시작 이후 기록이 없으면 출력하지 않음
  run_usage --since $(( NOW_MS + 600000 ))
  [ "$status" -eq 0 ] && [ -z "$output" ]
}

@test "자정을 넘긴 리뷰도 어제 날짜 폴더의 기록을 찾는다" {
  mkdir -p "$CODEX_HOME/sessions/2026/11/01"
  DAY="$CODEX_HOME/sessions/2026/11/01" rollout rollout-a.jsonl "$(token_count "$WEEKLY")"
  rmdir "$CODEX_HOME/sessions/2026/11/02"
  run_usage --since $(( NOW_MS - 60000 ))
  [ "$(value p_used)" = 34 ]
}

@test "깨진 줄 · rate_limits가 null인 줄은 건너뛴다" {
  rollout rollout-a.jsonl "$(token_count "$WEEKLY")" "$(token_count null)" '{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"prim'
  run_usage --since $(( NOW_MS - 60000 ))
  [ "$(value p_used)" = 34 ]
}

@test "이상한 플랜 이름은 적지 않는다" {
  rollout rollout-a.jsonl "$(token_count '{"primary":{"used_percent":1,"window_minutes":300,"resets_at":1},"plan_type":"pro\nevil=1"}')"
  run_usage --since $(( NOW_MS - 60000 ))
  [ -z "$(value plan)" ]
  [ -z "$(value evil)" ]
}

@test "한도 문구 'try again at 3:01 PM' → 오늘 15:01(서울)에 다시 가능" {
  printf 'ERROR: You\xe2\x80\x99ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 3:01 PM.\n' > "$BATS_TEST_TMPDIR/codex.log"
  run_usage --since $(( NOW_MS - 60000 )) --log "$BATS_TEST_TMPDIR/codex.log" --failed 1
  [ "$status" -eq 0 ]
  [ "$(value limit)" = 1 ]
  [ "$(value retry)" = 1793599260 ]  # 2026-11-02 06:01 UTC
  [ -z "$(value p_used)" ]           # 세션 기록이 없어도 한도는 적음
}

@test "한도 문구의 시각이 이미 지났으면 다음 날, 날짜가 있으면 그 날짜" {
  echo "ERROR: You've hit your usage limit. try again at 9:05 AM." > "$BATS_TEST_TMPDIR/codex.log"
  run_usage --since 0 --log "$BATS_TEST_TMPDIR/codex.log" --failed 1
  [ "$(value retry)" = 1793664300 ]  # 11/03 09:05 서울 = 11/03 00:05 UTC
  echo "ERROR: You've hit your usage limit. ... or try again at Nov 5th, 2026 12:00 AM." > "$BATS_TEST_TMPDIR/codex.log"
  run_usage --since 0 --log "$BATS_TEST_TMPDIR/codex.log" --failed 1
  [ "$(value retry)" = 1793804400 ]  # 11/05 00:00 서울 = 11/04 15:00 UTC
}

@test "한도 문구에 시각이 없으면 다 쓴(100%) 창의 초기화 시각을 쓴다" {
  rollout rollout-a.jsonl "$(token_count '{"primary":{"used_percent":100,"window_minutes":300,"resets_at":1793600000},"secondary":{"used_percent":40,"window_minutes":10080,"resets_at":1793775042},"rate_limit_reached_type":"primary"}')"
  echo "ERROR: You've hit your usage limit." > "$BATS_TEST_TMPDIR/codex.log"
  run_usage --since $(( NOW_MS - 60000 )) --log "$BATS_TEST_TMPDIR/codex.log" --failed 1
  [ "$(value limit)" = 1 ] && [ "$(value retry)" = 1793600000 ]
}

@test "세션 기록이 한도 도달을 알리면 로그가 없어도 limit=1" {
  rollout rollout-a.jsonl "$(token_count '{"primary":{"used_percent":100,"window_minutes":300,"resets_at":1793600000},"rate_limit_reached_type":"primary"}')"
  run_usage --since $(( NOW_MS - 60000 ))
  [ "$(value limit)" = 1 ] && [ "$(value retry)" = 1793600000 ]
}

@test "기록 · 로그가 모두 없거나 CODEX_HOME이 없어도 조용히 0으로 끝난다" {
  run_usage --since 0 --log "$BATS_TEST_TMPDIR/없는.log" --failed 1
  [ "$status" -eq 0 ] && [ -z "$output" ]
  CODEX_HOME="$BATS_TEST_TMPDIR/없음" run_usage --since 0
  [ "$status" -eq 0 ] && [ -z "$output" ]
}

@test "리뷰가 성공했으면(--failed 없음) 로그의 한도 문구를 보지 않는다" {
  echo "ERROR: You've hit your usage limit. try again at 3:01 PM." > "$BATS_TEST_TMPDIR/codex.log"
  rollout rollout-a.jsonl "$(token_count "$WEEKLY")"
  run_usage --since $(( NOW_MS - 60000 )) --log "$BATS_TEST_TMPDIR/codex.log"
  [ "$(value limit)" = 0 ] && [ -z "$(value retry)" ] && [ "$(value p_used)" = 34 ]
  run_usage --since $(( NOW_MS - 60000 )) --log "$BATS_TEST_TMPDIR/codex.log" --failed 0
  [ "$(value limit)" = 0 ]
}

@test "로그에 찍힌 프롬프트(PR 디프)의 한도 문구는 줄 맨 앞이 ERROR:가 아니라 한도로 보지 않는다" {
  # 이 기능의 테스트 디프처럼, 리뷰한 PR에 같은 문구가 있는 경우 (codex 로그에는 프롬프트도 찍힘)
  printf '%s
' 'user' '## PR 전체 변경 디프 (base...HEAD)'     "+  echo \"ERROR: You've hit your usage limit. try again at Nov 5th, 2026 12:00 AM.\" > x.log"     " ERROR: You've hit your usage limit. try again at 9:05 AM."     'codex' 'ERROR: stream disconnected before completion' > "$BATS_TEST_TMPDIR/codex.log"
  run_usage --since 0 --log "$BATS_TEST_TMPDIR/codex.log" --failed 1
  [ "$status" -eq 0 ] && [ -z "$output" ]
}

@test "Windows 줄바꿈(CRLF) 로그의 한도 문구도 읽는다" {
  printf 'x
ERROR: Youâve hit your usage limit. try again at 3:01 PM.
' > "$BATS_TEST_TMPDIR/codex.log"
  run_usage --since 0 --log "$BATS_TEST_TMPDIR/codex.log" --failed 1
  [ "$(value limit)" = 1 ] && [ "$(value retry)" = 1793599260 ]
}
