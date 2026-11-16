#!/usr/bin/env bats
# 배포 뒤 응답 확인(wait-http-ok.sh) 테스트. curl은 정해 둔 응답을 차례로 내는 가짜로 바꾼다.

setup() {
  SCRIPT="$BATS_TEST_DIRNAME/../wait-http-ok.sh"
  BIN="$BATS_TEST_TMPDIR/bin"
  mkdir -p "$BIN"
  export CODES="$BATS_TEST_TMPDIR/codes" CALLS="$BATS_TEST_TMPDIR/calls"
  : > "$CALLS"
  # 한 줄에 응답 하나. "fail"이면 연결 실패(출력 없이 7로 끝남). 다 쓰면 마지막 줄을 되풀이.
  cat > "$BIN/curl" <<'SH'
#!/usr/bin/env bash
echo "$*" >> "$CALLS"
n=$(wc -l < "$CALLS")
code=$(sed -n "${n}p" "$CODES")
[ -n "$code" ] || code=$(tail -n 1 "$CODES")
[ "$code" = fail ] && exit 7
printf '%s' "$code"
SH
  chmod +x "$BIN/curl"
  PATH="$BIN:$PATH"
}

calls() { wc -l < "$CALLS" | tr -d ' '; }

@test "첫 응답이 200이면 바로 성공" {
  printf '200\n' > "$CODES"
  run bash "$SCRIPT" https://example.test/health 5 0
  [ "$status" -eq 0 ]
  [ "$(calls)" -eq 1 ]
}

@test "200이 아니면 다시 시도하고 200이 오면 성공" {
  printf '503\n502\n200\n' > "$CODES"
  run bash "$SCRIPT" https://example.test/health 5 0
  [ "$status" -eq 0 ]
  [ "$(calls)" -eq 3 ]
  [[ "$output" == *"시도 3/5: 200"* ]]
}

@test "연결 실패도 다시 시도" {
  printf 'fail\n200\n' > "$CODES"
  run bash "$SCRIPT" https://example.test/health 5 0
  [ "$status" -eq 0 ]
  [ "$(calls)" -eq 2 ]
}

@test "끝까지 200이 아니면 정한 횟수만 시도하고 실패" {
  printf '503\n' > "$CODES"
  run bash "$SCRIPT" https://example.test/health 4 0
  [ "$status" -eq 1 ]
  [ "$(calls)" -eq 4 ]
  [[ "$output" == *"200 응답을 받지 못했습니다"* ]]
}

@test "받은 주소 그대로 호출" {
  printf '200\n' > "$CODES"
  run bash "$SCRIPT" https://example.test/api/v1/health 1 0
  [ "$status" -eq 0 ]
  grep -q 'https://example.test/api/v1/health' "$CALLS"
}

@test "주소가 없으면 실패" {
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(calls)" -eq 0 ]
}
