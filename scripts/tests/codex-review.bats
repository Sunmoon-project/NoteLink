#!/usr/bin/env bats
# scripts/codex-review.sh 의 판단 로직 테스트
#   실행: npx --yes bats@1.13.0 scripts/tests
# gh 호출은 함수로 바꿔치기하고, jq 필터 테스트는 jq가 있을 때만 돕니다.

setup() {
  # shellcheck source=../codex-review.sh
  source "$BATS_TEST_DIRNAME/../codex-review.sh"
  TMP="$BATS_TEST_TMPDIR"
  REPO="team/repo"
  HEAD_SHA="abc123"
}

# bats에서 `! cmd` 한 줄은 실패해도 테스트를 실패시키지 않으므로 대신 씀
not() { if "$@"; then return 1; fi; }

# ---------- parse_marker ----------

@test "parse_marker: 표시에서 sha와 회차를 꺼낸다" {
  body=$'## 치명적 문제\n없음\n\n<!-- codex-review sha=f106441ab round=2 -->'
  [ "$(parse_marker "$body")" = "f106441ab 2" ]
}

@test "parse_marker: 표시가 여러 개면 마지막 것을 쓴다" {
  body=$'<!-- codex-review sha=aaa round=1 -->\n<!-- codex-review sha=bbb round=3 -->'
  [ "$(parse_marker "$body")" = "bbb 3" ]
}

@test "parse_marker: CI 실패 안내 표시(codex-review-ci)는 리뷰로 치지 않는다" {
  [ -z "$(parse_marker '<!-- codex-review-ci sha=abc -->')" ]
}

@test "parse_marker: 표시가 없으면 빈 값" {
  [ -z "$(parse_marker '그냥 댓글')" ]
}

# ---------- ci_result · failed_jobs ----------

jobs_fixture() {
  printf '%s\t%s\t%s\t%s\n' \
    success "대상 확인" 1 u1 \
    failure "Node (mobile · api · shared)" 2 u2 \
    skipped "Python (ai)" 3 u3 \
    cancelled "취소된 job" 4 u4 \
    timed_out "느린 job" 5 u5 \
    "$1" "CI 결과" 6 u6 > "$TMP/jobs.tsv"
}

@test "ci_result: 'CI 결과' job의 결론을 돌려준다" {
  jobs_fixture success
  [ "$(ci_result "$TMP/jobs.tsv")" = "success" ]
  jobs_fixture failure
  [ "$(ci_result "$TMP/jobs.tsv")" = "failure" ]
}

@test "ci_result: 'CI 결과' job이 없으면 빈 값" {
  printf 'success\t대상 확인\t1\tu1\n' > "$TMP/jobs.tsv"
  [ -z "$(ci_result "$TMP/jobs.tsv")" ]
}

@test "failed_jobs: 실패 · 취소 · 시간 초과만 고른다" {
  jobs_fixture failure
  run failed_jobs "$TMP/jobs.tsv"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 4 ]
  [[ "$output" == *"Node (mobile · api · shared)"* ]]
  [[ "$output" == *"취소된 job"* ]]
  [[ "$output" == *"느린 job"* ]]
  [[ "$output" != *"대상 확인"* ]]
  [[ "$output" != *"Python (ai)"* ]]
}

# ---------- ci_run · ci_wait (gh 가짜) ----------
# 가짜 gh는 $TMP/runs 파일의 줄을 호출할 때마다 하나씩 돌려줍니다(마지막 줄은 계속 반복).

fake_gh_runs() {
  printf '%s\n' "$@" > "$TMP/runs"
  echo 0 > "$TMP/calls"
  gh() {
    local n
    n=$(( $(cat "$TMP/calls") + 1 ))
    echo "$n" > "$TMP/calls"
    local total
    total=$(wc -l < "$TMP/runs")
    [ "$n" -gt "$total" ] && n=$total
    sed -n "${n}p" "$TMP/runs"
  }
}

@test "ci_run: 실행이 없으면 RUN_ID와 RUN_STATUS가 빈 값" {
  fake_gh_runs ""
  ci_run
  [ -z "$RUN_ID" ]
  [ -z "$RUN_STATUS" ]
}

@test "ci_run: id와 상태를 읽는다" {
  fake_gh_runs $'42\tcompleted'
  ci_run
  [ "$RUN_ID" = "42" ]
  [ "$RUN_STATUS" = "completed" ]
}

@test "ci_wait: 이미 끝났으면 기다리지 않고 성공" {
  fake_gh_runs $'42\tcompleted'
  CI_WAIT_SECONDS=0
  ci_wait
  [ "$(cat "$TMP/calls")" -eq 1 ]
}

@test "ci_wait: 실행 중이다가 끝나면 성공" {
  fake_gh_runs $'42\tqueued' $'42\tin_progress' $'42\tcompleted'
  CI_WAIT_SECONDS=0
  CI_WAIT_TRIES=5
  run ci_wait
  [ "$status" -eq 0 ]
  [[ "$output" == *"실행 중"* ]]
  [ "$(cat "$TMP/calls")" -eq 3 ]
}

@test "ci_wait: 시간 안에 안 끝나면 실패" {
  fake_gh_runs $'42\tin_progress'
  CI_WAIT_SECONDS=0
  CI_WAIT_TRIES=2
  run ci_wait
  [ "$status" -eq 1 ]
  [ "$(cat "$TMP/calls")" -eq 3 ]
}

@test "ci_wait: CI 실행이 아예 없으면 실패" {
  fake_gh_runs ""
  CI_WAIT_SECONDS=0
  CI_WAIT_TRIES=1
  run ci_wait
  [ "$status" -eq 1 ]
}

# ---------- build_diff · omitted_note (임시 git 저장소) ----------

make_repo() {
  WT="$TMP/repo"
  git init -q -b main "$WT"
  git -C "$WT" config user.email t@t
  git -C "$WT" config user.name t
  git -C "$WT" config core.autocrlf false
  echo base > "$WT/base.txt"
  git -C "$WT" add . && git -C "$WT" commit -qm base
  git -C "$WT" checkout -qb feat
  printf 'small\n' > "$WT/a.txt"
  seq 1 50 > "$WT/big.txt"
  printf 'b\n' > "$WT/b.txt"
  echo "SECRET=1" > "$WT/.env"
  echo '{}' > "$WT/package-lock.json"
  git -C "$WT" add -f . && git -C "$WT" commit -qm feat
}

@test "build_diff: 한도 안이면 모든 파일이 들어가고 빠진 파일이 없다" {
  make_repo
  MAX_DIFF_LINES=1000
  build_diff "main...HEAD" "$TMP/pr.diff"
  grep -q "a/a.txt" "$TMP/pr.diff"
  grep -q "a/big.txt" "$TMP/pr.diff"
  grep -q "a/b.txt" "$TMP/pr.diff"
  [ ! -s "$TMP/pr.diff.omitted" ]
  [ -z "$(omitted_note "main...HEAD" "$TMP/pr.diff")" ]
}

@test "build_diff: 한도를 넘는 파일은 중간에서 자르지 않고 통째로 빼서 목록에 남긴다" {
  make_repo
  MAX_DIFF_LINES=30
  build_diff "main...HEAD" "$TMP/pr.diff"
  # big.txt(약 56줄)는 통째로 빠지고, 뒤의 작은 파일은 들어간다
  not grep -q "big.txt" "$TMP/pr.diff"
  grep -q "a/a.txt" "$TMP/pr.diff"
  grep -q "a/b.txt" "$TMP/pr.diff"
  [ "$(cut -f 1 "$TMP/pr.diff.omitted")" = "big.txt" ]
  run omitted_note "main...HEAD" "$TMP/pr.diff"
  [[ "$output" == *"빠진 파일"* ]]
  [[ "$output" == *"git diff main...HEAD -- 'big.txt'"* ]]
}

@test "build_diff: .env와 package-lock.json은 리뷰 입력에서 뺀다" {
  make_repo
  MAX_DIFF_LINES=1000
  build_diff "main...HEAD" "$TMP/pr.diff"
  not grep -q "SECRET" "$TMP/pr.diff"
  not grep -q "package-lock.json" "$TMP/pr.diff"
  not grep -q -e ".env" -e "package-lock" "$TMP/pr.diff.omitted"
}

# ---------- strip_prefix ----------

@test "strip_prefix: 역슬래시가 든 Windows 임시 경로를 지운다" {
  out=$(printf '%s\n' 'P1 — C:\Users\a\Temp\tmp.X\pr-2\scripts\x.sh:3' | strip_prefix 'C:\Users\a\Temp\tmp.X\pr-2\')
  [ "$out" = 'P1 — scripts\x.sh:3' ]
}

@test "strip_prefix: 접두어가 비어 있으면 그대로 둔다" {
  [ "$(echo 'a/b' | strip_prefix '')" = "a/b" ]
}

# ---------- gh --jq 필터 (jq로 같은 필터 검증) ----------

need_jq() { command -v jq >/dev/null || skip "jq 없음"; }

@test "RUNS_JQ: CI 워크플로 중 가장 최근 실행을 고르고 다른 워크플로는 무시한다" {
  need_jq
  json='{"workflow_runs":[
    {"id":1,"name":"CI","status":"completed","created_at":"2026-10-26T01:00:00Z"},
    {"id":2,"name":"CI","status":"in_progress","created_at":"2026-10-26T03:00:00Z"},
    {"id":3,"name":"Deploy","status":"queued","created_at":"2026-10-26T04:00:00Z"}]}'
  [ "$(jq -r "$RUNS_JQ" <<< "$json")" = $'2\tin_progress' ]
}

@test "RUNS_JQ: 실행이 없으면 아무것도 출력하지 않는다" {
  need_jq
  [ -z "$(jq -r "$RUNS_JQ" <<< '{"workflow_runs":[]}')" ]
}

@test "JOBS_JQ: 결론이 아직 없는 job은 none으로 표시한다" {
  need_jq
  json='{"jobs":[{"conclusion":null,"name":"CI 결과","id":7,"html_url":"u"}]}'
  [ "$(jq -r "$JOBS_JQ" <<< "$json")" = $'none\tCI 결과\t7\tu' ]
}

@test "prev_review_jq: 내 Codex 리뷰 댓글만 고른다" {
  need_jq
  json='[
    {"id":1,"created_at":"t1","user":{"login":"me"},"body":"<!-- codex-review sha=a round=1 -->"},
    {"id":2,"created_at":"t2","user":{"login":"other"},"body":"<!-- codex-review sha=b round=1 -->"},
    {"id":3,"created_at":"t3","user":{"login":"me"},"body":"<!-- codex-review-ci sha=c -->"},
    {"id":4,"created_at":"t4","user":{"login":"me"},"body":"일반 댓글"}]'
  [ "$(jq -r "$(prev_review_jq me)" <<< "$json")" = $'t1\t1' ]
}

# ---------- Codex 사용량 기록 · 멈춤 ----------

# 가짜 사용량 스크립트: 받은 인자를 적고, FAKE_OUT을 출력하고 FAKE_RC로 끝남
fake_usage_script() {
  USAGE_SCRIPT="$TMP/fake-usage.cjs"
  printf '%s\n' \
    "const fs = require('node:fs');" \
    "fs.writeFileSync(process.env.ARGS_FILE, process.argv.slice(2).join(' '));" \
    "process.stdout.write(process.env.FAKE_OUT || '');" \
    "process.exit(Number(process.env.FAKE_RC || 0));" > "$USAGE_SCRIPT"
  export ARGS_FILE="$TMP/args"
  CODEX_USAGE_STATE="$TMP/state-usage"
}

need_node() { command -v node > /dev/null || skip "node 없음"; }

@test "record_usage: 시작 시각 · 로그 · 실패 여부를 넘기고, 이 컴퓨터의 기록과 결과 파일에 적는다" {
  need_node; fake_usage_script
  CODEX_USAGE_FILE="$TMP/usage.txt" FAKE_OUT=$'at=1\nlimit=0' run record_usage 1793590000000 "$TMP/codex.log" 1
  [ "$status" -eq 0 ]
  [ "$(cat "$TMP/usage.txt")" = $'at=1\nlimit=0' ]
  [ "$(cat "$CODEX_USAGE_STATE")" = $'at=1\nlimit=0' ]
  [[ "$(cat "$ARGS_FILE")" == "--since 1793590000000 --log "*"codex.log --failed 1" ]]
}

@test "record_usage: CODEX_USAGE_FILE이 없으면 이 컴퓨터의 기록에만 적고, 실패 여부는 기본 0" {
  need_node; fake_usage_script
  unset CODEX_USAGE_FILE
  FAKE_OUT="at=1" run record_usage 1 "$TMP/codex.log"
  [ "$status" -eq 0 ]
  [ "$(cat "$CODEX_USAGE_STATE")" = "at=1" ]
  [[ "$(cat "$ARGS_FILE")" == *"--failed 0" ]]
}

@test "record_usage: 읽을 것이 없거나 스크립트가 실패하면 지난 기록을 지우지 않고 성공한다" {
  need_node; fake_usage_script
  echo "at=5" > "$CODEX_USAGE_STATE"
  CODEX_USAGE_FILE="$TMP/usage.txt" run record_usage 1 "$TMP/codex.log" 0
  [ "$status" -eq 0 ] && [ ! -e "$TMP/usage.txt" ]
  CODEX_USAGE_FILE="$TMP/usage.txt" FAKE_OUT="at=1" FAKE_RC=1 run record_usage 1 "$TMP/codex.log" 0
  [ "$status" -eq 0 ] && [ ! -e "$TMP/usage.txt" ]
  [ "$(cat "$CODEX_USAGE_STATE")" = "at=5" ]
}

@test "record_usage: node가 없으면 건너뛰고 성공한다" {
  USAGE_SCRIPT="$TMP/x.mjs"; CODEX_USAGE_STATE="$TMP/state-usage"
  PATH="$TMP/empty-path" CODEX_USAGE_FILE="$TMP/usage.txt" run record_usage 1 "$TMP/codex.log" 0
  [ "$status" -eq 0 ] && [ ! -e "$TMP/usage.txt" ] && [ ! -e "$CODEX_USAGE_STATE" ]
  [[ "$output" == *"node가 없어"* ]]
}

# 지금 시각 기준으로 사용량 기록을 만듦: 나머지 인자 = key=value
usage_state() {
  CODEX_USAGE_STATE="$TMP/state-usage"
  printf '%s\n' "at=$(( $(date +%s) - 600 ))" "$@" > "$CODEX_USAGE_STATE"
}

@test "usage_paused: 기록이 없거나 남은 양이 10%보다 많으면 리뷰를 한다" {
  CODEX_USAGE_STATE="$TMP/없음"
  not usage_paused
  later=$(( $(date +%s) + 3600 ))
  usage_state p_used=85 p_window=300 "p_reset=$later"   # 15% 남음 → 경고만
  not usage_paused
  [ "$CUR_USAGE" = warn ]
}

@test "usage_paused: 남은 양 10% 이하면 멈추고, 다시 돌릴 시각은 그 창의 초기화 시각" {
  later=$(( $(date +%s) + 3600 ))
  usage_state p_used=90 p_window=300 "p_reset=$later" s_used=40 s_window=10080 "s_reset=$(( later + 86400 ))"
  usage_paused
  [ "$USAGE_REASON" = low ] && [ "$USAGE_LEFT" = 10 ] && [ "$USAGE_RETRY" = "$later" ]
}

@test "usage_paused: 한도 문구가 있으면 다시 가능한 시각까지 멈추고, 지나면 다시 리뷰한다" {
  usage_state limit=1 "retry=$(( $(date +%s) + 600 ))"
  usage_paused
  [ "$USAGE_REASON" = limit ]
  usage_state limit=1 "retry=$(( $(date +%s) - 60 ))"
  not usage_paused
}

@test "usage_paused: 초기화 시각이 지난 창은 다 남은 것으로 보고 리뷰한다" {
  usage_state p_used=100 p_window=300 "p_reset=$(( $(date +%s) - 60 ))"
  not usage_paused
  [ "$CUR_USAGE" = ok ]
}

@test "pause_review: PR 댓글 없이 실행 화면에 경고 · 요약을 남기고, 멈춘 PR을 적은 뒤 성공으로 끝낸다" {
  PR=12; HEAD_SHA=abc123; USAGE_REASON=low; USAGE_LEFT=8; USAGE_RETRY=1761904800  # 10/31 19:00 서울
  gh() { echo "gh $*" >> "$TMP/gh.calls"; }
  GITHUB_STEP_SUMMARY="$TMP/summary.md" CODEX_PAUSED_FILE="$TMP/paused.txt" run pause_review
  [ "$status" -eq 0 ]
  [[ "$output" == "::warning title=Codex 리뷰 멈춤::⏸️ PR #12: Codex 남은 사용량이 10% 이하(8% 남음) — 리뷰를 멈췄습니다. 10/31 19:00(서울) 사용량이 초기화되면 이 실행을 자동으로 다시 돌립니다." ]]
  [[ "$(cat "$TMP/summary.md")" == "### ⏸️ Codex 리뷰 멈춤"*"10/31 19:00(서울)"* ]]
  [ "$(cat "$TMP/paused.txt")" = $'pr=12\nsha=abc123\nretry=1761904800\nreason=low' ]
  [ ! -e "$TMP/gh.calls" ]  # 댓글을 남기지 않음
}

@test "pause_review: 한도 도달 · Actions 밖(직접 실행)이면 직접 다시 실행하라고 적고 파일은 만들지 않는다" {
  PR=12; HEAD_SHA=abc123; USAGE_REASON=limit; USAGE_LEFT=0; USAGE_RETRY=1761904800
  unset CODEX_PAUSED_FILE GITHUB_STEP_SUMMARY
  run pause_review
  [ "$status" -eq 0 ]
  [[ "$output" == *"Codex 사용량 한도에 걸림 — 리뷰를 멈췄습니다."*"초기화된 뒤 다시 실행하세요." ]]
}

@test "main: Codex 실행 바로 뒤(성공 여부를 보기 전)에 사용량을 기록한다" {
  # 한도에 걸려 리뷰가 실패해도 기록되어야 하므로, 결과 확인보다 앞에 있어야 함
  local f="$BATS_TEST_DIRNAME/../codex-review.sh"
  exec_line=$(grep -n 'codex exec ' "$f" | head -n 1 | cut -d: -f1)
  record_line=$(grep -n '^  record_usage ' "$f" | cut -d: -f1)
  check_line=$(grep -n 'if \[ ! -s "\$REVIEW" \]' "$f" | cut -d: -f1)
  [ -n "$exec_line" ] && [ -n "$record_line" ] && [ -n "$check_line" ]
  [ "$record_line" -eq $(( exec_line + 1 )) ] && [ "$record_line" -lt "$check_line" ]
}

@test "main: 사용량 확인은 CI 통과 뒤 · Codex 실행 전이고, 한도로 실패해도 멈춤으로 끝낸다" {
  local f="$BATS_TEST_DIRNAME/../codex-review.sh"
  ci_line=$(grep -n 'echo "▶ CI 통과 ✅"' "$f" | cut -d: -f1)
  gate_line=$(grep -n '^  if usage_paused; then pause_review; fi' "$f" | cut -d: -f1)
  exec_line=$(grep -n 'codex exec ' "$f" | head -n 1 | cut -d: -f1)
  fail_line=$(grep -n 'if usage_paused && \[ "\$USAGE_REASON" = limit \]; then pause_review; fi' "$f" | cut -d: -f1)
  [ -n "$ci_line" ] && [ -n "$gate_line" ] && [ -n "$fail_line" ]
  [ "$ci_line" -lt "$gate_line" ] && [ "$gate_line" -lt "$exec_line" ] && [ "$exec_line" -lt "$fail_line" ]
}
