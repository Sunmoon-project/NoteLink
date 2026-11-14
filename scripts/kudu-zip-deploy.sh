#!/usr/bin/env bash
# zip 묶음을 App Service(Kudu)에 비동기로 올리고, 그 배포가 끝날 때까지 기다립니다.
# `az webapp deploy`는 --async여도 CLI 안에서 상태를 기다리다 제한 시간에 걸리고, 동기로 기다리면 앞단 응답 한도(약 4분)에
# 504로 끊겨서, Kudu 비동기 zip 배포 API를 직접 부르고 응답의 Location을 확인합니다.
# Location은 그 배포가 아니라 '지금 가장 최근 배포'(/api/deployments/latest?deployer=…&time=…)를 돌려주므로,
# 처음 읽은 상태의 id를 이 배포로 정하고 그 뒤로는 /api/deployments/<id>로 그 배포만 확인합니다. 그사이 다른
# 배포가 시작되어 그 배포의 결과로 판정하지 않게 합니다(Codex 리뷰 #387).
# 로그인은 `az login`(OIDC)으로 받은 토큰을 씁니다. 배포 주체에 그 앱의 Website Contributor 이상 권한이 있어야 합니다.
# 사용: kudu-zip-deploy.sh <앱 이름> <zip 경로> [확인 횟수=90] [간격(초)=20]
set -u

app="${1:?앱 이름이 필요합니다}"
zip="${2:?zip 경로가 필요합니다}"
tries="${3:-90}"
delay="${4:-20}"

token=$(az account get-access-token --resource https://management.azure.com/ --query accessToken -o tsv) || {
  echo "Azure 토큰을 받지 못했습니다(az login 확인)" >&2
  exit 1
}
headers=$(mktemp)
trap 'rm -f "$headers"' EXIT

code=$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' --max-time 600 -X POST \
  -H "Authorization: Bearer $token" -H 'Content-Type: application/zip' --data-binary "@$zip" \
  "https://$app.scm.azurewebsites.net/api/zipdeploy?isAsync=true") || code=""
location=$(tr -d '\r' < "$headers" | awk 'tolower($1) == "location:" { print $2 }' | tail -n 1)
if [ "$code" != "202" ] || [ -z "$location" ]; then
  echo "배포를 시작하지 못했습니다(HTTP ${code:-응답 없음})" >&2
  exit 1
fi
echo "배포 시작: $location"
base="${location%%/api/*}" # https://<앱>.scm.azurewebsites.net
id=""
url="$location"

# Kudu status: 3 실패, 4 성공. 조회가 실패하면 다시 시도하고, 끝까지 실패하면 마지막 오류를 남깁니다
last_error=""
i=1
while [ "$i" -le "$tries" ]; do
  [ "$i" -gt 1 ] && sleep "$delay"
  if body=$(curl -sS --fail --max-time 30 -H "Authorization: Bearer $token" "$url" 2>&1) &&
    jq -e . >/dev/null 2>&1 <<<"$body"; then
    got=$(jq -r '.id // ""' <<<"$body")
    if [ -z "$id" ] && [ -n "$got" ]; then
      id="$got"
      url="$base/api/deployments/$id"
      echo "배포 id: $id"
    elif [ -n "$id" ] && [ -n "$got" ] && [ "$got" != "$id" ]; then
      echo "다른 배포(id=$got)의 상태가 왔습니다. 이 배포(id=$id)는 판정하지 못했습니다" >&2
      exit 1
    fi
    complete=$(jq -r '.complete' <<<"$body")
    status=$(jq -r '.status' <<<"$body")
    echo "확인 $i/$tries: status=$status complete=$complete $(jq -r '.status_text // ""' <<<"$body")"
    if [ "$complete" = "true" ]; then
      [ "$status" = "4" ] && exit 0
      # 쿼리가 붙은 Location 뒤에 /log를 이으면 주소가 깨지므로 id로 만듦(id를 모르면 쿼리를 뗀 주소)
      if [ -n "$id" ]; then log="$base/api/deployments/$id/log"; else log="${location%%\?*}/log"; fi
      echo "배포 실패(status=$status). 로그: $log" >&2
      exit 1
    fi
  else
    last_error="$body"
    echo "확인 $i/$tries: 상태를 읽지 못함"
  fi
  i=$((i + 1))
done
echo "배포가 끝나지 않았습니다(확인 ${tries}번).${last_error:+ 마지막 조회 오류: $last_error}" >&2
exit 1
