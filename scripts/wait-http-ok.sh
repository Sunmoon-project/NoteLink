#!/usr/bin/env bash
# 주소가 200을 돌려줄 때까지 기다립니다. 끝까지 200이 아니면 실패로 끝납니다.
# 사용: wait-http-ok.sh <주소> [시도 횟수=30] [간격(초)=10]
set -u

url="${1:?주소가 필요합니다}"
tries="${2:-30}"
delay="${3:-10}"

i=1
while [ "$i" -le "$tries" ]; do
  # 연결 실패 · 시간 초과도 다시 시도
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$url" || true)
  echo "시도 $i/$tries: ${code:-응답 없음}"
  [ "$code" = "200" ] && exit 0
  [ "$i" -lt "$tries" ] && sleep "$delay"
  i=$((i + 1))
done
echo "200 응답을 받지 못했습니다: $url" >&2
exit 1
