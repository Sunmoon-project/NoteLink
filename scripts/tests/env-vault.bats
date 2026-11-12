#!/usr/bin/env bats
# scripts/env-vault.sh 테스트
#   실행: npx --yes bats@1.13.0 scripts/tests
# 중간 줄의 `! 명령`은 bats에서 실패로 잡히지 않아 `|| false`를 붙입니다.
# az는 가짜 실행 파일(PATH 맨 앞)로 바꿉니다. 가짜 Key Vault는 $VAULTS/<Key Vault 이름>/<secret 이름>
# 파일 하나가 secret 하나이고, <이름>.disabled 파일이 있으면 꺼 둔 secret입니다. 팀 Key Vault는 $VAULT_DIR,
# 배포 Key Vault는 $DEPLOY_DIR. AZ_NO_READ=<Key Vault 이름>이면 그 Key Vault의 값 읽기(show)만 거부합니다
# (이름 보기 · 넣기만 되는 NoteLink Secrets Writer). 받은 인자는 $AZ_LOG에 남깁니다.
# 앱이 읽는 변수는 가짜 저장소의 apps/<앱>/.env.production(setup에서 만듦)입니다.

setup() {
  TMP="$BATS_TEST_TMPDIR"
  export ENV_VAULT_ROOT="$TMP/repo" NOTELINK_VAULT=kv-test NOTELINK_DEPLOY_VAULT=kv-deploy
  export VAULTS="$TMP/vaults" AZ_LOG="$TMP/az.log"
  export VAULT_DIR="$VAULTS/kv-test" DEPLOY_DIR="$VAULTS/kv-deploy"
  mkdir -p "$ENV_VAULT_ROOT/apps/ai" "$ENV_VAULT_ROOT/apps/api" "$VAULT_DIR" "$DEPLOY_DIR" "$TMP/bin"
  cat > "$TMP/bin/az" <<'EOF'
#!/usr/bin/env bash
# 가짜 az: keyvault secret list · show · set만
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
[ -d "$VAULTS/$vault" ] || { echo "ERROR: vault not found" >&2; exit 4; }
VAULT_DIR="$VAULTS/$vault"
case "$1 $2 $3" in
  "keyvault secret list")
    for f in "$VAULT_DIR"/*; do
      [ -f "$f" ] || continue
      n=$(basename "$f")
      [[ "$n" == *.disabled ]] && continue
      if [ ! -e "$f.disabled" ]; then printf '%s\r\n' "$n"; fi  # Windows az처럼 \r\n
    done ;;
  "keyvault secret show")
    [ "${AZ_NO_READ:-}" = "$vault" ] && { echo "ERROR: Forbidden (getSecret)" >&2; exit 1; }
    [ -f "$VAULT_DIR/$name" ] || exit 3
    printf '%s\r\n' "$(cat "$VAULT_DIR/$name")" ;;
  "keyvault secret set")
    cp "$file" "$VAULT_DIR/$name"
    stat -c %a "$file" > "$TMP_MODE_FILE" 2> /dev/null || true ;;
  *) exit 2 ;;
esac
EOF
  chmod +x "$TMP/bin/az"
  # 실제 .env.production처럼: 값 줄 · 주석으로 둔 선택 항목 · '로컬:' 줄 · 설명 주석
  cat > "$ENV_VAULT_ROOT/apps/ai/.env.production" <<'EOF'
# AI 서버 예시
APP_ENV=production
ANTHROPIC_API_KEY=
# QUIZ_GEN_MODEL=
MONGODB_URI=mongodb+srv://<사용자>:<비밀번호>@<클러스터>.mongodb.net/
# 로컬: MONGODB_URI=mongodb://127.0.0.1:27017
VOYAGE_API_KEY=
EOF
  printf 'MONGODB_URI=x\r\nJWT_ACCESS_SECRET=x\r\n' > "$ENV_VAULT_ROOT/apps/api/.env.production"
  export TMP_MODE_FILE="$TMP/mode"
  PATH="$TMP/bin:$PATH"
  SCRIPT="$BATS_TEST_DIRNAME/../env-vault.sh"
  # shellcheck source=../env-vault.sh
  source "$SCRIPT"
}

put() { printf '%s' "$2" > "$VAULT_DIR/$1"; }  # $1 = secret 이름, $2 = 값
ENV() { printf '%s' "$ENV_VAULT_ROOT/apps/$1/.env"; }

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
  [ -z "$(apps_of NOPE)" ]
}

@test "앱 이름은 ai · api만" {
  run bash "$SCRIPT" pull mobile
  [ "$status" -ne 0 ] && [[ "$output" == *"앱은 ai · api 중 하나"* ]]
  run bash "$SCRIPT" pull
  [ "$status" -ne 0 ] && [[ "$output" == *"사용법"* ]]
}

@test "변수 이름은 대문자 · 숫자 · _만" {
  run bash -c 'printf x | "$1" push bad-name' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"변수 이름은"* ]]
  [ -z "$(ls -A "$VAULT_DIR")" ]
}

# ---------- env_line ----------

@test "env_line: 특수 문자가 없으면 그대로, 공백 · # 이 있으면 작은따옴표" {
  [ "$(env_line A 'mongodb+srv://u:p@c.net/?retryWrites=true&w=majority')" = 'A=mongodb+srv://u:p@c.net/?retryWrites=true&w=majority' ]
  [ "$(env_line A 'a b#c')" = "A='a b#c'" ]
  [ "$(env_line A '')" = 'A=' ]
}

@test "env_line: 작은따옴표 · 역슬래시 · 줄바꿈 · \\r은 거절" {
  run env_line A "it's"
  [ "$status" -ne 0 ]
  run env_line A 'a\b'
  [ "$status" -ne 0 ]
  run env_line A $'a\nb'
  [ "$status" -ne 0 ]
  run env_line A $'a\rb'
  [ "$status" -ne 0 ]
}

# ---------- pull ----------

@test "pull: 그 앱의 .env.production에 있는 secret만 받아 .env를 만들고 \\r을 지운다" {
  put ANTHROPIC-API-KEY sk-ant-123
  put MONGODB-URI 'mongodb+srv://team'
  put JWT-ACCESS-SECRET jwt        # api만 읽음
  put SOMETHING-ELSE x             # 어느 앱도 읽지 않음
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"Key Vault에서 2개"* ]]
  grep -qx 'ANTHROPIC_API_KEY=sk-ant-123' "$(ENV ai)"
  grep -qx 'MONGODB_URI=mongodb+srv://team' "$(ENV ai)"
  ! grep -q 'JWT\|SOMETHING' "$(ENV ai)" || false
  ! grep -q $'\r' "$(ENV ai)" || false
  run bash "$SCRIPT" pull api
  [ "$status" -eq 0 ]
  grep -qx 'JWT_ACCESS_SECRET=jwt' "$(ENV api)"
  grep -qx 'MONGODB_URI=mongodb+srv://team' "$(ENV api)"  # 두 앱이 같은 secret을 씀
}

@test "pull: 값은 화면에 찍지 않는다" {
  put ANTHROPIC-API-KEY sk-ant-secret-value
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" != *"sk-ant-secret-value"* ]]
}

@test "pull: 꺼 둔 secret은 받지 않는다" {
  put VOYAGE-API-KEY old
  touch "$VAULT_DIR/VOYAGE-API-KEY.disabled"
  put ANTHROPIC-API-KEY new
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  ! grep -q VOYAGE "$(ENV ai)" || false
  grep -qx 'ANTHROPIC_API_KEY=new' "$(ENV ai)"
}

@test "pull: 이름 규칙에 맞지 않는 secret은 알리고 쓰지 않는다" {
  put ANTHROPIC-API-KEY k
  put my-key lower  # (가짜 Key Vault는 파일이라 Windows에서 대소문자만 다른 이름은 겹침)
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"규칙에 맞지 않아 쓰지 않음: my-key"* ]]
  grep -qx 'ANTHROPIC_API_KEY=k' "$(ENV ai)"
}

@test "pull: .env.local의 값이 받은 값을 덮어쓰고, 덮인 secret은 읽지도 않는다" {
  put MONGODB-URI 'mongodb+srv://team'
  put ANTHROPIC-API-KEY team-key
  printf '# 내 값\nexport MONGODB_URI=mongodb://127.0.0.1:27017\r\n' > "$ENV_VAULT_ROOT/apps/ai/.env.local"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"1개 덮어씀"* ]]
  [ "$(grep -c MONGODB_URI "$(ENV ai)")" -eq 1 ]
  grep -qx 'export MONGODB_URI=mongodb://127.0.0.1:27017' "$(ENV ai)"
  grep -qx 'ANTHROPIC_API_KEY=team-key' "$(ENV ai)"
  ! grep -q 'show.*MONGODB-URI' "$AZ_LOG" || false
}

@test "pull: .env.local의 이름은 대소문자를 가리지 않고 덮어쓴다" {
  put MONGODB-URI team
  printf 'mongodb_uri=local\n' > "$ENV_VAULT_ROOT/apps/ai/.env.local"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  ! grep -q '^MONGODB_URI=' "$(ENV ai)" || false
  grep -qx 'mongodb_uri=local' "$(ENV ai)"
}

@test "pull: 손으로 만든 .env는 .env.bak으로 남기고, 다음 pull이 그 백업을 덮지 않는다" {
  local dir="$ENV_VAULT_ROOT/apps/ai"
  put ANTHROPIC-API-KEY one
  printf 'MINE=1\n' > "$dir/.env"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ] && [[ "$output" == *".env.bak로 남겼습니다"* ]]
  grep -qx 'MINE=1' "$dir/.env.bak"
  put ANTHROPIC-API-KEY two  # 팀원이 값을 바꿈 → 다시 받음: pull이 쓴 .env는 남기지 않음
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  grep -qx 'MINE=1' "$dir/.env.bak"
  grep -qx 'ANTHROPIC_API_KEY=two' "$dir/.env"
  [ "$(ls -A "$dir" | grep -c '^\.env\.bak')" -eq 1 ]
}

@test "pull: .env.bak이 이미 있으면 손으로 만든 .env를 시각 붙인 이름으로 남긴다" {
  local dir="$ENV_VAULT_ROOT/apps/ai"
  put ANTHROPIC-API-KEY one
  printf 'OLD=1\n' > "$dir/.env.bak"
  printf 'MINE=2\n' > "$dir/.env"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  grep -qx 'OLD=1' "$dir/.env.bak"
  grep -qx 'MINE=2' "$dir"/.env.bak.[0-9]*
}

@test "pull: .env로 쓸 수 없는 값은 건너뛰고 알린다" {
  put ANTHROPIC-API-KEY "it's"
  put VOYAGE-API-KEY ok
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *"ANTHROPIC_API_KEY 값에 줄바꿈"* && "$output" == *"건너뜀 1개"* ]]
  ! grep -q '^ANTHROPIC_API_KEY=' "$(ENV ai)" || false
}

@test "pull: 권한이 없거나 로그인하지 않았으면 .env를 바꾸지 않고 실패한다" {
  printf 'MINE=1\n' > "$(ENV ai)"
  AZ_FAIL=1 run bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ] && [[ "$output" == *"az login"* ]]
  [ "$(cat "$(ENV ai)")" = "MINE=1" ]
  [ -z "$(ls -A "$ENV_VAULT_ROOT/apps/ai" | grep pull)" ]  # 임시 파일도 남지 않음
}

@test "pull: 그 앱이 읽는 secret이 하나도 없으면 실패한다" {
  put JWT-ACCESS-SECRET 1
  run bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ] && [[ "$output" == *"apps/ai/.env.production의 변수가 하나도 없습니다"* ]]
  [ ! -e "$(ENV ai)" ]
}

@test "pull: .env.production이 없으면 실패한다" {
  rm "$ENV_VAULT_ROOT/apps/ai/.env.production"
  put ANTHROPIC-API-KEY 1
  run bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ] && [[ "$output" == *"변수 이름을 찾지 못했습니다"* ]]
}

@test "pull: az가 없으면 설치 안내" {
  run env PATH=/nonexistent /bin/bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ] && [[ "$output" == *"Azure CLI(az)가 없습니다"* ]]
}

# ---------- push ----------

@test "push: 표준 입력의 값을 넣고, 값은 az 인자 · 화면에 남지 않는다" {
  run bash -c 'printf "sk-new-value\n" | "$1" push ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$VAULT_DIR/ANTHROPIC-API-KEY")" = "sk-new-value" ]  # 끝 줄바꿈은 뺌
  ! grep -q sk-new-value "$AZ_LOG" || false
  [[ "$output" != *"sk-new-value"* ]]
  [[ "$output" == *"쓰는 앱: ai."* ]]
  grep -q -- '--file' "$AZ_LOG"
}

@test "push: 어느 앱도 읽지 않는 이름이면 알리고 넣는다(새 변수일 수 있음)" {
  run bash -c 'printf v | "$1" push NEW_THING' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"pull이 받지 않습니다"* ]]
  [ "$(cat "$VAULT_DIR/NEW-THING")" = v ]
}

@test "push: PowerShell 파이프처럼 \\r\\n으로 끝나도 \\r을 넣지 않고, 값 가운데 \\r은 거절한다" {
  run bash -c 'printf "sk-x\r\n" | "$1" push ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$VAULT_DIR/ANTHROPIC-API-KEY")" = "sk-x" ]
  run bash -c 'printf "a\rb" | "$1" push VOYAGE_API_KEY' _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$VAULT_DIR/VOYAGE-API-KEY" ]
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

@test "push: 빈 값 · .env로 쓸 수 없는 값은 넣지 않는다" {
  run bash -c 'printf "" | "$1" push APP_ENV' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"값이 비었습니다"* ]]
  run bash -c "printf \"it's\" | \"\$1\" push APP_ENV" _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [ ! -e "$VAULT_DIR/APP-ENV" ]
}

@test "push: 쓰기 권한이 없으면 실패를 알린다" {
  run bash -c 'printf v | AZ_FAIL=1 "$1" push APP_ENV' _ "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"쓰기 권한"* && "$output" == *"팀원 모두 Key Vault Secrets Officer"* ]]
}

# ---------- list ----------

@test "list: 앱을 주면 그 앱이 읽는 이름만, 안 주면 모두와 쓰는 앱을 보여 준다" {
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
  [[ "$output" != *"secret-"* && "$output" != *$'\tb'* ]]  # 값은 보이지 않음
}

@test "list: 해당 secret이 없으면 알리고 성공으로 끝난다" {
  put JWT-ACCESS-SECRET x
  run bash "$SCRIPT" list ai
  [ "$status" -eq 0 ] && [[ "$output" == *"변수가 없습니다"* ]]
}

@test "list: 읽지 못하면 로그인 · 권한 안내와 함께 실패한다" {
  AZ_FAIL=1 run bash "$SCRIPT" list ai
  [ "$status" -ne 0 ] && [[ "$output" == *"az login"* ]]
}

# ---------- 배포 Key Vault(--deploy) ----------

@test "--deploy가 없으면 팀 Key Vault, 있으면 배포 Key Vault를 쓴다" {
  put ANTHROPIC-API-KEY team-value
  printf deploy-value > "$DEPLOY_DIR/ANTHROPIC-API-KEY"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ] && grep -qx 'ANTHROPIC_API_KEY=team-value' "$(ENV ai)"
  run bash "$SCRIPT" pull --deploy ai
  [ "$status" -eq 0 ] && grep -qx 'ANTHROPIC_API_KEY=deploy-value' "$(ENV ai)"
  grep -q "Key Vault 'kv-deploy'에서 받은" "$(ENV ai)"
  run bash -c 'printf v2 | "$1" push --deploy VOYAGE_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ] && [ "$(cat "$DEPLOY_DIR/VOYAGE-API-KEY")" = v2 ]
  [ ! -e "$VAULT_DIR/VOYAGE-API-KEY" ]
  [[ "$output" == *"배포 Key Vault 'kv-deploy'에 저장함"* && "$output" == *"다시 시작하면"* ]]
  run bash -c 'printf v3 | "$1" push VOYAGE_API_KEY' _ "$SCRIPT"
  [[ "$output" == *"팀 Key Vault 'kv-test'에 저장함"* && "$output" == *"pull을 다시"* ]]
  run bash "$SCRIPT" list --deploy
  [ "$output" = $'ANTHROPIC_API_KEY	ai
VOYAGE_API_KEY	ai' ]
}

@test "--deploy: 값을 못 읽는 팀원(Writer)도 이름 보기 · 넣기는 되고, pull은 .env를 바꾸지 않고 실패한다" {
  printf secret > "$DEPLOY_DIR/ANTHROPIC-API-KEY"
  printf 'MINE=1
' > "$(ENV ai)"
  export AZ_NO_READ=kv-deploy
  run bash "$SCRIPT" list --deploy ai
  [ "$status" -eq 0 ] && [ "$output" = $'ANTHROPIC_API_KEY	ai' ]
  run bash -c 'printf new | "$1" push --deploy ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ] && [ "$(cat "$DEPLOY_DIR/ANTHROPIC-API-KEY")" = new ]
  run bash "$SCRIPT" pull --deploy ai
  [ "$status" -ne 0 ] && [[ "$output" == *"완우 · 희재만 읽고"* ]]
  [[ "$output" != *new* ]]
  [ "$(cat "$(ENV ai)")" = "MINE=1" ]
  run bash "$SCRIPT" pull ai  # 팀 Key Vault는 그대로 읽힘(비어 있어 실패하지만 거부가 아님)
  [[ "$output" != *"완우 · 희재만"* ]]
}

@test "--deploy: 사용법" {
  run bash "$SCRIPT" pull --deploy
  [ "$status" -ne 0 ] && [[ "$output" == *"pull [--deploy] <ai|api>"* ]]
  run bash "$SCRIPT" list --deploy ai extra
  [ "$status" -ne 0 ] && [[ "$output" == *"사용법"* ]]
  run bash "$SCRIPT"
  [ "$status" -ne 0 ] && [[ "$output" == *"사용법"* ]]
}
