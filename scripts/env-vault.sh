#!/usr/bin/env bash
# 배포용 비밀값을 Azure Key Vault에 넣고, 어떤 값이 있는지 이름을 봅니다(#326).
#
#   scripts/env-vault.sh push <변수>      # 값 하나를 넣거나 바꿈(값은 표준 입력)
#   scripts/env-vault.sh list [ai|api]   # 변수 이름과 그 이름을 쓰는 앱(값은 보이지 않음)
#
# - 로컬 개발용 키는 각자 apps/<앱>/.env에 둡니다(커밋하지 않음). Key Vault에는 배포용 키만 둡니다.
# - 배포 App Service가 같은 secret을 Key Vault 참조로 읽습니다. 바꾼 값은 앱을 다시 시작하면
#   (아니면 24시간 안에) 씁니다.
# - 권한은 각자 Azure 계정의 Key Vault 역할로 정합니다(팀 키 하나를 나눠 갖지 않음).
#   값 보기 · 쓰기(Key Vault Secrets Officer): 완우 · 희재
#   이름 보기 · 넣기(사용자 지정 역할 NoteLink Secrets Writer, 값 읽기 없음): 나머지 팀원
#   이 스크립트는 값을 읽지 않으므로 누구나 같은 명령을 씁니다.
# - 먼저 Azure CLI를 설치하고 팀 디렉터리 계정으로 로그인합니다: az login --tenant <팀 테넌트 ID>
# - Key Vault 이름은 NOTELINK_VAULT(기본 kv-notelink-dev).
# - secret 이름은 변수 이름에서 _만 -로 바꾼 것입니다(Key Vault 이름에는 _를 쓸 수 없음):
#   ANTHROPIC-API-KEY ↔ ANTHROPIC_API_KEY. 꺼 둔(disabled) secret은 list에 보이지 않습니다.
# - 앱이 쓰는 변수는 apps/<앱>/.env.production에 적힌 이름입니다(주석으로 둔 선택 항목 "# 이름=" 포함,
#   "# 로컬: 이름=" 줄은 제외).
# - push: 값은 명령줄 인자로 받지 않습니다(셸 기록 · 프로세스 목록에 남지 않게). 터미널이면 보이지 않게
#   입력받고, 아니면 표준 입력 전체를 씁니다: printf '%s' "$VALUE" | scripts/env-vault.sh push X
#   az에도 값을 인자가 아닌 임시 파일(--file, 권한 600)로 넘기고 바로 지웁니다.
#
# 테스트: scripts/tests/env-vault.bats (source하면 main은 실행되지 않습니다)

VAULT="${NOTELINK_VAULT:-kv-notelink-dev}"
ROOT="${ENV_VAULT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APPS="ai api"
VAR_RE='^[A-Z][A-Z0-9_]*$'
ROLES="값 보기 · 쓰기는 Key Vault Secrets Officer(완우 · 희재), 이름 보기 · 넣기는 NoteLink Secrets Writer(나머지 팀원)입니다"

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

# 그 앱이 쓰는 변수 이름(한 줄에 하나, 정렬): apps/<앱>/.env.production의 "이름=" · "# 이름=" 줄
app_vars() {  # $1 = 앱
  local file="$ROOT/apps/$1/.env.production"
  [ -f "$file" ] || return 0
  sed -nE 's/^#?[[:space:]]*([A-Z][A-Z0-9_]*)=.*/\1/p' "$file" | tr -d '\r' | sort -u
}

# 이 변수를 쓰는 앱(공백으로 나눔). 없으면 빈 값
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

# 켜 둔 secret의 변수 이름(한 줄에 하나, 정렬). 값은 읽지 않음(secret list는 이름 · 속성만).
# 이름 규칙에 맞지 않는 secret은 알리고 뺌. 읽지 못하면 로그인 · 권한 안내와 함께 끝냄
vault_vars() {
  local names name var
  names=$(az_out keyvault secret list --vault-name "$VAULT" \
    --query "[?attributes.enabled].name" -o tsv) \
    || die "Key Vault '$VAULT'의 이름 목록을 읽지 못했습니다. az login(팀 디렉터리)과 권한을 확인하세요. $ROLES"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    var=$(var_name "$name")
    if [[ "$var" =~ $VAR_RE ]]; then
      echo "$var"
    else
      echo "env-vault: 이름이 규칙에 맞지 않아 보이지 않음: $name" >&2
    fi
  done <<< "$names" | sort -u
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
  # 값은 출력하지 않고 VALUE에 넣음: $(…)로 받으면 끝 줄바꿈이 모두 사라져 "a\n\n"이 검사 없이 "a"가 됨
  VALUE=${v%$'\r'}  # PowerShell 파이프 · Windows 편집기의 \r\n
}

push() {  # $1 = 변수
  local var=$1 value tmp users
  check_var "$var"
  need_az
  users=$(apps_of "$var")
  [ -n "$users" ] \
    || echo "env-vault: $var는 ai · api의 .env.production에 없습니다(이름을 확인하세요. 새 변수면 .env.production에도 적습니다)" >&2
  read_value
  value=$VALUE
  [ -n "$value" ] || die "값이 비었습니다"
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] \
    || die "값에 줄바꿈(\r 포함)이 있습니다. 앱 설정 값은 한 줄이어야 합니다"
  tmp=$(umask 077 && mktemp) || die "임시 파일을 만들지 못했습니다"
  trap 'rm -f "$tmp"' EXIT
  printf '%s' "$value" > "$tmp"
  az keyvault secret set --vault-name "$VAULT" --name "$(secret_name "$var")" \
    --file "$tmp" --encoding utf-8 --output none \
    || die "Key Vault '$VAULT'에 쓰지 못했습니다. 권한을 확인하세요. $ROLES"
  rm -f "$tmp"
  trap - EXIT
  echo "$(secret_name "$var")를 Key Vault '$VAULT'에 저장함.${users:+ 쓰는 앱: ${users// / · }.}" \
    "배포 앱이 Key Vault 참조로 읽으면 앱을 다시 시작할 때(아니면 24시간 안에) 새 값을 씁니다." \
    "처음 넣은 이름이면 App Service 앱 설정에 Key Vault 참조를 추가해야 합니다"
}

list() {  # $1 = 앱(없으면 모두). 이름과 그 이름을 쓰는 앱
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
    push) [ $# -eq 2 ] || die "사용법: $0 push <변수>"; push "$2" ;;
    list) [ $# -le 2 ] || die "사용법: $0 list [ai|api]"; list "${2:-}" ;;
    *) die "사용법: $0 push <변수> · $0 list [ai|api] (로컬 개발용 키는 각자 apps/<앱>/.env에)" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  main "$@"
fi
