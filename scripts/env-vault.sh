#!/usr/bin/env bash
# 팀 개발용 .env를 Azure Key Vault 하나에서 받고 올립니다(#326).
#
#   scripts/env-vault.sh pull <ai|api>   # Key Vault → apps/<앱>/.env
#   scripts/env-vault.sh push <변수>      # 값 하나를 Key Vault에 넣거나 바꿈(값은 표준 입력)
#   scripts/env-vault.sh list [ai|api]   # Key Vault에 있는 변수 이름만(값은 보이지 않음)
#
# - 먼저 Azure CLI를 설치하고 팀 디렉터리 계정으로 로그인합니다: az login --tenant <팀 테넌트 ID>
#   권한은 Key Vault 역할로 정합니다. 읽기 · 쓰기(Key Vault Secrets Officer): 완우 · 희재,
#   읽기(Key Vault Secrets User): 나머지. 팀 키 하나를 나눠 갖지 않고 각자 계정으로 엽니다.
# - Key Vault 이름은 NOTELINK_VAULT(기본 kv-notelink-dev).
# - secret 이름은 변수 이름에서 _만 -로 바꾼 것입니다(Key Vault 이름에는 _를 쓸 수 없음):
#   ANTHROPIC-API-KEY ↔ ANTHROPIC_API_KEY. 배포(App Service)의 Key Vault 참조와 같은 secret을 씁니다.
#   꺼 둔(disabled) secret은 받지 않습니다.
# - 앱마다 받을 변수는 그 앱의 apps/<앱>/.env.production에 적힌 이름입니다(주석으로 둔 선택 항목
#   "# 이름=" 포함, "# 로컬: 이름=" 줄은 제외). 그 목록에 없는 secret은 받지 않습니다.
# - pull: 사람마다 다른 값(개인 키 · 로컬 주소 · 로컬 DB)은 커밋하지 않는 apps/<앱>/.env.local에 두면
#   받은 값 위에 덮어씁니다(이름 대소문자 무시). 손으로 만든 .env는 .env.bak으로 남깁니다(.env.*는
#   .gitignore). 값은 화면에 찍지 않고 개수만 알립니다.
# - push: 값은 명령줄 인자로 받지 않습니다(셸 기록 · 프로세스 목록에 남지 않게). 터미널이면 보이지 않게
#   입력받고, 아니면 표준 입력 전체를 씁니다: printf '%s' "$VALUE" | scripts/env-vault.sh push X
#   az에도 값을 인자가 아닌 임시 파일(--file, 권한 600)로 넘기고 바로 지웁니다.
# - 모바일(EXPO_PUBLIC_*)은 비밀값이 없어 다루지 않습니다.
#
# 테스트: scripts/tests/env-vault.bats (source하면 main은 실행되지 않습니다)

VAULT="${NOTELINK_VAULT:-kv-notelink-dev}"
ROOT="${ENV_VAULT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APPS="ai api"
VAR_RE='^[A-Z][A-Z0-9_]*$'

die() { echo "env-vault: $*" >&2; exit 1; }

check_app() {  # $1 = 앱 이름
  case " $APPS " in
    *" $1 "*) ;;
    *) die "앱은 ${APPS// / · } 중 하나입니다: '${1:-}'" ;;
  esac
}

check_var() {  # $1 = 변수 이름(대문자 · 숫자 · _)
  [[ "${1:-}" =~ $VAR_RE ]] || die "변수 이름은 대문자 · 숫자 · _만 씁니다: '${1:-}'"
}

secret_name() { printf '%s' "${1//_/-}"; }  # ANTHROPIC_API_KEY → ANTHROPIC-API-KEY
var_name() { printf '%s' "${1//-/_}"; }     # ANTHROPIC-API-KEY → ANTHROPIC_API_KEY

# 그 앱이 읽는 변수 이름(한 줄에 하나, 정렬): apps/<앱>/.env.production의 "이름=" · "# 이름=" 줄
app_vars() {  # $1 = 앱
  local file="$ROOT/apps/$1/.env.production"
  [ -f "$file" ] || return 0
  sed -nE 's/^#?[[:space:]]*([A-Z][A-Z0-9_]*)=.*/\1/p' "$file" | tr -d '\r' | sort -u
}

# 이 변수를 읽는 앱(공백으로 나눔). 없으면 빈 값
apps_of() {  # $1 = 변수
  local app out=""
  for app in $APPS; do
    if app_vars "$app" | grep -qxF "$1"; then out+="${out:+ }$app"; fi
  done
  printf '%s' "$out"
}

need_az() {
  command -v az > /dev/null || die "Azure CLI(az)가 없습니다. 설치: https://learn.microsoft.com/cli/azure/install-azure-cli"
}

# Windows의 az는 줄 끝에 \r을 붙임. az가 실패하면 실패로(파이프 뒤 tr의 성공으로 가리지 않게)
az_out() {
  local out
  out=$(az "$@") || return 1
  printf '%s\n' "$out" | tr -d '\r'
}

# 켜 둔 secret의 변수 이름(한 줄에 하나, 정렬). 이름 규칙에 맞지 않는 secret은 알리고 뺌.
# 읽지 못하면 로그인 · 권한 안내와 함께 끝냄
vault_vars() {
  local names name var
  names=$(az_out keyvault secret list --vault-name "$VAULT" \
    --query "[?attributes.enabled].name" -o tsv) \
    || die "Key Vault '$VAULT'를 읽지 못했습니다. az login(팀 디렉터리)과 읽기 권한(Key Vault Secrets User)을 확인하세요"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    var=$(var_name "$name")
    if [[ "$var" =~ $VAR_RE ]]; then
      echo "$var"
    else
      echo "env-vault: 이름이 규칙에 맞지 않아 쓰지 않음: $name" >&2
    fi
  done <<< "$names" | sort -u
}

# .env 한 줄: 특수 문자가 없으면 그대로, 있으면 작은따옴표. 작은따옴표 · 역슬래시 · 줄바꿈은 dotenv마다
# 읽는 법이 달라(python-dotenv는 작은따옴표 안의 \\ · \'를 풀고 Node dotenv는 그대로 둠) 거절
env_line() {  # $1 = 변수, $2 = 값
  local value=$2
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *"'"* || "$value" == *\\* ]]; then
    return 1
  fi
  if [[ "$value" =~ ^[A-Za-z0-9_./:@+=,%?\&-]*$ ]]; then
    printf '%s=%s\n' "$1" "$value"
  else
    printf "%s='%s'\n" "$1" "$value"
  fi
}

# .env.local에서 정한 변수 이름(주석 · 빈 줄 제외, export 붙은 줄도)
local_keys() {  # $1 = .env.local 경로
  [ -f "$1" ] || return 0
  sed -nE 's/^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\2/p' "$1" | tr -d '\r'
}

pull() {  # $1 = 앱
  local app=$1 dir env local_file tmp wanted have var value count=0 skipped=0 overridden=0
  check_app "$app"
  need_az
  dir="$ROOT/apps/$app"
  env="$dir/.env"
  local_file="$dir/.env.local"
  [ -d "$dir" ] || die "$dir 폴더가 없습니다"
  wanted=$(app_vars "$app")
  [ -n "$wanted" ] || die "apps/$app/.env.production에서 변수 이름을 찾지 못했습니다"
  have=$(vault_vars)
  # 이 앱이 읽는 이름 중 Key Vault에 있는 것(macOS 기본 bash 3.2라 연관 배열 대신 grep)
  have=$(grep -xF -f <(printf '%s\n' "$wanted") <<< "$have" || true)
  [ -n "$have" ] || die "Key Vault '$VAULT'에 apps/$app/.env.production의 변수가 하나도 없습니다"
  local local_set  # .env.local이 정한 이름(한 줄에 하나)
  local_set=$(local_keys "$local_file")

  tmp=$(umask 077 && mktemp "$dir/.env.pull.XXXXXX") || die "임시 파일을 만들지 못했습니다"
  trap 'rm -f "$tmp"' EXIT
  {
    echo "# scripts/env-vault.sh pull $app 로 Key Vault '$VAULT'에서 받은 값입니다. 커밋하지 않습니다."
    echo "# 내 값으로 바꿀 것은 이 파일이 아니라 apps/$app/.env.local에 두고, 고친 뒤 pull을 다시 합니다(앱은 .env만 읽음)."
  } > "$tmp"
  while IFS= read -r var; do
    # pydantic-settings는 이름의 대소문자를 가리지 않으므로 mongodb_uri도 MONGODB_URI를 덮은 것으로 봄
    if [ -n "$local_set" ] && grep -qixF "$var" <<< "$local_set"; then
      overridden=$((overridden + 1)); continue
    fi
    value=$(az_out keyvault secret show --vault-name "$VAULT" --name "$(secret_name "$var")" \
      --query value -o tsv) || die "'$(secret_name "$var")'을 읽지 못했습니다"
    if ! env_line "$var" "$value" >> "$tmp"; then
      echo "env-vault: $var 값에 줄바꿈 · 작은따옴표 · 역슬래시가 있어 건너뜀(.env.local에 직접 넣으세요)" >&2
      skipped=$((skipped + 1)); continue
    fi
    count=$((count + 1))
  done <<< "$have"
  if [ -f "$local_file" ]; then
    { echo; echo "# apps/$app/.env.local"; tr -d '\r' < "$local_file"; echo; } >> "$tmp"
  fi
  # 손으로 만든 .env(pull이 쓴 머리말이 없음)만 남김: pull이 쓴 것은 다시 받으면 되므로 남기지 않아,
  # 손으로 만든 백업이 다음 pull에 덮이지 않음. 이미 .env.bak이 있으면 시각을 붙인 새 이름으로
  if [ -f "$env" ] && ! head -n 1 "$env" | grep -q '^# scripts/env-vault.sh pull '; then
    local bak="$dir/.env.bak"
    [ -e "$bak" ] && bak="$dir/.env.bak.$(date +%Y%m%d%H%M%S)"
    (umask 077 && cp "$env" "$bak") || die "있던 .env를 ${bak##*/}로 남기지 못했습니다"
    echo "있던 .env를 apps/$app/${bak##*/}로 남겼습니다"
  fi
  mv "$tmp" "$env" || die "$env를 쓰지 못했습니다"
  trap - EXIT
  echo "apps/$app/.env: Key Vault에서 ${count}개, .env.local이 ${overridden}개 덮어씀, 건너뜀 ${skipped}개"
  echo "Key Vault에 없는 값(로컬 DB 주소 등)은 apps/$app/.env.local에 둡니다(apps/$app/.env.production의 '로컬:' 줄 참고)"
}

read_value() {  # 터미널이면 보이지 않게 한 줄, 아니면 표준 입력 전체(끝 줄바꿈 하나만 뺌: \n · \r\n)
  local v
  if [ -t 0 ]; then
    IFS= read -rs -p "값(보이지 않음): " v; echo >&2
  else
    v=$(cat; printf x)
    v=${v%x}
    v=${v%$'\n'}
  fi
  printf '%s' "${v%$'\r'}"  # PowerShell 파이프 · Windows 편집기의 \r\n
}

push() {  # $1 = 변수
  local var=$1 value tmp users
  check_var "$var"
  need_az
  users=$(apps_of "$var")
  [ -n "$users" ] \
    || echo "env-vault: $var는 ai · api의 .env.production에 없어 pull이 받지 않습니다(이름을 확인하세요)" >&2
  value=$(read_value)
  [ -n "$value" ] || die "값이 비었습니다"
  env_line "$var" "$value" > /dev/null \
    || die "값에 줄바꿈(\\r 포함) · 작은따옴표 · 역슬래시가 있으면 .env로 받을 수 없습니다"
  tmp=$(umask 077 && mktemp) || die "임시 파일을 만들지 못했습니다"
  trap 'rm -f "$tmp"' EXIT
  printf '%s' "$value" > "$tmp"
  az keyvault secret set --vault-name "$VAULT" --name "$(secret_name "$var")" \
    --file "$tmp" --encoding utf-8 --output none \
    || die "Key Vault '$VAULT'에 쓰지 못했습니다. 쓰기 권한(Key Vault Secrets Officer)을 확인하세요"
  rm -f "$tmp"
  trap - EXIT
  echo "$(secret_name "$var") 저장함.${users:+ 쓰는 앱: ${users// / · }.} 팀원은 pull을 다시 하고," \
    "배포 앱의 Key Vault 참조는 앱을 다시 시작하면(아니면 24시간 안에) 새 값을 씁니다"
}

list() {  # $1 = 앱(없으면 모두). 이름과 그 이름을 읽는 앱
  local app=${1:-} have var users
  [ -z "$app" ] || check_app "$app"
  need_az
  have=$(vault_vars)
  if [ -n "$app" ]; then
    have=$(grep -xF -f <(app_vars "$app") <<< "$have" || true)
  fi
  if [ -z "$have" ]; then
    echo "Key Vault '$VAULT'에 ${app:+apps/$app/.env.production의 }변수가 없습니다" >&2
    return 0
  fi
  while IFS= read -r var; do
    users=$(apps_of "$var")
    printf '%s\t%s\n' "$var" "${users:-(쓰는 앱 없음)}"
  done <<< "$have"
}

main() {
  case "${1:-}" in
    pull) [ $# -eq 2 ] || die "사용법: $0 pull <ai|api>"; pull "$2" ;;
    push) [ $# -eq 2 ] || die "사용법: $0 push <변수>"; push "$2" ;;
    list) [ $# -le 2 ] || die "사용법: $0 list [ai|api]"; list "${2:-}" ;;
    *) die "사용법: $0 pull <ai|api> · $0 push <변수> · $0 list [ai|api]" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  main "$@"
fi
