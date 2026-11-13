#!/usr/bin/env bash
# 비밀값을 Azure Key Vault에 넣고, 이름을 보고, 팀 개발용 값을 받아 .env를 만듭니다(#326, #375).
#
#   scripts/env-vault.sh pull <ai|api>                # 팀 Key Vault → apps/<앱>/.env
#   scripts/env-vault.sh push [--team] <변수>         # 값 하나를 넣거나 바꿈(값은 표준 입력)
#   scripts/env-vault.sh list [--team] [ai|api]       # 변수 이름과 그 이름을 쓰는 앱(값은 보이지 않음)
#
# - Key Vault는 둘입니다. 각자 Azure 계정으로 열고, 팀 키 하나를 나눠 갖지 않습니다.
#   - 배포(NOTELINK_VAULT, 기본 kv-notelink-dev): 배포 App Service가 Key Vault 참조로 읽는 **배포용 값만**.
#     --team이 없으면 이쪽입니다. 받지(pull) 않습니다.
#     값 보기 · 쓰기(Key Vault Secrets Officer): 완우 · 희재
#     이름 보기 · 넣기(사용자 지정 역할 NoteLink Secrets Writer, 값 읽기 없음): 나머지 팀원
#   - 팀(NOTELINK_TEAM_VAULT, 기본 kv-notelink-team, --team): 팀원이 같이 쓰는 **로컬 개발용 값**.
#     팀원 모두 읽기 · 쓰기(Key Vault Secrets Officer). 배포 값은 넣지 않습니다.
# - 먼저 Azure CLI를 설치하고 팀 디렉터리 계정으로 로그인합니다: az login --tenant <팀 테넌트 ID>
# - secret 이름은 변수 이름에서 _만 -로 바꾼 것입니다(Key Vault 이름에는 _를 쓸 수 없음):
#   ANTHROPIC-API-KEY ↔ ANTHROPIC_API_KEY. 꺼 둔(disabled) secret은 list · pull에 보이지 않습니다.
# - 앱이 쓰는 변수는 apps/<앱>/.env.production에 적힌 이름입니다(주석으로 둔 선택 항목 "# 이름=" 포함,
#   "# 로컬: 이름=" 줄은 제외). pull은 그 이름만 받습니다.
# - pull: 사람마다 다른 값(개인 키 · 로컬 주소)은 커밋하지 않는 apps/<앱>/.env.local에 두면 받은 값
#   위에 덮어씁니다(앱은 .env만 읽으므로 .env에 합쳐 씀). 있던 .env는 손으로 만든 것이면 .env.bak,
#   pull이 만든 것이면 .env.prev로 남깁니다(.env.*는 .gitignore). 값은 화면에 찍지 않고 개수만 알립니다.
# - push: 값은 명령줄 인자로 받지 않습니다(셸 기록 · 프로세스 목록에 남지 않게). 터미널이면 보이지 않게
#   입력받고, 아니면 표준 입력 전체를 씁니다: printf '%s' "$VALUE" | scripts/env-vault.sh push X
#   az에도 값을 인자가 아닌 임시 파일(--file, 권한 600)로 넘기고 바로 지웁니다.
#
# 테스트: scripts/tests/env-vault.bats (source하면 main은 실행되지 않습니다)

DEPLOY_VAULT="${NOTELINK_VAULT:-kv-notelink-dev}"
TEAM_VAULT="${NOTELINK_TEAM_VAULT:-kv-notelink-team}"
VAULT=$DEPLOY_VAULT  # 이번 명령이 쓰는 Key Vault(--team · pull이면 TEAM_VAULT)
TEAM=""              # --team · pull이면 1(Key Vault 이름이 아니라 명령으로 정함)
ROOT="${ENV_VAULT_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
APPS="ai api"
VAR_RE='^[A-Z][A-Z0-9_]*$'
ROLES="값 보기 · 쓰기는 Key Vault Secrets Officer(완우 · 희재), 이름 보기 · 넣기는 NoteLink Secrets Writer(나머지 팀원)입니다"
TEAM_ROLES="팀 Key Vault는 팀원 모두 Key Vault Secrets Officer입니다"
USAGE="pull <ai|api> · push [--team] <변수> · list [--team] [ai|api]"
# ai의 ${…} 값: .env · .env.local(pull이 .env에 합침) 어디에 두어도 python-dotenv가 바꿔 읽음. 셸 환경 변수는
# pydantic-settings가 .env보다 먼저 쓰고 바꾸지 않음. python-dotenv가 바꾸는 모양은 닫는 }까지 있는 ${…}뿐
# (dotenv/variables.py: 'x${}y' → xy, 'ab${cd'는 그대로)
EXPAND_RE='\$\{[^}]*\}'
DOLLAR_HINT="python-dotenv는 .env(.env.local도 .env에 합쳐짐)의 \${이름}을 바꿔 읽으므로, 셸 환경 변수로 넘기세요(예: export 이름='값' 뒤 서버 실행)"

die() { echo "env-vault: $*" >&2; exit 1; }

is_team() { [ -n "$TEAM" ]; }

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }  # macOS bash 3.2에는 ${,,}가 없음

# 팀 Key Vault로 바꿈. Key Vault 이름은 대소문자를 가리지 않으므로 배포 Key Vault와 같으면(대소문자 무시)
# 배포 값을 팀 값처럼 받거나 넣게 되어 거절
use_team() {
  [ "$(lower "$TEAM_VAULT")" != "$(lower "$DEPLOY_VAULT")" ] \
    || die "팀 Key Vault와 배포 Key Vault가 같습니다('$TEAM_VAULT'). 배포 값은 팀 값으로 받거나 넣지 않습니다"
  VAULT=$TEAM_VAULT
  TEAM=1
}

role_hint() { if is_team; then echo "$TEAM_ROLES"; else echo "$ROLES"; fi; }

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

# secret 값 하나를 VALUE에 그대로. tsv의 줄 끝은 OS마다 \n · \r\n이라, 값 끝의 \r · \n과 가릴 수 없음.
# 그래서 값 뒤에 표지 열('x')을 붙여 받고 마지막 탭 앞만 씀: az tsv는 값 안의 \r · 줄바꿈 · 탭을 그대로
# 내므로 그대로 남아 env_line이 거름. 목록을 한 겹 더 감싸야([[…]]) 한 줄에 탭으로 이어짐([값,'x']는
# 두 줄). 실패하면 1, 출력 모양이 다르면 2
az_value() {  # $1 = secret 이름
  local out
  out=$(az keyvault secret show --vault-name "$VAULT" --name "$1" --query "[[value,'x']]" -o tsv) \
    || return 1
  [[ "$out" == *$'\t'x || "$out" == *$'\t'x$'\r' ]] || return 2  # $(…)가 끝 줄바꿈만 지움
  VALUE=${out%$'\t'*}
}

# 켜 둔 secret의 변수 이름(한 줄에 하나, 정렬). 값은 읽지 않음(secret list는 이름 · 속성만).
# 이름 규칙에 맞지 않는 secret은 알리고 뺌. 읽지 못하면 로그인 · 권한 안내와 함께 끝냄
vault_vars() {
  local names name var
  names=$(az_out keyvault secret list --vault-name "$VAULT" \
    --query "[?attributes.enabled].name" -o tsv) \
    || die "Key Vault '$VAULT'의 이름 목록을 읽지 못했습니다. az login(팀 디렉터리)과 권한을 확인하세요. $(role_hint)"
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

# Key Vault에 있는 이름 중 그 앱이 쓰는 것(macOS 기본 bash 3.2라 연관 배열 대신 grep). list · pull이 같이 씀
app_vault_vars() {  # $1 = 앱, $2 = Key Vault의 이름 목록(vault_vars)
  grep -xF -f <(app_vars "$1") <<< "$2" || true
}

# .env.local의 이름이 Key Vault 이름을 덮는지. ai(pydantic-settings)는 이름의 대소문자를 가리지 않아
# mongodb_uri도 MONGODB_URI를 덮지만, api(NestJS · process.env)는 대소문자를 가려 덮지 않음
overrides() {  # $1 = 앱, $2 = 변수, $3 = .env.local의 이름 목록
  [ -n "$3" ] || return 1
  if [ "$1" = ai ]; then grep -qixF "$2" <<< "$3"; else grep -qxF "$2" <<< "$3"; fi
}

# .env 한 줄: 특수 문자가 없으면 그대로, 있으면 작은따옴표. 작은따옴표 · 역슬래시 · 줄바꿈은 dotenv마다
# 읽는 법이 달라(python-dotenv는 작은따옴표 안의 \\ · \'를 풀고 Node dotenv는 그대로 둠) 거절.
# ai는 ${…}도 거절: python-dotenv는 작은따옴표 안에서도 ${이름}을 바꿈('abc${X}def' → abcdef).
# api(NestJS · Node dotenv)는 바꾸지 않아 그대로 씀. 거절하면 1(줄바꿈 · 작은따옴표 · 역슬래시), 2(ai의 ${…})
env_line() {  # $1 = 변수, $2 = 값, $3 = 앱(없으면 ai · api 공통 검사만)
  local value=$2
  if [[ "$value" == *$'\n'* || "$value" == *$'\r'* || "$value" == *"'"* || "$value" == *\\* ]]; then
    return 1
  fi
  if [ "${3:-}" = ai ] && [[ "$value" =~ $EXPAND_RE ]]; then
    return 2
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

PULL_HEAD='# scripts/env-vault.sh pull '

pull() {  # $1 = 앱. 팀 Key Vault에서만 받음(배포 값은 로컬로 내려받지 않음)
  local app=$1 dir env local_file tmp have local_set var name value line bak rc count=0 skipped=0 overridden=0
  check_app "$app"
  use_team
  need_az
  dir="$ROOT/apps/$app"
  env="$dir/.env"
  local_file="$dir/.env.local"
  [ -d "$dir" ] || die "$dir 폴더가 없습니다"
  [ -n "$(app_vars "$app")" ] || die "apps/$app/.env.production에서 변수 이름을 찾지 못했습니다"
  have=$(vault_vars) || exit 1  # 따로 받아야 vault_vars의 실패(die)가 묻히지 않음
  have=$(app_vault_vars "$app" "$have")
  local_set=$(local_keys "$local_file")

  tmp=$(umask 077 && mktemp "$dir/.env.pull.XXXXXX") || die "임시 파일을 만들지 못했습니다"
  trap 'rm -f "$tmp"' EXIT
  {
    echo "${PULL_HEAD}$app 로 팀 Key Vault '$VAULT'에서 받은 값입니다. 커밋하지 않습니다."
    echo "# 내 값으로 바꿀 것은 이 파일이 아니라 apps/$app/.env.local에 두고, 고친 뒤 pull을 다시 합니다(앱은 .env만 읽음)."
  } > "$tmp"
  while IFS= read -r var; do
    [ -n "$var" ] || continue
    if overrides "$app" "$var" "$local_set"; then
      overridden=$((overridden + 1)); continue
    fi
    name=$(secret_name "$var")
    rc=0
    az_value "$name" || rc=$?
    [ "$rc" -ne 2 ] \
      || die "'$name'의 az 출력 모양이 예상과 다릅니다(.env는 그대로). Azure CLI 버전을 확인하세요"
    [ "$rc" -eq 0 ] \
      || die "'$name'의 값을 읽지 못했습니다(.env는 그대로, 위 az 오류 참고). 방금 지우거나 껐으면 pull을 다시 하고, 아니면 권한을 확인하세요. $(role_hint)"
    value=$VALUE
    rc=0
    line=$(env_line "$var" "$value" "$app") || rc=$?
    case $rc in
      0) printf '%s\n' "$line" >> "$tmp"; count=$((count + 1)) ;;
      2) echo "env-vault: $var 값에 \${…}가 있어 건너뜀. $DOLLAR_HINT" >&2; skipped=$((skipped + 1)) ;;
      *) echo "env-vault: $var 값에 줄바꿈 · 작은따옴표 · 역슬래시가 있어 건너뜀(.env.local에 직접 넣으세요)" >&2
         skipped=$((skipped + 1)) ;;
    esac
  done <<< "$have"
  if [ -f "$local_file" ]; then
    { echo; echo "# apps/$app/.env.local"; tr -d '\r' < "$local_file"; echo; } >> "$tmp"
    # 주석이 아닌 값 줄의 ${…}만(일부러 다른 변수로 바꾸는 것이면 그대로 둬도 됨)
    if [ "$app" = ai ] \
      && grep -qE '^[[:space:]]*(export[[:space:]]+)?[A-Za-z_][A-Za-z0-9_]*[[:space:]]*=.*\$\{[^}]*\}' "$local_file"; then
      echo "env-vault: apps/ai/.env.local의 값에 \${…}가 있어 다른 변수로 바뀌어 읽힙니다. 의도한 것이 아니면 $DOLLAR_HINT" >&2
    fi
  fi
  # 있던 .env는 늘 남김. 손으로 만든 것(pull 머리말이 없음)은 .env.bak — 이미 있으면 시각을 붙인 새 이름으로
  # 덮지 않음. pull이 만든 것은 .env.prev(매번 바꿈): 받은 뒤 .env에 직접 고친 값도 한 번은 되찾을 수 있게
  if [ -f "$env" ]; then
    if head -n 1 "$env" | grep -qF "$PULL_HEAD"; then
      bak="$dir/.env.prev"
    else
      bak="$dir/.env.bak"
      [ -e "$bak" ] && bak="$dir/.env.bak.$(date +%Y%m%d%H%M%S)"
    fi
    (umask 077 && cp "$env" "$bak") || die "있던 .env를 ${bak##*/}로 남기지 못했습니다"
    echo "있던 .env를 apps/$app/${bak##*/}로 남겼습니다"
  fi
  mv "$tmp" "$env" || die "$env를 쓰지 못했습니다"
  trap - EXIT
  echo "apps/$app/.env: 팀 Key Vault에서 ${count}개, .env.local이 ${overridden}개 덮어씀, 건너뜀 ${skipped}개"
  echo "팀 Key Vault에 없는 값(개인 키 · 로컬 DB 주소 등)은 apps/$app/.env.local에 둡니다(apps/$app/.env.production의 '로컬:' 줄 참고)"
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
  local var=$1 value tmp users rc
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
  if is_team; then
    rc=0
    if [[ " $users " == *" ai "* ]]; then
      env_line "$var" "$value" ai > /dev/null || rc=$?
    else
      env_line "$var" "$value" > /dev/null || rc=$?
    fi
    [ "$rc" -ne 2 ] || die "ai가 쓰는 값에 \${…}가 있으면 pull로 받을 수 없습니다. $DOLLAR_HINT"
    [ "$rc" -eq 0 ] || die "값에 작은따옴표 · 역슬래시가 있으면 pull로 .env에 받을 수 없습니다(.env.local에 직접 두세요)"
  fi
  tmp=$(umask 077 && mktemp) || die "임시 파일을 만들지 못했습니다"
  trap 'rm -f "$tmp"' EXIT
  printf '%s' "$value" > "$tmp"
  az keyvault secret set --vault-name "$VAULT" --name "$(secret_name "$var")" \
    --file "$tmp" --encoding utf-8 --output none \
    || die "Key Vault '$VAULT'에 쓰지 못했습니다. 권한을 확인하세요. $(role_hint)"
  rm -f "$tmp"
  trap - EXIT
  if is_team; then
    echo "$(secret_name "$var")를 팀 Key Vault '$VAULT'에 저장함.${users:+ 쓰는 앱: ${users// / · }.}" \
      "팀원은 pull을 다시 하면 새 값을 씁니다(배포 값은 --team 없이 push)"
  else
    echo "$(secret_name "$var")를 배포 Key Vault '$VAULT'에 저장함.${users:+ 쓰는 앱: ${users// / · }.}" \
      "배포 앱이 Key Vault 참조로 읽으면 앱을 다시 시작할 때(아니면 24시간 안에) 새 값을 씁니다." \
      "처음 넣은 이름이면 App Service 앱 설정에 Key Vault 참조를 추가해야 합니다"
  fi
}

list() {  # $1 = 앱(없으면 모두). 이름과 그 이름을 쓰는 앱
  local app=${1:-} have var users
  [ -z "$app" ] || check_app "$app"
  need_az
  have=$(vault_vars)
  [ -z "$app" ] || have=$(app_vault_vars "$app" "$have")
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
  local cmd=${1:-}
  [ $# -eq 0 ] || shift
  if [ "${1:-}" = --team ]; then
    [ "$cmd" != pull ] || die "pull은 늘 팀 Key Vault에서 받습니다(--team 없이): $0 pull <ai|api>"
    use_team; shift
  fi
  case "$cmd" in
    pull) [ $# -eq 1 ] || die "사용법: $0 pull <ai|api>"; pull "$1" ;;
    push) [ $# -eq 1 ] || die "사용법: $0 push [--team] <변수>"; push "$1" ;;
    list) [ $# -le 1 ] || die "사용법: $0 list [--team] [ai|api]"; list "${1:-}" ;;
    *) die "사용법: $0 $USAGE (배포 Key Vault에는 배포 값만, 팀 개발용 값은 --team)" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  main "$@"
fi
