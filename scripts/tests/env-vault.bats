#!/usr/bin/env bats
# scripts/env-vault.sh 테스트
#   실행: npx --yes bats@1.13.0 scripts/tests
# 중간 줄의 `! 명령`은 bats에서 실패로 잡히지 않아 `|| false`를 붙입니다.
# az는 가짜 실행 파일(PATH 맨 앞)로 바꿉니다. 가짜 Key Vault는 $VAULT_DIR/<secret 이름> 파일 하나가
# secret 하나이고, <이름>.disabled 파일이 있으면 꺼 둔 secret입니다. 다른 Key Vault 이름이면 실패합니다.
# 값 읽기(secret show)는 늘 거부합니다(값을 못 보는 NoteLink Secrets Writer처럼): 스크립트가 값을
# 읽지 않는지 확인합니다. 받은 인자는 $AZ_LOG에 남깁니다.
# 앱이 쓰는 변수는 가짜 저장소의 apps/<앱>/.env.production(setup에서 만듦)입니다.

setup() {
  TMP="$BATS_TEST_TMPDIR"
  export ENV_VAULT_ROOT="$TMP/repo" NOTELINK_VAULT=kv-test
  export VAULT_DIR="$TMP/vault" AZ_LOG="$TMP/az.log"
  mkdir -p "$ENV_VAULT_ROOT/apps/ai" "$ENV_VAULT_ROOT/apps/api" "$VAULT_DIR" "$TMP/bin"
  cat > "$TMP/bin/az" <<'AZ'
#!/usr/bin/env bash
# 가짜 az: keyvault secret list · set만(show는 거부)
printf '%s\n' "$*" >> "$AZ_LOG"
[ -n "${AZ_FAIL:-}" ] && { echo "ERROR: Forbidden" >&2; exit 1; }
args=("$@"); name=""; file=""; vault=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --name) name=${args[i+1]} ;;
    --file) file=${args[i+1]} ;;
    --vault-name) vault=${args[i+1]} ;;
  esac
done
[ "$vault" = kv-test ] || { echo "ERROR: vault not found" >&2; exit 4; }
case "$1 $2 $3" in
  "keyvault secret list")
    for f in "$VAULT_DIR"/*; do
      [ -f "$f" ] || continue
      n=$(basename "$f")
      [[ "$n" == *.disabled ]] && continue
      if [ ! -e "$f.disabled" ]; then printf '%s\r\n' "$n"; fi  # Windows az처럼 \r\n
    done ;;
  "keyvault secret show")
    echo "ERROR: Forbidden (getSecret)" >&2; exit 1 ;;
  "keyvault secret set")
    cp "$file" "$VAULT_DIR/$name"
    stat -c %a "$file" > "$TMP_MODE_FILE" 2> /dev/null || true ;;
  *) exit 2 ;;
esac
AZ
  chmod +x "$TMP/bin/az"
  # 실제 .env.production처럼: 값 줄 · 주석으로 둔 선택 항목 · '로컬:' 줄 · 설명 주석
  cat > "$ENV_VAULT_ROOT/apps/ai/.env.production" <<'ENVP'
# AI 서버 예시
APP_ENV=production
ANTHROPIC_API_KEY=
# QUIZ_GEN_MODEL=
MONGODB_URI=mongodb+srv://<사용자>:<비밀번호>@<클러스터>.mongodb.net/
# 로컬: LOCAL_ONLY=mongodb://127.0.0.1:27017
VOYAGE_API_KEY=
ENVP
  printf 'MONGODB_URI=x\r\nJWT_ACCESS_SECRET=x\r\n' > "$ENV_VAULT_ROOT/apps/api/.env.production"
  export TMP_MODE_FILE="$TMP/mode"
  PATH="$TMP/bin:$PATH"
  SCRIPT="$BATS_TEST_DIRNAME/../env-vault.sh"
  # shellcheck source=../env-vault.sh
  source "$SCRIPT"
}

put() { printf '%s' "$2" > "$VAULT_DIR/$1"; }  # $1 = secret 이름, $2 = 값

# ---------- 이름 ----------

@test "secret_name · var_name: _와 -만 서로 바꾼다(배포 앱의 Key Vault 참조와 같은 이름)" {
  [ "$(secret_name ANTHROPIC_API_KEY)" = "ANTHROPIC-API-KEY" ]
  [ "$(var_name AZURE-STORAGE-CONNECTION-STRING)" = "AZURE_STORAGE_CONNECTION_STRING" ]
}

@test "app_vars: .env.production의 값 줄과 주석으로 둔 선택 항목, '로컬:' 줄은 빼고 \\r 없이" {
  [ "$(app_vars ai)" = $'ANTHROPIC_API_KEY\nAPP_ENV\nMONGODB_URI\nQUIZ_GEN_MODEL\nVOYAGE_API_KEY' ]
  [ "$(app_vars api)" = $'JWT_ACCESS_SECRET\nMONGODB_URI' ]
  [ "$(apps_of MONGODB_URI)" = "ai api" ]
  [ "$(apps_of JWT_ACCESS_SECRET)" = "api" ]
  [ -z "$(apps_of LOCAL_ONLY)" ]
}

@test "사용법: push · list만, 앱 이름은 ai · api만" {
  run bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ] && [[ "$output" == *"사용법"* && "$output" == *"로컬 개발용 키는 각자"* ]]
  run bash "$SCRIPT" list mobile
  [ "$status" -ne 0 ] && [[ "$output" == *"앱은 ai · api 중 하나"* ]]
  run bash "$SCRIPT" push
  [ "$status" -ne 0 ] && [[ "$output" == *"사용법"* ]]
}

@test "변수 이름은 대문자 · 숫자 · _만" {
  run bash -c 'printf x | "$1" push bad-name' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"변수 이름은"* ]]
  [ -z "$(ls -A "$VAULT_DIR")" ]
}

# ---------- push ----------

@test "push: 표준 입력의 값을 넣고, 값은 az 인자 · 화면에 남지 않는다" {
  run bash -c 'printf "sk-new-value\n" | "$1" push ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$VAULT_DIR/ANTHROPIC-API-KEY")" = "sk-new-value" ]  # 끝 줄바꿈은 뺌
  ! grep -q sk-new-value "$AZ_LOG" || false
  [[ "$output" != *"sk-new-value"* ]]
  [[ "$output" == *"Key Vault 'kv-test'에 저장함. 쓰는 앱: ai."* && "$output" == *"다시 시작할 때"* ]]
  grep -q -- '--file' "$AZ_LOG"
}

@test "push: 값을 못 읽는 권한(Writer)으로도 넣고 바꿀 수 있다 — 값을 읽지 않는다" {
  put ANTHROPIC-API-KEY old
  run bash -c 'printf new | "$1" push ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ] && [ "$(cat "$VAULT_DIR/ANTHROPIC-API-KEY")" = new ]
  ! grep -q 'secret show' "$AZ_LOG" || false
}

@test "push: 어느 앱도 쓰지 않는 이름이면 알리고 넣는다(새 변수일 수 있음)" {
  run bash -c 'printf v | "$1" push NEW_THING' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *".env.production에 없습니다"* ]]
  [ "$(cat "$VAULT_DIR/NEW-THING")" = v ]
}

@test "push: PowerShell 파이프처럼 \\r\\n으로 끝나도 \\r을 넣지 않고, 값 가운데 줄바꿈은 거절한다" {
  run bash -c 'printf "sk-x\r\n" | "$1" push ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$VAULT_DIR/ANTHROPIC-API-KEY")" = "sk-x" ]
  run bash -c 'printf "a\rb" | "$1" push VOYAGE_API_KEY' _ "$SCRIPT"
  [ "$status" -ne 0 ]
  run bash -c 'printf "a\nb" | "$1" push VOYAGE_API_KEY' _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$VAULT_DIR/VOYAGE-API-KEY" ]
}

@test "push: 끝 줄바꿈이 둘 이상이면 줄여 넣지 않고 거절하며, 있던 값은 그대로 둔다" {
  put JWT-ACCESS-SECRET old
  run bash -c 'printf "secret\n\n" | "$1" push JWT_ACCESS_SECRET' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"줄바꿈"* ]]
  [ "$(cat "$VAULT_DIR/JWT-ACCESS-SECRET")" = old ]
  run bash -c 'printf "secret\r\n\r\n" | "$1" push JWT_ACCESS_SECRET' _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(cat "$VAULT_DIR/JWT-ACCESS-SECRET")" = old ]
}

@test "push: 따옴표 · 역슬래시 같은 문자는 그대로 넣는다" {
  printf '%s' "it's a\\b" > "$TMP/value"
  run bash -c '"$1" push APP_ENV < "$2"' _ "$SCRIPT" "$TMP/value"
  [ "$status" -eq 0 ]
  [ "$(cat "$VAULT_DIR/APP-ENV")" = "it's a\\b" ]
}

@test "push: 임시 파일은 권한 600이고 끝나면 지운다" {
  mkdir -p "$TMP/t"
  run bash -c 'printf v | TMPDIR="$2" "$1" push APP_ENV' _ "$SCRIPT" "$TMP/t"
  [ "$status" -eq 0 ]
  [ -z "$(ls -A "$TMP/t")" ]
  if [ -s "$TMP_MODE_FILE" ] && [ "$(uname -s)" = Linux ]; then
    [ "$(cat "$TMP_MODE_FILE")" = 600 ]
  fi
}

@test "push: 빈 값은 넣지 않는다" {
  run bash -c 'printf "" | "$1" push APP_ENV' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"값이 비었습니다"* ]]
  [ ! -e "$VAULT_DIR/APP-ENV" ]
}

@test "push: 쓰기 권한이 없으면 역할 안내와 함께 실패한다" {
  run bash -c 'printf v | AZ_FAIL=1 "$1" push APP_ENV' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"NoteLink Secrets Writer"* ]]
}

@test "push: az가 없으면 설치 안내" {
  run bash -c 'printf v | PATH=/nonexistent "$BASH" "$1" push APP_ENV' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"Azure CLI"* ]]
}

# ---------- list ----------

@test "list: 앱을 주면 그 앱이 쓰는 이름만, 안 주면 모두와 쓰는 앱 — 값은 읽지 않는다" {
  put VOYAGE-API-KEY a
  put MONGODB-URI b
  put JWT-ACCESS-SECRET c
  put SOMETHING-ELSE d
  run bash "$SCRIPT" list ai
  [ "$status" -eq 0 ]
  [ "$output" = $'MONGODB_URI\tai api\nVOYAGE_API_KEY\tai' ]
  run bash "$SCRIPT" list
  [ "$status" -eq 0 ]
  [ "$output" = $'JWT_ACCESS_SECRET\tapi\nMONGODB_URI\tai api\nSOMETHING_ELSE\t(쓰는 앱 없음)\nVOYAGE_API_KEY\tai' ]
  ! grep -q 'secret show' "$AZ_LOG" || false
}

@test "list: 꺼 둔 secret · 이름 규칙에 맞지 않는 secret은 보이지 않는다" {
  put VOYAGE-API-KEY a
  put ANTHROPIC-API-KEY b
  : > "$VAULT_DIR/ANTHROPIC-API-KEY.disabled"
  put my-key c
  run bash "$SCRIPT" list ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"규칙에 맞지 않아 보이지 않음: my-key"* ]]
  [[ "$output" == *$'VOYAGE_API_KEY\tai'* && "$output" != *ANTHROPIC* ]]
}

@test "list: 해당 secret이 없으면 알리고 성공으로 끝난다" {
  put JWT-ACCESS-SECRET x
  run bash "$SCRIPT" list ai
  [ "$status" -eq 0 ] && [[ "$output" == *"변수가 없습니다"* ]]
}

@test "list: 읽지 못하면 로그인 · 권한 안내와 함께 실패한다" {
  AZ_FAIL=1 run bash "$SCRIPT" list ai
  [ "$status" -ne 0 ] && [[ "$output" == *"az login"* && "$output" == *"Secrets Officer"* ]]
}
