#!/usr/bin/env bats
# scripts/codex-usage-live.mjs (Codex 지금 사용량 → 디스코드 메시지 하나 고치기) 테스트
#   실행: npx --yes bats@1.13.0 scripts/tests
# 가짜 codex app-server(CODEX_BIN)와 가짜 디스코드 웹후크 서버(로컬 http)로 돌립니다.

setup() {
  command -v node > /dev/null || skip "node 없음"
  SCRIPT="$BATS_TEST_DIRNAME/../codex-usage-live.mjs"
  WORKFLOW="$BATS_TEST_DIRNAME/../../.github/workflows/codex-usage-live.yml"
  NOW_MS=1793750400000  # 2026-11-04 00:00:00 UTC = 09:00 서울
  NOW=$(( NOW_MS / 1000 ))
  export CODEX_USAGE_LIVE_STATE="$BATS_TEST_TMPDIR/state/live.json"
  # CODEX_BIN은 셸(Windows는 cmd)로 실행되므로 Git Bash에서는 Windows 경로로 바꿔 넘김
  export CODEX_BIN="node $(cygpath -m "$BATS_TEST_TMPDIR" 2> /dev/null || echo "$BATS_TEST_TMPDIR")/fake-codex.mjs"
  export CODEX_READ_TIMEOUT_MS=5000
  unset DISCORD_WEBHOOK FAKE_MODE

  # 가짜 app-server: initialize → initialized → account/rateLimits/read에 FAKE_RL을 돌려줌
  #   FAKE_MODE=error(오류 응답) · exit(바로 끝남) · hang(응답 안 함)
  cat > "$BATS_TEST_TMPDIR/fake-codex.mjs" <<'EOF'
import readline from 'node:readline';
const mode = process.env.FAKE_MODE || '';
if (mode === 'exit') process.exit(3);
// hang: stdin이 닫혀도 끝나지 않는 app-server
if (mode === 'hang') setInterval(() => {}, 1000);
const rl = readline.createInterface({ input: process.stdin });
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (mode === 'hang') return;
  if (m.id === 1) out({ id: 1, result: { userAgent: 'fake' } });
  else if (m.id === 2) {
    if (mode === 'error') out({ id: 2, error: { code: -32000, message: 'not logged in' } });
    else out({ id: 2, result: { rateLimits: JSON.parse(process.env.FAKE_RL) } });
  }
});
EOF

  # 가짜 디스코드: 요청을 "METHOD 경로?쿼리 본문" 한 줄씩 남기고, POST는 {"id":"msg-<n>"}을 돌려줌
  #   PATCH_STATUS · POST_STATUS로 응답 코드를 바꿈
  cat > "$BATS_TEST_TMPDIR/fake-discord.mjs" <<'EOF'
import http from 'node:http';
import fs from 'node:fs';
const [log, portFile] = process.argv.slice(2);
let n = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    fs.appendFileSync(log, `${req.method} ${req.url} ${body}\n`);
    const status = Number((req.method === 'PATCH' ? process.env.PATCH_STATUS : process.env.POST_STATUS) || 200);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(req.method === 'POST' && status === 200 ? JSON.stringify({ id: `msg-${++n}` }) : '{}');
  });
}).listen(0, '127.0.0.1', function () { fs.writeFileSync(portFile, String(this.address().port)); });
EOF
  REQ_LOG="$BATS_TEST_TMPDIR/requests.log"
  : > "$REQ_LOG"
}

teardown() {
  [ -n "${DISCORD_PID:-}" ] && kill "$DISCORD_PID" 2> /dev/null || true
}

start_discord() {  # 환경 변수(PATCH_STATUS 등)는 부르기 전에 export
  local port_file="$BATS_TEST_TMPDIR/port"
  rm -f "$port_file"
  node "$BATS_TEST_TMPDIR/fake-discord.mjs" "$REQ_LOG" "$port_file" 3>&- &
  DISCORD_PID=$!
  for _ in $(seq 50); do [ -s "$port_file" ] && break; sleep 0.1; done
  export DISCORD_WEBHOOK="http://127.0.0.1:$(cat "$port_file")/api/webhooks/1/token"
}

# 5시간 · 주간 창 (used = 사용률, 초기화는 NOW 기준 초)
rl() {  # $1 = 5시간 사용률, $2 = 주간 사용률, $3 = rateLimitReachedType(JSON, 기본 null)
  printf '{"limitId":"codex","primary":{"usedPercent":%s,"windowDurationMins":300,"resetsAt":%s},"secondary":{"usedPercent":%s,"windowDurationMins":10080,"resetsAt":%s},"credits":{"hasCredits":true,"unlimited":false,"balance":"12.5"},"planType":"plus","rateLimitReachedType":%s}' \
    "$1" $(( NOW + 3 * 3600 )) "$2" $(( NOW + 4 * 86400 )) "${3:-null}"
}

dry() {
  run node "$SCRIPT" --now "$NOW_MS" --dry-run
}

@test "5시간 · 주간 남은 양 · 막대 · 초기화 시각(서울) · 플랜을 적는다(크레딧은 적지 않음)" {
  export FAKE_RL="$(rl 5 90)"
  dry
  [ "$status" -eq 0 ]
  [[ "$output" == *"Codex 사용량: 5시간 95% 남음 · 주간 10% 남음 · 플랜 plus"* ]]
  [[ "$output" == *'🟢 **5시간** 95% 남음 `██████████` · 11/04 12:00 초기화'* ]]
  [[ "$output" == *'⏸️ **주간** 10% 남음 `█░░░░░░░░░` · 11/08 09:00 초기화'* ]]
  [[ "$output" == *"⏸️ 남은 양이 10% 이하입니다(리뷰 멈춤 기준)"* ]]
  [[ "$output" == *"플랜 plus · 11/04 09:00 확인"* ]]
  [[ "$output" == *'"color":15761187'* ]]
  [[ "$output" != *"12.5"* ]]
  [[ "$output" != *"credits"* ]]
}

@test "기준은 codex-usage-lib.sh와 같다: 20% 남음은 🟢, 19%는 🟡, 11%는 🟡, 10%는 ⏸️" {
  export FAKE_RL="$(rl 80 81)"
  dry
  [[ "$output" == *"🟢 **5시간** 20% 남음"* ]]
  [[ "$output" == *"🟡 **주간** 19% 남음"* ]]
  [[ "$output" == *"남은 양이 20% 미만입니다"* ]]
  [[ "$output" == *'"color":16098596'* ]]
  export FAKE_RL="$(rl 89 90)"
  dry
  [[ "$output" == *"🟡 **5시간** 11% 남음"* ]]
  [[ "$output" == *"⏸️ **주간** 10% 남음"* ]]
}

@test "모두 넉넉하면 초록이고 안내 줄이 없다" {
  export FAKE_RL="$(rl 0 30)"
  dry
  [[ "$output" == *"🟢 **5시간** 100% 남음 \`██████████\`"* ]]
  [[ "$output" == *"🟢 **주간** 70% 남음"* ]]
  [[ "$output" != *"미만입니다"* ]]
  [[ "$output" != *"멈춤 기준"* ]]
  [[ "$output" == *'"color":3187820'* ]]
}

@test "한도에 걸려 있으면 ⏸️ 한도 안내를 적는다" {
  export FAKE_RL="$(rl 100 40 '"rate_limit_reached"')"
  dry
  [[ "$output" == *"⏸️ **5시간** 0% 남음 \`░░░░░░░░░░\`"* ]]
  [[ "$output" == *"사용량 한도에 걸려 있습니다(리뷰 멈춤 기준)"* ]]
  [[ "$output" == *'"color":15761187'* ]]
}

@test "창이 하나뿐이어도(주간만) 그 창만 적는다" {
  export FAKE_RL='{"primary":{"usedPercent":34,"windowDurationMins":10080,"resetsAt":1794000000},"secondary":null,"planType":"prolite","rateLimitReachedType":null}'
  dry
  [[ "$output" == *"Codex 사용량: 주간 66% 남음 · 플랜 prolite"* ]]
  [[ "$output" != *"5시간"* ]]
}

@test "처음에는 새 메시지를 올리고(?wait=true) id만 상태 파일에 둔다" {
  export FAKE_RL="$(rl 5 90)"
  start_discord
  run node "$SCRIPT" --now "$NOW_MS"
  [ "$status" -eq 0 ]
  [[ "$output" == *"디스코드에 새 메시지를 올렸습니다"* ]]
  [ "$(wc -l < "$REQ_LOG")" -eq 1 ]
  grep -q '^POST /api/webhooks/1/token?wait=true {"embeds":' "$REQ_LOG"
  [[ "$(cat "$REQ_LOG")" == *'"title":"📊 Codex 남은 사용량 (리뷰 컴퓨터)"'* ]]
  grep -q '"allowed_mentions":{"parse":\[\]}' "$REQ_LOG"
  grep -q '"messageId":"msg-1"' "$CODEX_USAGE_LIVE_STATE"
  ! grep -qE 'credits|12\.5|balance' "$CODEX_USAGE_LIVE_STATE"
}

@test "다음부터는 같은 메시지를 고친다(새 메시지를 올리지 않음)" {
  export FAKE_RL="$(rl 5 90)"
  start_discord
  node "$SCRIPT" --now "$NOW_MS"
  export FAKE_RL="$(rl 6 91)"
  run node "$SCRIPT" --now $(( NOW_MS + 600000 ))
  [ "$status" -eq 0 ]
  [[ "$output" == *"디스코드 메시지를 고쳤습니다"* ]]
  [ "$(grep -c '^POST' "$REQ_LOG")" -eq 1 ]
  grep -q '^PATCH /api/webhooks/1/token/messages/msg-1 .*94% 남음' "$REQ_LOG"
  grep -q '"messageId":"msg-1"' "$CODEX_USAGE_LIVE_STATE"
}

@test "메시지가 지워졌으면(404) 새로 올리고 새 id를 둔다" {
  mkdir -p "$(dirname "$CODEX_USAGE_LIVE_STATE")"
  echo '{"messageId":"gone"}' > "$CODEX_USAGE_LIVE_STATE"
  export FAKE_RL="$(rl 5 90)" PATCH_STATUS=404
  start_discord
  run node "$SCRIPT" --now "$NOW_MS"
  [ "$status" -eq 0 ]
  grep -q '^PATCH /api/webhooks/1/token/messages/gone ' "$REQ_LOG"
  grep -q '^POST /api/webhooks/1/token?wait=true ' "$REQ_LOG"
  grep -q '"messageId":"msg-1"' "$CODEX_USAGE_LIVE_STATE"
}

@test "고치기가 다른 오류(500)면 새 메시지를 만들지 않고 실패(1)로 끝나며 상태를 바꾸지 않는다" {
  mkdir -p "$(dirname "$CODEX_USAGE_LIVE_STATE")"
  echo '{"messageId":"keep"}' > "$CODEX_USAGE_LIVE_STATE"
  export FAKE_RL="$(rl 5 90)" PATCH_STATUS=500
  start_discord
  run node "$SCRIPT" --now "$NOW_MS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"메시지 고치기 실패(HTTP 500)"* ]]
  ! grep -q '^POST' "$REQ_LOG"
  [ "$(cat "$CODEX_USAGE_LIVE_STATE")" = '{"messageId":"keep"}' ]
}

@test "새로 올리기가 실패하면 1로 끝난다" {
  export FAKE_RL="$(rl 5 90)" POST_STATUS=403
  start_discord
  run node "$SCRIPT" --now "$NOW_MS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"메시지 올리기 실패(HTTP 403)"* ]]
  [ ! -e "$CODEX_USAGE_LIVE_STATE" ]
}

@test "읽지 못하면 마지막 값을 두고 ⚠️ 확인 실패를 적는다(0으로 끝남, 마지막 값은 그대로)" {
  export FAKE_RL="$(rl 5 30)"
  start_discord
  node "$SCRIPT" --now "$NOW_MS"
  before=$(cat "$CODEX_USAGE_LIVE_STATE")
  export FAKE_MODE=error
  run node "$SCRIPT" --now $(( NOW_MS + 600000 ))
  [ "$status" -eq 0 ]
  [[ "$output" == *"::warning::Codex 사용량을 읽지 못했습니다: 사용량 읽기 실패(코드 -32000)"* ]]
  # 오류 원문(계정 정보가 섞일 수 있음)은 로그 · 메시지에 넣지 않음
  [[ "$output" != *"not logged in"* ]]
  last=$(tail -n 1 "$REQ_LOG")
  [[ "$last" == PATCH* ]]
  [[ "$last" == *"⚠️ 11/04 09:10 확인 실패"* ]]
  [[ "$last" == *"아래는 11/04 09:00에 읽은 값입니다"* ]]
  [[ "$last" == *"95% 남음"* ]]
  [[ "$last" != *"not logged in"* ]]
  # 꼬리말은 지금 시각이 아니라 마지막으로 읽은 시각
  [[ "$last" == *"11/04 09:00에 마지막으로 읽음"* ]]
  [[ "$last" != *"09:10 확인 ("* ]]
  # 마지막 값이 🟢였으면 회색으로 확인 실패를 알림(🟡 · ⏸️였으면 그 색을 유지 — 아래 테스트)
  [[ "$last" == *'"color":9145752'* ]]
  [ "$(cat "$CODEX_USAGE_LIVE_STATE")" = "$before" ]
}

@test "마지막 값의 초기화 시각이 지났으면 그 창은 100% 남음 · 초기화됨으로 적는다" {
  export FAKE_RL="$(rl 5 90)"
  start_discord
  node "$SCRIPT" --now "$NOW_MS"
  export FAKE_MODE=exit
  run node "$SCRIPT" --now $(( NOW_MS + 4 * 3600 * 1000 ))
  [ "$status" -eq 0 ]
  last=$(tail -n 1 "$REQ_LOG")
  [[ "$last" == *"codex app-server가 끝남(코드 3)"* ]]
  [[ "$last" == *"🟢 **5시간** 100% 남음 \`██████████\` · 11/04 12:00 초기화됨"* ]]
  [[ "$last" == *"⏸️ **주간** 10% 남음"* ]]
  # 읽지 못했어도 마지막 값이 ⏸️면 회색이 아니라 멈춤 색을 유지
  [[ "$last" == *'"color":15761187'* ]]
}

@test "읽은 적도 없고 읽지도 못하면 그렇게 적는다" {
  export FAKE_MODE=error
  dry
  [ "$status" -eq 0 ]
  [[ "$output" == *"아직 읽은 값이 없습니다"* ]]
  [[ "$output" == *"읽은 값 없음 ("* ]]
  [[ "$output" == *'"color":9145752'* ]]
}

@test "app-server가 응답하지 않고 끝나지도 않으면 시간 초과로 보고 기다리지 않고 끝낸다" {
  export FAKE_MODE=hang CODEX_READ_TIMEOUT_MS=300
  start=$(date +%s)
  dry
  [ "$status" -eq 0 ]
  [[ "$output" == *"응답 없음(시간 초과)"* ]]
  [ $(( $(date +%s) - start )) -lt 10 ]
}

@test "한도였던 다 쓴 창이 초기화됐으면 다른 창이 남아 있어도 한도로 적지 않는다" {
  export FAKE_RL="$(rl 100 60 '"rate_limit_reached"')"
  start_discord
  node "$SCRIPT" --now "$NOW_MS"
  export FAKE_MODE=error
  run node "$SCRIPT" --now $(( NOW_MS + 4 * 3600 * 1000 ))
  last=$(tail -n 1 "$REQ_LOG")
  [[ "$last" == *"🟢 **5시간** 100% 남음"* ]]
  [[ "$last" == *"🟢 **주간** 40% 남음"* ]]
  [[ "$last" != *"한도에 걸려"* ]]
}

@test "웹후크 주소가 없으면 1로 끝난다" {
  export FAKE_RL="$(rl 5 90)"
  run node "$SCRIPT" --now "$NOW_MS"
  [ "$status" -eq 1 ]
  [[ "$output" == *"DISCORD_WEBHOOK이 없습니다"* ]]
}

@test "워크플로: 리뷰 컴퓨터에서 돌고 · 스크립트만 받고 · Codex 리뷰가 끝날 때도 돈다" {
  grep -q 'runs-on: \[self-hosted, codex\]' "$WORKFLOW"
  # checkout 없이 main의 스크립트 하나만 받음(리뷰 작업 폴더를 건드리지 않고, 다른 브랜치 코드를 돌리지 않음)
  ! grep -q 'actions/checkout' "$WORKFLOW"
  grep -q 'contents/scripts/codex-usage-live.mjs?ref=main' "$WORKFLOW"
  grep -q 'node "$script"' "$WORKFLOW"
  # 건너뛴 · 취소된 리뷰 뒤에는 돌지 않음
  grep -q "github.event.workflow_run.conclusion != 'skipped'" "$WORKFLOW"
  grep -q "github.event.workflow_run.conclusion != 'cancelled'" "$WORKFLOW"
  grep -q 'DISCORD_WEBHOOK: ${{ secrets.DISCORD_RUNNER_WEBHOOK }}' "$WORKFLOW"
  # workflow_run은 워크플로 이름으로 찾으므로 codex-review.yml의 name과 같아야 함
  review_name=$(sed -n 's/^name: //p' "$BATS_TEST_DIRNAME/../../.github/workflows/codex-review.yml")
  grep -q "workflows: \[$review_name\]" "$WORKFLOW"
  # 수동 실행은 main에서만(수동 실행은 고른 브랜치의 YAML로 돎)
  grep -q "github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main'" "$WORKFLOW"
  # 사용량 대기 실행이 쌓이지 않게 한 그룹. job 단위라 건너뛰는 실행은 그룹에 들어가지 않음
  grep -q '^    concurrency:$' "$WORKFLOW"
  ! grep -q '^concurrency:' "$WORKFLOW"
  grep -q 'group: codex-usage-live' "$WORKFLOW"
}
