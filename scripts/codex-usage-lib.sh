#!/usr/bin/env bash
# Codex 남은 사용량 판단 (source해서 씀). 리뷰 컴퓨터의 scripts/codex-review.sh(리뷰를 멈출지)와
# GitHub 클라우드 러너의 scripts/runner-status.sh(디스코드 알림 · 다시 돌리기)가 같은 기준을 쓰도록 한곳에 둡니다.
#
# 사용량 기록(key=value)은 scripts/codex-usage.mjs가 Codex 실행 뒤에 만듭니다.
#   at=기록 시각 plan=플랜 limit=0|1(한도 문구) retry=다시 가능한 시각
#   p_used · p_window · p_reset / s_used · s_window · s_reset = 창별 사용률(%) · 창 길이(분) · 초기화 시각
# 시각은 모두 epoch 초입니다.
#
# 단계(usage_level):
#   ok   남은 양이 USAGE_WARN_LEFT% 이상
#   warn 한 창이라도 남은 양이 USAGE_WARN_LEFT% 미만 (🟡 경고)
#   stop 한 창이라도 남은 양이 USAGE_STOP_LEFT% 이하이거나 한도에 걸림 → 리뷰를 멈추고, 초기화되면 다시 돌림
#
# 테스트: scripts/tests/runner-status.bats · scripts/tests/codex-review.bats

USAGE_WARN_LEFT="${USAGE_WARN_LEFT:-20}"
USAGE_STOP_LEFT="${USAGE_STOP_LEFT:-10}"
# 다시 가능한 시각을 모를 때(한도 문구에 시각이 없고 창 초기화 시각도 없음) 기록 시각부터 이만큼 뒤에 다시 시도
USAGE_UNKNOWN_RETRY="${USAGE_UNKNOWN_RETRY:-3600}"

kst() {  # $1 = epoch → "11/01 14:42" (서울은 서머타임이 없어 +9시간)
  date -u -d "@$(( $1 + 9 * 3600 ))" '+%m/%d %H:%M'
}

no_usage() {
  U_AT=""; U_PLAN=""; U_LIMIT=0; U_RETRY=""
  U_P_USED=""; U_P_WINDOW=""; U_P_RESET=""; U_S_USED=""; U_S_WINDOW=""; U_S_RESET=""
}

# 사용량 기록 파일을 U_*로 읽음. 모르는 키 · 이상한 값은 무시(파일 내용을 실행하지 않음)
load_usage() {  # $1 = 파일
  no_usage
  [ -f "$1" ] || return 0
  local k v
  while IFS='=' read -r k v; do
    case "$k" in
      at) [[ "$v" =~ ^[0-9]+$ ]] && U_AT=$v ;;
      plan) [[ "$v" =~ ^[a-z0-9_]{1,32}$ ]] && U_PLAN=$v ;;
      limit) [[ "$v" =~ ^[01]$ ]] && U_LIMIT=$v ;;
      retry) [[ "$v" =~ ^[0-9]+$ ]] && U_RETRY=$v ;;
      p_used) [[ "$v" =~ ^[0-9]{1,3}$ ]] && U_P_USED=$v ;;
      p_window) [[ "$v" =~ ^[1-9][0-9]*$ ]] && U_P_WINDOW=$v ;;
      p_reset) [[ "$v" =~ ^[0-9]+$ ]] && U_P_RESET=$v ;;
      s_used) [[ "$v" =~ ^[0-9]{1,3}$ ]] && U_S_USED=$v ;;
      s_window) [[ "$v" =~ ^[1-9][0-9]*$ ]] && U_S_WINDOW=$v ;;
      s_reset) [[ "$v" =~ ^[0-9]+$ ]] && U_S_RESET=$v ;;
    esac
  done < "$1"
  return 0
}

# U_*와 NOW로 → CUR_USAGE(ok|warn|stop, 기록이 없으면 빈 값) · USAGE_LEFT(가장 적게 남은 창의 %, 모르면 빈 값)
#   · USAGE_REASON(stop일 때 limit(한도 문구) | low(남은 양)) · USAGE_RETRY(stop일 때 다시 돌릴 시각)
# - 초기화 시각이 지난 창은 다 남은 것(100%)으로 봄
# - 한도 문구가 있으면 다시 가능한 시각까지 stop (시각을 모르면 기록 뒤 USAGE_UNKNOWN_RETRY초)
# - 남은 양으로 멈추면 다시 돌릴 시각은 그 창들 중 가장 늦은 초기화 시각
usage_level() {
  CUR_USAGE=""; USAGE_LEFT=""; USAGE_REASON=""; USAGE_RETRY=""
  [ -n "$U_AT" ] || return 0
  local fallback=$(( U_AT + USAGE_UNKNOWN_RETRY ))
  if [ "$U_LIMIT" = 1 ]; then
    local until=${U_RETRY:-$fallback}
    if [ "$until" -gt "$NOW" ]; then
      CUR_USAGE=stop; USAGE_REASON=limit; USAGE_RETRY=$until; USAGE_LEFT=0
      return 0
    fi
  fi
  CUR_USAGE=ok
  local w used reset left
  for w in P S; do
    used="U_${w}_USED"; reset="U_${w}_RESET"
    used=${!used}; reset=${!reset}
    [ -n "$used" ] || continue
    if [ -n "$reset" ] && [ "$reset" -le "$NOW" ]; then continue; fi
    left=$(( used >= 100 ? 0 : 100 - used ))
    if [ -z "$USAGE_LEFT" ] || [ "$left" -lt "$USAGE_LEFT" ]; then USAGE_LEFT=$left; fi
    if [ "$left" -le "$USAGE_STOP_LEFT" ]; then
      reset=${reset:-$fallback}
      # 초기화 시각을 몰라 정한 시각도 지났으면 이 창은 다시 시도해 봄
      [ "$reset" -gt "$NOW" ] || continue
      CUR_USAGE=stop; USAGE_REASON=low
      if [ -z "$USAGE_RETRY" ] || [ "$reset" -gt "$USAGE_RETRY" ]; then USAGE_RETRY=$reset; fi
    elif [ "$left" -lt "$USAGE_WARN_LEFT" ] && [ "$CUR_USAGE" = ok ]; then
      CUR_USAGE=warn
    fi
  done
  return 0
}
