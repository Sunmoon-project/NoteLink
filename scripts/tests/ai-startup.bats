#!/usr/bin/env bats
# AI 서버 시작 스크립트(ai-startup.sh) 테스트. python은 역할(작업 처리기 · 웹 서버)마다 정한 대로
# 움직이는 가짜로 바꾸고, 시작 · 멈춤 신호 · 끝남을 $LOG에 적는다.
#   WORKER_MODE · WEB_MODE: run(신호 올 때까지 돎) · exit:N(바로 N으로 끝남) ·
#   slow(신호를 받으면 잠시 뒤 끝남, 처리 중인 작업 끝내기) · stubborn(첫 신호는 무시, 두 번째에 끝남)

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../ai-startup.sh"
  BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BIN"
  export LOG="$BATS_TEST_TMPDIR/log"
  : > "$LOG"
  cat > "$BIN/python" <<'SH'
#!/usr/bin/env bash
case "$2" in
  app.worker) role=worker mode="${WORKER_MODE:-run}" ;;
  uvicorn) role=web mode="${WEB_MODE:-run}" ;;
  *) echo "unexpected: $*" >> "$LOG"; exit 99 ;;
esac
terms=0
on_term() {
  terms=$((terms + 1))
  echo "$role term $terms" >> "$LOG"
  case "$mode" in
    slow) sleep 1; echo "$role done" >> "$LOG"; exit 0 ;;
    stubborn) [ "$terms" -ge 2 ] && { echo "$role done" >> "$LOG"; exit 0; } ;;
    *) exit 0 ;;
  esac
}
trap on_term TERM
echo "$role start $* (cwd $PWD)" >> "$LOG" # 신호 처리를 건 뒤에 시작을 알림
if [[ "$mode" == exit:* ]]; then
  # 상대가 시작(신호 처리를 걸어 둠)한 뒤에 끝남: 상대가 멈춤 신호를 받는지 보려고
  for _ in $(seq 100); do [ "$(grep -c ' start ' "$LOG")" -ge 2 ] && break; sleep 0.05; done
  echo "$role exit ${mode#exit:}" >> "$LOG"
  exit "${mode#exit:}"
fi
# 멈춤 신호가 오지 않으면 약 10초 뒤 스스로 끝남: 스크립트가 고장 나도 시험이 멈추지 않고 실패하게
for _ in $(seq 200); do sleep 0.05; done
echo "$role gave up" >> "$LOG"
SH
  chmod +x "$BIN/python"
  PATH="$BIN:$PATH"
}

# 두 역할이 모두 시작할 때까지 기다림(최대 5초)
started() {
  for _ in $(seq 100); do
    [ "$(grep -c ' start ' "$LOG")" -ge 2 ] && return 0
    sleep 0.05
  done
  return 1
}

# 스크립트를 띄우고 둘이 시작한 뒤 신호를 보낸 다음 끝날 때까지 기다림. 종료 코드는 $code
# (&로 띄운 프로세스는 SIGINT를 무시한 채 시작해 trap도 못 바꾸므로 신호는 SIGTERM으로 본다.
#  App Service도 SIGTERM을 보냄. 3>&-: 남은 프로세스가 bats 출력을 잡고 있어 멈추지 않게)
run_and_signal() {
  bash "$SCRIPT" > "$BATS_TEST_TMPDIR/out" 2>&1 3>&- &
  local pid=$!
  started
  kill "-$1" "$pid"
  if [ -n "${2:-}" ]; then
    sleep "$2"
    kill "-$1" "$pid"
  fi
  code=0
  wait "$pid" || code=$?
}

@test "작업 처리기와 웹 서버를 스크립트 폴더에서 함께 띄우고 PORT로 듣는다" {
  cd "$BATS_TEST_TMPDIR"
  PORT=8123 run_and_signal TERM
  grep -q "^worker start -m app.worker (cwd $(cd "$BATS_TEST_DIRNAME/.." && pwd))$" "$LOG"
  grep -q "^web start -m uvicorn app.main:app --host 0.0.0.0 --port 8123 " "$LOG"
}

@test "PORT가 없으면 8000" {
  unset PORT
  run_and_signal TERM
  grep -q "^web start -m uvicorn app.main:app --host 0.0.0.0 --port 8000 " "$LOG"
}

@test "SIGTERM은 둘 모두에 전달하고 둘 다 끝나면 0으로 끝난다" {
  run_and_signal TERM
  [ "$code" -eq 0 ]
  grep -q "^worker term 1$" "$LOG"
  grep -q "^web term 1$" "$LOG"
}

@test "멈출 때 처리기가 처리 중인 작업을 끝낼 때까지 기다린다" {
  export WORKER_MODE=slow
  run_and_signal TERM
  [ "$code" -eq 0 ]
  grep -q "^worker done$" "$LOG"
}

@test "기다리는 중에 신호가 한 번 더 오면 처리기에 다시 전달한다(바로 끝내기)" {
  export WORKER_MODE=stubborn
  run_and_signal TERM 0.5
  [ "$code" -eq 0 ]
  grep -q "^worker term 2$" "$LOG"
  grep -q "^worker done$" "$LOG"
}

@test "처리기가 설정 오류 등으로 끝나면 웹 서버도 멈추고 그 코드로 끝난다" {
  export WORKER_MODE=exit:3
  run bash "$SCRIPT"
  [ "$status" -eq 3 ]
  grep -q "^web term 1$" "$LOG"
  [[ "$output" == *"작업 처리기가 끝났습니다(코드 3)"* ]]
}

@test "웹 서버가 끝나면 처리기도 멈춘다" {
  export WEB_MODE=exit:2
  run bash "$SCRIPT"
  [ "$status" -eq 2 ]
  grep -q "^worker term 1$" "$LOG"
  [[ "$output" == *"웹 서버가 끝났습니다(코드 2)"* ]]
}

@test "신호 없이 0으로 끝나도 실패(1)로 끝내 App Service가 다시 시작하게 한다" {
  export WORKER_MODE=exit:0
  run bash "$SCRIPT"
  [ "$status" -eq 1 ]
  grep -q "^web term 1$" "$LOG"
}
