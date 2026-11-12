#!/usr/bin/env bats
# scripts/env-vault.sh 테스트
#   실행: npx --yes bats@1.13.0 scripts/tests
# 중간 줄의 `! 명령`은 bats에서 실패로 잡히지 않아 `|| false`를 붙입니다.
# az는 가짜 실행 파일(PATH 맨 앞)로 바꿉니다. 가짜 Key Vault는 $VAULT_DIR/<secret 이름> 파일 하나가
# secret 하나이고, <이름>.disabled 파일이 있으면 꺼 둔 secret입니다. 받은 인자는 $AZ_LOG에 남깁니다.

setup() {
  TMP="$BATS_TEST_TMPDIR"
  export ENV_VAULT_ROOT="$TMP/repo" NOTELINK_VAULT=kv-test
  export VAULT_DIR="$TMP/vault" AZ_LOG="$TMP/az.log"
  mkdir -p "$ENV_VAULT_ROOT/apps/ai" "$ENV_VAULT_ROOT/apps/api" "$VAULT_DIR" "$TMP/bin"
  cat > "$TMP/bin/az" <<'EOF'
#!/usr/bin/env bash
# 가짜 az: keyvault secret list · show · set만
printf '%s\n' "$*" >> "$AZ_LOG"
[ -n "${AZ_FAIL:-}" ] && { echo "ERROR: Forbidden" >&2; exit 1; }
args=("$@"); name=""; file=""; query=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --name) name=${args[i+1]} ;;
    --file) file=${args[i+1]} ;;
    --query) query=${args[i+1]} ;;
  esac
done
case "$1 $2 $3" in
  "keyvault secret list")
    prefix=$(sed -E "s/.*starts_with\(name, '([^']*)'\).*/\1/" <<< "$query")
    for f in "$VAULT_DIR"/*; do
      [ -f "$f" ] || continue
      n=$(basename "$f")
      [[ "$n" == *.disabled ]] && continue
      [ -e "$f.disabled" ] && continue
      if [[ "$n" == "$prefix"* ]]; then printf '%s\r\n' "$n"; fi  # Windows az처럼 \r\n
    done ;;
  "keyvault secret show")
    [ -f "$VAULT_DIR/$name" ] || exit 3
    printf '%s\r\n' "$(cat "$VAULT_DIR/$name")" ;;
  "keyvault secret set")
    cp "$file" "$VAULT_DIR/$name"
    stat -c %a "$file" > "$TMP_MODE_FILE" 2> /dev/null || true ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$TMP/bin/az"
  export TMP_MODE_FILE="$TMP/mode"
  PATH="$TMP/bin:$PATH"
  SCRIPT="$BATS_TEST_DIRNAME/../env-vault.sh"
  # shellcheck source=../env-vault.sh
  source "$SCRIPT"
}

put() { printf '%s' "$2" > "$VAULT_DIR/$1"; }  # $1 = secret 이름, $2 = 값

# ---------- 이름 ----------

@test "secret_name · var_name: _와 -를 서로 바꾸고 앱 이름을 앞에 붙인다" {
  [ "$(secret_name ai ANTHROPIC_API_KEY)" = "ai--ANTHROPIC-API-KEY" ]
  [ "$(var_name ai ai--ANTHROPIC-API-KEY)" = "ANTHROPIC_API_KEY" ]
  [ "$(var_name api api--JWT-ACCESS-SECRET)" = "JWT_ACCESS_SECRET" ]
}

@test "앱 이름은 ai · api만" {
  run bash "$SCRIPT" pull mobile
  [ "$status" -ne 0 ] && [[ "$output" == *"앱은 ai · api 중 하나"* ]]
  run bash "$SCRIPT" pull
  [ "$status" -ne 0 ] && [[ "$output" == *"사용법"* ]]
}

@test "변수 이름은 대문자 · 숫자 · _만" {
  run bash -c 'printf x | "$1" push ai bad-name' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"변수 이름은"* ]]
  [ ! -e "$VAULT_DIR/ai--bad-name" ]
}

# ---------- env_line ----------

@test "env_line: 특수 문자가 없으면 그대로, 공백 · # 이 있으면 작은따옴표" {
  [ "$(env_line A 'mongodb+srv://u:p@c.net/?retryWrites=true&w=majority')" = 'A=mongodb+srv://u:p@c.net/?retryWrites=true&w=majority' ]
  [ "$(env_line A 'a b#c')" = "A='a b#c'" ]
  [ "$(env_line A '')" = 'A=' ]
}

@test "env_line: 작은따옴표 · 역슬래시 · 줄바꿈은 거절" {
  run env_line A "it's"
  [ "$status" -ne 0 ]
  run env_line A 'a\b'
  [ "$status" -ne 0 ]
  run env_line A $'a\nb'
  [ "$status" -ne 0 ]
}

# ---------- pull ----------

@test "pull: 그 앱의 secret만 받아 .env를 만들고 \\r을 지운다" {
  put ai--ANTHROPIC-API-KEY sk-ant-123
  put ai--MONGODB-URI 'mongodb://127.0.0.1:27017'
  put api--JWT-ACCESS-SECRET jwt
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"Key Vault에서 2개"* ]]
  grep -qx 'ANTHROPIC_API_KEY=sk-ant-123' "$ENV_VAULT_ROOT/apps/ai/.env"
  grep -qx 'MONGODB_URI=mongodb://127.0.0.1:27017' "$ENV_VAULT_ROOT/apps/ai/.env"
  ! grep -q JWT "$ENV_VAULT_ROOT/apps/ai/.env" || false
  ! grep -q $'\r' "$ENV_VAULT_ROOT/apps/ai/.env" || false
}

@test "pull: 값은 화면에 찍지 않는다" {
  put ai--ANTHROPIC-API-KEY sk-ant-secret-value
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" != *"sk-ant-secret-value"* ]]
}

@test "pull: 꺼 둔 secret은 받지 않는다" {
  put ai--OLD-KEY old
  touch "$VAULT_DIR/ai--OLD-KEY.disabled"
  put ai--NEW-KEY new
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  ! grep -q OLD_KEY "$ENV_VAULT_ROOT/apps/ai/.env" || false
  grep -qx 'NEW_KEY=new' "$ENV_VAULT_ROOT/apps/ai/.env"
}

@test "pull: .env.local의 값이 받은 값을 덮어쓰고, 덮인 secret은 읽지도 않는다" {
  put ai--MONGODB-URI 'mongodb+srv://team'
  put ai--ANTHROPIC-API-KEY team-key
  printf '# 내 값\nexport MONGODB_URI=mongodb://127.0.0.1:27017\r\n' > "$ENV_VAULT_ROOT/apps/ai/.env.local"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"1개 덮어씀"* ]]
  local env="$ENV_VAULT_ROOT/apps/ai/.env"
  [ "$(grep -c MONGODB_URI "$env")" -eq 1 ]
  grep -qx 'export MONGODB_URI=mongodb://127.0.0.1:27017' "$env"
  grep -qx 'ANTHROPIC_API_KEY=team-key' "$env"
  ! grep -q 'show.*ai--MONGODB-URI' "$AZ_LOG" || false
}

@test "pull: 손으로 만든 .env는 .env.bak으로 남기고, 다음 pull이 그 백업을 덮지 않는다" {
  local dir="$ENV_VAULT_ROOT/apps/ai"
  put ai--A one
  printf 'MINE=1\n' > "$dir/.env"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ] && [[ "$output" == *".env.bak로 남겼습니다"* ]]
  grep -qx 'MINE=1' "$dir/.env.bak"
  put ai--A two  # 팀원이 값을 바꿈 → 다시 받음: pull이 쓴 .env는 남기지 않음
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  grep -qx 'MINE=1' "$dir/.env.bak"
  grep -qx 'A=two' "$dir/.env"
  [ "$(ls -A "$dir" | grep -c '^\.env\.bak')" -eq 1 ]
}

@test "pull: .env.bak이 이미 있으면 손으로 만든 .env를 시각 붙인 이름으로 남긴다" {
  local dir="$ENV_VAULT_ROOT/apps/ai"
  put ai--A one
  printf 'OLD=1\n' > "$dir/.env.bak"
  printf 'MINE=2\n' > "$dir/.env"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  grep -qx 'OLD=1' "$dir/.env.bak"
  grep -qx 'MINE=2' "$dir"/.env.bak.[0-9]*
}

@test "pull: .env.local의 이름은 대소문자를 가리지 않고 덮어쓴다" {
  put ai--MONGODB-URI team
  printf 'mongodb_uri=local\n' > "$ENV_VAULT_ROOT/apps/ai/.env.local"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  ! grep -q '^MONGODB_URI=' "$ENV_VAULT_ROOT/apps/ai/.env" || false
  grep -qx 'mongodb_uri=local' "$ENV_VAULT_ROOT/apps/ai/.env"
}

@test "pull: .env로 쓸 수 없는 값은 건너뛰고 알린다" {
  put ai--A "it's"
  put ai--B ok
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"A 값에 줄바꿈"* && "$output" == *"건너뜀 1개"* ]]
  ! grep -q '^A=' "$ENV_VAULT_ROOT/apps/ai/.env" || false
}

@test "pull: 권한이 없거나 로그인하지 않았으면 .env를 바꾸지 않고 실패한다" {
  printf 'MINE=1\n' > "$ENV_VAULT_ROOT/apps/ai/.env"
  AZ_FAIL=1 run bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ] && [[ "$output" == *"az login"* ]]
  [ "$(cat "$ENV_VAULT_ROOT/apps/ai/.env")" = "MINE=1" ]
  [ -z "$(ls "$ENV_VAULT_ROOT/apps/ai" | grep pull)" ]  # 임시 파일도 남지 않음
}

@test "pull: 그 앱의 secret이 하나도 없으면 실패한다" {
  put api--X 1
  run bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ] && [[ "$output" == *"'ai--'로 시작하는 secret이 없습니다"* ]]
  [ ! -e "$ENV_VAULT_ROOT/apps/ai/.env" ]
}

@test "pull: az가 없으면 설치 안내" {
  run env PATH=/nonexistent /bin/bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ] && [[ "$output" == *"Azure CLI(az)가 없습니다"* ]]
}

# ---------- push ----------

@test "push: 표준 입력의 값을 넣고, 값은 az 인자 · 화면에 남지 않는다" {
  run bash -c 'printf "sk-new-value\n" | "$1" push ai ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$VAULT_DIR/ai--ANTHROPIC-API-KEY")" = "sk-new-value" ]  # 끝 줄바꿈은 뺌
  ! grep -q sk-new-value "$AZ_LOG" || false
  [[ "$output" != *"sk-new-value"* ]]
  grep -q -- '--file' "$AZ_LOG"
}

@test "push: PowerShell 파이프처럼 \\r\\n으로 끝나도 \\r을 넣지 않고, 값 가운데 \\r은 거절한다" {
  run bash -c 'printf "sk-x\r\n" | "$1" push ai A' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$VAULT_DIR/ai--A")" = "sk-x" ]
  run bash -c 'printf "a\rb" | "$1" push ai B' _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$VAULT_DIR/ai--B" ]
}

@test "push: 임시 파일은 권한 600이고 끝나면 지운다" {
  mkdir -p "$TMP/t"
  run bash -c 'printf v | TMPDIR="$2" "$1" push ai A' _ "$SCRIPT" "$TMP/t"
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$TMP/t")" ]
  if [ -s "$TMP_MODE_FILE" ] && [ "$(uname -s)" = Linux ]; then
    [ "$(cat "$TMP_MODE_FILE")" = 600 ]
  fi
}

@test "push: 빈 값 · .env로 쓸 수 없는 값은 넣지 않는다" {
  run bash -c 'printf "" | "$1" push ai A' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"값이 비었습니다"* ]]
  run bash -c "printf \"it's\" | \"\$1\" push ai A" _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$VAULT_DIR/ai--A" ]
}

@test "push: 쓰기 권한이 없으면 실패를 알린다" {
  run bash -c 'printf v | AZ_FAIL=1 "$1" push ai A' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"Key Vault Secrets Officer"* ]]
}

# ---------- list ----------

@test "list: 그 앱의 변수 이름만 정렬해 보여 준다" {
  put ai--ZED secret-z
  put ai--ALPHA secret-a
  put api--JWT x
  run bash "$SCRIPT" list ai
  [ "$status" -eq 0 ]
  [ "$output" = $'ALPHA\nZED' ]
}

@test "list: secret이 없으면 알리고 성공으로 끝난다" {
  put api--JWT x
  run bash "$SCRIPT" list ai
  [ "$status" -eq 0 ] && [[ "$output" == *"'ai--'로 시작하는 secret이 없습니다"* ]]
}

@test "list: 읽지 못하면 로그인 · 권한 안내와 함께 실패한다" {
  AZ_FAIL=1 run bash "$SCRIPT" list ai
  [ "$status" -ne 0 ] && [[ "$output" == *"Key Vault Secrets User"* ]]
}

@test "list: pull이 받지 않는 이름은 알리고 빼서 pull과 같다" {
  put ai--GOOD 1
  put ai--bad-name 2
  run bash "$SCRIPT" list ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"pull이 받지 않음: ai--bad-name"* ]]
  [ "$(grep -vc 'env-vault' <<< "$output")" -eq 1 ] && grep -qx GOOD <<< "$output"
}
