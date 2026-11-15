#!/usr/bin/env bats
# scripts/env-vault.sh 테스트
#   실행: npx --yes bats@1.13.0 scripts/tests
# 중간 줄의 `! 명령`은 bats에서 실패로 잡히지 않아 `|| false`를 붙입니다.
# az는 가짜 실행 파일(PATH 맨 앞)로 바꿉니다. 가짜 Key Vault는 <secret 이름> 파일 하나가 secret 하나이고,
# <이름>.disabled 파일이 있으면 꺼 둔 secret입니다. 다른 Key Vault 이름이면 실패합니다.
# Key Vault는 kv-test($VAULT_DIR) 하나(개발 · 배포 같은 값, #393)이고 값 읽기(pull)도 됩니다. 받은 인자는 $AZ_LOG에 남깁니다.
# 앱이 쓰는 변수는 가짜 저장소의 apps/<앱>/.env.production(setup에서 만듦)입니다.

setup() {
  TMP="$BATS_TEST_TMPDIR"
  export ENV_VAULT_ROOT="$TMP/repo" NOTELINK_VAULT=kv-test
  export VAULT_DIR="$TMP/vault" AZ_LOG="$TMP/az.log"
  mkdir -p "$ENV_VAULT_ROOT/apps/ai" "$ENV_VAULT_ROOT/apps/api" "$VAULT_DIR" "$TMP/bin"
  cat > "$TMP/bin/az" <<'AZ'
#!/usr/bin/env bash
# 가짜 az: keyvault secret list · set · show
printf '%s\n' "$*" >> "$AZ_LOG"
[ -n "${AZ_FAIL:-}" ] && { echo "ERROR: Forbidden" >&2; exit 1; }
args=("$@"); name=""; file=""; vault=""; query=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --name) name=${args[i+1]} ;;
    --file) file=${args[i+1]} ;;
    --vault-name) vault=${args[i+1]} ;;
    --query) query=${args[i+1]} ;;
  esac
done
case "$vault" in
  kv-test) dir=$VAULT_DIR ;;
  *) echo "ERROR: vault not found" >&2; exit 4 ;;
esac
case "$1 $2 $3" in
  "keyvault secret list")
    for f in "$dir"/*; do
      [ -f "$f" ] || continue
      n=$(basename "$f")
      [[ "$n" == *.disabled ]] && continue
      if [ ! -e "$f.disabled" ]; then printf '%s\r\n' "$n"; fi  # Windows az처럼 \r\n
    done ;;
  "keyvault secret show")
    [ "$name" != "${AZ_FAIL_SHOW:-}" ] || { echo "ERROR: SecretNotFound" >&2; exit 3; }
    [ -f "$dir/$name" ] || { echo "ERROR: SecretNotFound" >&2; exit 3; }
    # 실제 az(knack) tsv처럼: 값은 이스케이프 없이 그대로. [[value,'x']]는 한 줄에 탭으로 이어지고,
    # [value,'x']는 요소마다 한 줄(값\nx). 줄 끝은 Windows az처럼 \r\n(AZ_EOL=lf면 macOS · Linux처럼 \n)
    if [ "${AZ_EOL:-}" = lf ]; then eol=$'\n'; else eol=$'\r\n'; fi
    [ "${AZ_SHAPE:-}" != rows ] || query="[value,'x']"  # 출력 모양이 다른 az
    case "$query" in
      "[[value,'x']]") cat "$dir/$name"; printf '\tx%s' "$eol" ;;
      "[value,'x']") cat "$dir/$name"; printf '%sx%s' "$eol" "$eol" ;;
      value) cat "$dir/$name"; printf '%s' "$eol" ;;
      *) echo "ERROR: unexpected query: $query" >&2; exit 2 ;;
    esac ;;
  "keyvault secret set")
    cp "$file" "$dir/$name"
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

@test "사용법: pull · push · list, 앱 이름은 ai · api만, --team은 없앰(#393)" {
  run bash "$SCRIPT" get ai
  [ "$status" -ne 0 ]
  [[ "$output" == *"사용법"* && "$output" == *"하나에 개발 · 배포 값을 함께"* ]]
  run bash "$SCRIPT" pull
  [ "$status" -ne 0 ]
  [[ "$output" == *"사용법"* ]]
  run bash "$SCRIPT" pull mobile
  [ "$status" -ne 0 ]
  [[ "$output" == *"앱은 ai · api 중 하나"* ]]
  for cmd in "pull --team ai" "push --team APP_ENV" "list --team" "push APP_ENV --team" "--team push APP_ENV"; do
    run bash -c 'printf v | "$1" $2' _ "$SCRIPT" "$cmd"
    [ "$status" -ne 0 ]
    [[ "$output" == *"--team은 없앴습니다"* ]]
  done
  [ -z "$(ls -A "$VAULT_DIR")" ]
  run bash "$SCRIPT" list mobile
  [ "$status" -ne 0 ]
  [[ "$output" == *"앱은 ai · api 중 하나"* ]]
  run bash "$SCRIPT" push
  [ "$status" -ne 0 ]
  [[ "$output" == *"사용법"* ]]
}

@test "변수 이름은 대문자 · 숫자 · _만" {
  run bash -c 'printf x | "$1" push bad-name' _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"변수 이름은"* ]]
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
  [[ "$output" == *"pull을 다시"* ]]
  grep -q -- '--file' "$AZ_LOG"
}

@test "push: 값을 읽지 않고 넣고 바꾼다" {
  put ANTHROPIC-API-KEY old
  run bash -c 'printf new | "$1" push ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "$(cat "$VAULT_DIR/ANTHROPIC-API-KEY")" = new ]
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
  [ "$status" -ne 0 ]
  [[ "$output" == *"줄바꿈"* ]]
  [ "$(cat "$VAULT_DIR/JWT-ACCESS-SECRET")" = old ]
  run bash -c 'printf "secret\r\n\r\n" | "$1" push JWT_ACCESS_SECRET' _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [ "$(cat "$VAULT_DIR/JWT-ACCESS-SECRET")" = old ]
}

@test "push: 따옴표 · 역슬래시 같은 문자는 그대로 넣고(배포 앱은 그대로 읽음), pull이 건너뛸 값임을 알린다" {
  printf '%s' "it's a\\b" > "$TMP/value"
  run bash -c '"$1" push APP_ENV < "$2"' _ "$SCRIPT" "$TMP/value"
  [ "$status" -eq 0 ]
  [ "$(cat "$VAULT_DIR/APP-ENV")" = "it's a\\b" ]
  [[ "$output" == *"pull은 이 값을 건너뜁니다"* && "$output" == *".env.local에 직접"* ]]
  run bash -c 'printf plain | "$1" push APP_ENV' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" != *"건너뜁니다"* ]]
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
  [ "$status" -ne 0 ]
  [[ "$output" == *"값이 비었습니다"* ]]
  [ ! -e "$VAULT_DIR/APP-ENV" ]
}

@test "push: 쓰기 권한이 없으면 역할 안내와 함께 실패한다" {
  run bash -c 'printf v | AZ_FAIL=1 "$1" push APP_ENV' _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"팀원 모두 값 보기 · 넣기 권한"* ]]
}

@test "push: az가 없으면 설치 안내" {
  run bash -c 'printf v | PATH=/nonexistent "$BASH" "$1" push APP_ENV' _ "$SCRIPT"
  [ "$status" -ne 0 ]
  [[ "$output" == *"Azure CLI"* ]]
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
  [ "$status" -eq 0 ]
  [[ "$output" == *"변수가 없습니다"* ]]
}

@test "list: 읽지 못하면 로그인 · 권한 안내와 함께 실패한다" {
  AZ_FAIL=1 run bash "$SCRIPT" list ai
  [ "$status" -ne 0 ]
  [[ "$output" == *"az login"* && "$output" == *"Secrets Officer"* ]]
}

# ---------- pull ----------

@test "pull: 배포와 같은 Key Vault에서 그 앱이 쓰는 이름만 받아 .env를 만들고, 값은 화면에 찍지 않는다" {
  put ANTHROPIC-API-KEY sk-dev-1
  put MONGODB-URI 'mongodb+srv://u:p@c.mongodb.net/?retryWrites=true&w=majority'
  put JWT-ACCESS-SECRET api-only
  put APP-ENV 'local dev'
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  env="$ENV_VAULT_ROOT/apps/ai/.env"
  head -n 1 "$env" | grep -q "^# scripts/env-vault.sh pull ai "
  grep -qxF 'ANTHROPIC_API_KEY=sk-dev-1' "$env"
  grep -qxF 'MONGODB_URI=mongodb+srv://u:p@c.mongodb.net/?retryWrites=true&w=majority' "$env"
  grep -qxF "APP_ENV='local dev'" "$env"
  ! grep -q JWT_ACCESS_SECRET "$env" || false  # api만 쓰는 이름
  ! grep -q $'\r' "$env" || false
  [[ "$output" == *"Key Vault에서 3개"* && "$output" == *"배포와 같은 값"* ]]
  [[ "$output" != *sk-dev-1* && "$output" != *"u:p@"* ]]
  grep -q -- "--vault-name kv-test" "$AZ_LOG"
}

@test "예전 NOTELINK_TEAM_VAULT가 남아 있으면 배포 값을 받거나 넣지 않고 멈춘다" {
  put ANTHROPIC-API-KEY deploy-key
  for cmd in "pull ai" "push APP_ENV" "list"; do
    run bash -c 'printf v | NOTELINK_TEAM_VAULT=kv-notelink-team "$1" $2' _ "$SCRIPT" "$cmd"
    [ "$status" -ne 0 ]
    [[ "$output" == *"NOTELINK_TEAM_VAULT는 없앴습니다"* ]]
  done
  [ ! -e "$ENV_VAULT_ROOT/apps/ai/.env" ]
  [ ! -e "$VAULT_DIR/APP-ENV" ]
  [ ! -s "$AZ_LOG" ]
}

@test "push로 넣은 값을 pull이 그대로 받는다(Key Vault 하나)" {
  run bash -c 'printf "sk-shared" | "$1" push ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  grep -qxF 'ANTHROPIC_API_KEY=sk-shared' "$ENV_VAULT_ROOT/apps/ai/.env"
}

@test "pull: '로컬:' 줄이 있는 변수는 배포 값을 읽지 않고 로컬 값을 쓰고, .env.local이 있으면 그것이 이긴다" {
  # 실제 .env.production처럼: 배포 값 줄 아래 '# 로컬:' 줄(Key Vault에 없는 변수도)
  printf '# 로컬: APP_ENV=development\n# 로컬: MONGODB_URI=mongodb://127.0.0.1:27017\n' \
    >> "$ENV_VAULT_ROOT/apps/ai/.env.production"
  put MONGODB-URI 'mongodb+srv://prod-user:prod-pass@prod.mongodb.net/'
  put APP-ENV production
  put ANTHROPIC-API-KEY sk-deploy
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  env="$ENV_VAULT_ROOT/apps/ai/.env"
  grep -qxF 'MONGODB_URI=mongodb://127.0.0.1:27017' "$env"
  grep -qxF 'APP_ENV=development' "$env"
  grep -qxF 'LOCAL_ONLY=mongodb://127.0.0.1:27017' "$env"  # Key Vault에 없어도
  grep -qxF 'ANTHROPIC_API_KEY=sk-deploy' "$env"  # 키는 배포 값
  ! grep -q -e prod-pass -e '=production' "$env" || false
  ! grep -q 'show.*MONGODB-URI' "$AZ_LOG" || false  # 배포 DB 주소는 읽지도 않음
  [[ "$output" == *"Key Vault에서 1개, 로컬 기본값 3개"* ]]
  [[ "$output" == *"APP_ENV · LOCAL_ONLY · MONGODB_URI"* && "$output" == *".env.local에 넣으세요"* ]]
  # 배포 DB를 쓰려면 .env.local에
  printf 'MONGODB_URI=mongodb+srv://mine/\n' > "$ENV_VAULT_ROOT/apps/ai/.env.local"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  ! grep -qxF 'MONGODB_URI=mongodb://127.0.0.1:27017' "$env" || false
  grep -qxF 'MONGODB_URI=mongodb+srv://mine/' "$env"
  [[ "$output" == *"로컬 기본값 2개, .env.local이 1개 덮어씀"* ]]
}

@test "pull api: .env.local의 소문자 이름은 덮지 않는다(NestJS는 대소문자를 가림), 같은 이름은 덮는다" {
  put MONGODB-URI vault-uri
  put JWT-ACCESS-SECRET vault-jwt
  printf 'mongodb_uri=mine\nJWT_ACCESS_SECRET=my-jwt\n' > "$ENV_VAULT_ROOT/apps/api/.env.local"
  run bash "$SCRIPT" pull api
  [ "$status" -eq 0 ]
  env="$ENV_VAULT_ROOT/apps/api/.env"
  grep -qxF 'MONGODB_URI=vault-uri' "$env"
  grep -qxF 'mongodb_uri=mine' "$env"
  ! grep -q vault-jwt "$env" || false
  grep -qxF 'JWT_ACCESS_SECRET=my-jwt' "$env"
  [[ "$output" == *"Key Vault에서 1개, 로컬 기본값 0개, .env.local이 1개 덮어씀"* ]]
}

@test "pull: 값의 \\r · 끝 줄바꿈은 az 줄 끝이 \\r\\n이든 \\n이든 줄이지 않고 건너뛴다" {
  put APP-ENV 'dev x'
  printf 'a\rb' > "$VAULT_DIR/ANTHROPIC-API-KEY"
  printf 'v\r' > "$VAULT_DIR/VOYAGE-API-KEY"
  printf 'm\n' > "$VAULT_DIR/MONGODB-URI"
  for eol in crlf lf; do
    AZ_EOL=$eol run bash "$SCRIPT" pull ai
    [ "$status" -eq 0 ]
    env="$ENV_VAULT_ROOT/apps/ai/.env"
    grep -qxF "APP_ENV='dev x'" "$env"
    ! grep -q -e ANTHROPIC -e VOYAGE -e MONGODB "$env" || false
    [[ "$output" == *"건너뜀 3개"* ]]
  done
  grep -q "\[\[value,'x'\]\]" "$AZ_LOG"
}

@test "pull: az 출력 모양이 다르면 권한이 아니라 출력 모양을 알리고 .env는 그대로 둔다" {
  put APP-ENV dev
  dir="$ENV_VAULT_ROOT/apps/ai"
  printf 'MY_HAND=1\n' > "$dir/.env"
  # 다른 버전의 az가 [[value,'x']]를 요소마다 한 줄로 낸다고 침(값\nx)
  AZ_SHAPE=rows run bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ]
  [[ "$output" == *"az 출력 모양이 예상과 다릅니다"* && "$output" != *"권한"* ]]
  [ "$(cat "$dir/.env")" = MY_HAND=1 ]
}

@test "pull · push: ai가 쓰는 값의 \${…}는 python-dotenv가 바꾸므로 거르고, api만 쓰는 값 · \$ · 닫히지 않은 \${는 그대로" {
  put ANTHROPIC-API-KEY 'abc${UNSET}def'
  put VOYAGE-API-KEY 'p$q'
  put APP-ENV 'ab${cd'  # 닫는 }가 없으면 python-dotenv도 그대로 읽음
  put QUIZ-GEN-MODEL 'x${}y'  # 빈 ${}도 바뀜(→ xy)
  put JWT-ACCESS-SECRET 'j${X}k'
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  env="$ENV_VAULT_ROOT/apps/ai/.env"
  ! grep -q -e ANTHROPIC -e QUIZ_GEN_MODEL "$env" || false
  grep -qxF "VOYAGE_API_KEY='p\$q'" "$env"
  grep -qxF "APP_ENV='ab\${cd'" "$env"
  [[ "$output" == *"ANTHROPIC_API_KEY 값에"*'${…}가 있어 건너뜀'* ]]
  [[ "$output" == *"셸 환경 변수로 넘기세요"* && "$output" != *".env.local에 직접 넣으세요"* ]]  # .env.local은 안 됨
  [[ "$output" == *"건너뜀 2개"* ]]
  printf 'MY_TOKEN=a${B}c\n' > "$ENV_VAULT_ROOT/apps/ai/.env.local"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *'apps/ai/.env.local의 값에 ${…}가 있어'* ]]
  printf '# MY_TOKEN=a${B}c\nMY_TOKEN=ab${c\n' > "$ENV_VAULT_ROOT/apps/ai/.env.local"  # 주석 · 닫히지 않음
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" != *'.env.local의 값에'* ]]
  printf 'MY_TOKEN=a${B}c\n' > "$ENV_VAULT_ROOT/apps/api/.env.local"
  rm "$ENV_VAULT_ROOT/apps/ai/.env.local"
  run bash "$SCRIPT" pull api
  [ "$status" -eq 0 ]
  [[ "$output" != *'.env.local의 값에'* ]]  # api는 바꾸지 않음
  rm "$ENV_VAULT_ROOT/apps/api/.env.local"
  run bash "$SCRIPT" pull api
  [ "$status" -eq 0 ]
  grep -qxF "JWT_ACCESS_SECRET='j\${X}k'" "$ENV_VAULT_ROOT/apps/api/.env"
  # push는 배포 앱이 그대로 읽으므로 넣되, ai 값이면 pull이 건너뛴다고 알림
  printf '%s' 'x${HOME}' > "$TMP/brace"
  run bash -c '"$1" push APP_ENV < "$2"' _ "$SCRIPT" "$TMP/brace"
  [ "$status" -eq 0 ]
  [[ "$output" == *'ai가 쓰는 값에 ${…}가 있어 pull은 이 값을 건너뜁니다'* && "$output" == *"셸 환경 변수로 넘기세요"* ]]
  [ "$(cat "$VAULT_DIR/APP-ENV")" = 'x${HOME}' ]
  run bash -c '"$1" push JWT_ACCESS_SECRET < "$2"' _ "$SCRIPT" "$TMP/brace"
  [ "$status" -eq 0 ]
  [[ "$output" != *"건너뜁니다"* ]]  # api만 쓰는 값
  [ "$(cat "$VAULT_DIR/JWT-ACCESS-SECRET")" = 'x${HOME}' ]
}

@test "pull: .env.local의 값이 이긴다(이름 대소문자 무시) — 덮인 값은 Key Vault에서 읽지도 않는다" {
  put ANTHROPIC-API-KEY vault-key
  put VOYAGE-API-KEY vault-voyage
  printf 'anthropic_api_key=my-own\r\nexport EXTRA=1\r\n' > "$ENV_VAULT_ROOT/apps/ai/.env.local"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  env="$ENV_VAULT_ROOT/apps/ai/.env"
  ! grep -q vault-key "$env" || false
  grep -qxF 'anthropic_api_key=my-own' "$env"
  grep -qxF 'VOYAGE_API_KEY=vault-voyage' "$env"
  grep -qxF 'export EXTRA=1' "$env"
  ! grep -q $'\r' "$env" || false
  ! grep -q 'show.*ANTHROPIC-API-KEY' "$AZ_LOG" || false
  [[ "$output" == *"Key Vault에서 1개, 로컬 기본값 1개, .env.local이 1개 덮어씀"* ]]  # 로컬 기본값: LOCAL_ONLY
}

@test "pull: 손으로 만든 .env는 .env.bak(덮지 않음), pull이 만든 .env는 .env.prev로 남긴다" {
  put APP-ENV dev
  dir="$ENV_VAULT_ROOT/apps/ai"
  printf 'MY_HAND=1\n' > "$dir/.env"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *".env.bak로 남겼습니다"* ]]
  grep -qxF 'MY_HAND=1' "$dir/.env.bak"
  printf 'EDITED_AFTER_PULL=1\n' >> "$dir/.env"  # 받은 뒤 .env에 직접 고침
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *".env.prev로 남겼습니다"* ]]
  grep -qxF 'EDITED_AFTER_PULL=1' "$dir/.env.prev"
  [ "$(ls -A "$dir" | grep -c '^\.env\.bak')" -eq 1 ]
  printf 'MY_HAND=2\n' > "$dir/.env"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  grep -qxF 'MY_HAND=1' "$dir/.env.bak"  # 앞의 백업을 덮지 않음
  [ "$(ls -A "$dir" | grep -c '^\.env\.bak\.')" -eq 1 ]
}

@test "pull: 같은 초에 손으로 만든 .env를 또 남겨도 앞의 시각 백업을 덮지 않는다" {
  put APP-ENV dev
  dir="$ENV_VAULT_ROOT/apps/ai"
  # 늘 같은 시각. 형식이 바뀌면 실패(가짜가 시각 형식 변경을 가리지 않게)
  printf '#!/usr/bin/env bash\n[ "$1" = +%%Y%%m%%d%%H%%M%%S ] || exit 9\necho 20261114010203\n' > "$TMP/bin/date"
  chmod +x "$TMP/bin/date"
  printf 'FIRST=1\n' > "$dir/.env.bak"
  printf 'SAME_SECOND=1\n' > "$dir/.env.bak.20261114010203"
  printf 'MY_HAND=1\n' > "$dir/.env"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" == *".env.bak.20261114010203.1로 남겼습니다"* ]]
  printf 'MY_HAND=2\n' > "$dir/.env"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [ "$(cat "$dir/.env.bak")" = FIRST=1 ]
  [ "$(cat "$dir/.env.bak.20261114010203")" = SAME_SECOND=1 ]
  [ "$(cat "$dir/.env.bak.20261114010203.1")" = MY_HAND=1 ]
  [ "$(cat "$dir/.env.bak.20261114010203.2")" = MY_HAND=2 ]
}

@test "pull: 백업 이름이 끊어진 링크면 따라가 쓰지 않고 다음 이름을 쓴다" {
  dir="$ENV_VAULT_ROOT/apps/ai"
  ln -s "$TMP/outside" "$dir/.env.bak" 2> /dev/null || true
  [ -L "$dir/.env.bak" ] || skip "심볼릭 링크를 만들 수 없음(Windows Git Bash)"
  put APP-ENV dev
  printf 'MY_HAND=1\n' > "$dir/.env"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [ ! -e "$TMP/outside" ]
  [ "$(cat "$dir"/.env.bak.*)" = MY_HAND=1 ]
}

@test "pull: 꺼 둔 secret은 받지 않고, .env로 쓸 수 없는 값은 건너뛴다" {
  put APP-ENV dev
  put ANTHROPIC-API-KEY off
  : > "$VAULT_DIR/ANTHROPIC-API-KEY.disabled"
  put VOYAGE-API-KEY "it's"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  env="$ENV_VAULT_ROOT/apps/ai/.env"
  grep -qxF 'APP_ENV=dev' "$env"
  ! grep -q ANTHROPIC "$env" || false
  ! grep -q VOYAGE "$env" || false
  [[ "$output" == *"VOYAGE_API_KEY 값에"*"건너뜀"* && "$output" == *"건너뜀 1개"* ]]
}

@test "pull: 실패하면 임시 파일을 남기지 않고 있던 .env도 그대로 둔다" {
  dir="$ENV_VAULT_ROOT/apps/ai"
  printf 'MY_HAND=1\n' > "$dir/.env"
  AZ_FAIL=1 run bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ]
  [[ "$output" == *"팀원 모두 값 보기 · 넣기 권한"* ]]
  [ "$(cat "$dir/.env")" = MY_HAND=1 ]
  [ -z "$(ls -A "$dir" | grep -E '^\.env\.(pull|bak)' || true)" ]
}

@test "pull: 값을 받다가 중간에 실패해도 임시 파일(받은 값)을 남기지 않고 있던 .env도 그대로 둔다" {
  put ANTHROPIC-API-KEY sk-got-before-fail
  put VOYAGE-API-KEY v
  dir="$ENV_VAULT_ROOT/apps/ai"
  printf 'MY_HAND=1\n' > "$dir/.env"
  AZ_FAIL_SHOW=VOYAGE-API-KEY run bash "$SCRIPT" pull ai
  [ "$status" -ne 0 ]
  [[ "$output" == *"VOYAGE-API-KEY'의 값을 읽지 못했습니다(.env는 그대로, 위 az 오류 참고)"* ]]
  [ "$(cat "$dir/.env")" = MY_HAND=1 ]
  [ -z "$(ls -A "$dir" | grep -E '^\.env\.(pull|bak)' || true)" ]
  ! grep -rq sk-got-before-fail "$dir" || false
}

# ---------- '로컬:' 기본값 · 예전 설정 ----------

@test "push: '로컬:' 값이 있는 변수는 팀원 로컬이 아니라 배포 앱만 바뀐다고 알린다" {
  printf '# 로컬: MONGODB_URI=mongodb://127.0.0.1:27017\n' >> "$ENV_VAULT_ROOT/apps/ai/.env.production"
  run bash -c 'printf "mongodb://localhost/x" | "$1" push MONGODB_URI' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"MONGODB_URI는 ai의 pull이 '로컬:' 값을 쓰므로"*"배포 앱만 바꿉니다"* ]]
  [[ "$output" == *"팀원 로컬은 '로컬:' 값 그대로"* && "$output" != *"팀원은 pull을 다시"* ]]
  run bash -c 'printf "sk-x" | "$1" push ANTHROPIC_API_KEY' _ "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" != *"배포 앱만 바꿉니다"* && "$output" == *"팀원은 pull을 다시"* ]]
}

@test "list: pull이 '로컬:' 값을 쓰는 변수를 표시한다" {
  printf '# 로컬: MONGODB_URI=mongodb://127.0.0.1:27017\n' >> "$ENV_VAULT_ROOT/apps/ai/.env.production"
  put MONGODB-URI a
  put VOYAGE-API-KEY b
  run bash "$SCRIPT" list ai
  [ "$status" -eq 0 ]
  [ "$output" = $'MONGODB_URI\tai api\t(pull은 로컬: 값 — ai)\nVOYAGE_API_KEY\tai' ]
}

@test "pull: '로컬:' 값도 .env로 그대로 쓸 수 없으면 건너뛰고, Key Vault에 없는 기본 변수 이름을 알린다" {
  printf "# 로컬: APP_ENV=it's\n" >> "$ENV_VAULT_ROOT/apps/ai/.env.production"
  put ANTHROPIC-API-KEY sk
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  env="$ENV_VAULT_ROOT/apps/ai/.env"
  ! grep -q '^APP_ENV' "$env" || false
  [[ "$output" == *"'로컬: APP_ENV' 값을 .env로 그대로 쓸 수 없어 건너뜀"* ]]
  # 기본 변수(주석이 아닌 줄) 중 Key Vault에도 .env.local에도 없는 것. 주석으로 둔 선택 항목(QUIZ_GEN_MODEL)은 뺌
  [[ "$output" == *"Key Vault에 없어 .env에 넣지 않음: MONGODB_URI · VOYAGE_API_KEY"* ]]
  [[ "$output" != *"QUIZ_GEN_MODEL"* ]]
  printf 'VOYAGE_API_KEY=mine\nMONGODB_URI=m\n' > "$ENV_VAULT_ROOT/apps/ai/.env.local"
  run bash "$SCRIPT" pull ai
  [ "$status" -eq 0 ]
  [[ "$output" != *"넣지 않음"* ]]
}

@test "NOTELINK_VAULT가 없앤 팀 Key Vault(kv-notelink-team)면 멈춘다" {
  for v in kv-notelink-team KV-NoteLink-Team; do
    NOTELINK_VAULT=$v run bash "$SCRIPT" list
    [ "$status" -ne 0 ]
    [[ "$output" == *"kv-notelink-team은 없앴습니다"* ]]
  done
  [ ! -s "$AZ_LOG" ]
}
