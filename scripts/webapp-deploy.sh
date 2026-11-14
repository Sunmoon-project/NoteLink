#!/usr/bin/env bash
# zip 묶음을 App Service에 비동기로 올리고, 설치(빌드)와 앱 시작까지 확인합니다.
#
# `az webapp deploy`가 하는 일을 따르되, 오래 붙잡는 요청이 없게 나눴습니다(#386 · #387 · #410).
#   1. OneDeploy 비동기 배포 시작: POST https://<scm>/api/publish?type=zip&async=true (202)
#      동기로 기다리면 패키지 설치가 4분을 넘을 때 앞단 응답 한도에 504로 끊겼습니다.
#      패키지 설치(빌드)는 앱 설정 SCM_DO_BUILD_DURING_DEPLOYMENT=true일 때 App Service가 합니다.
#   2. 이 배포의 id 찾기: /api/deployments/latest를 읽어 id를 얻습니다. Kudu는 실제 배포 전에
#      temp-… 임시 기록을 만들었다 지우므로 'temp'가 든 id와, 배포를 시작하기 전의 최근 id는
#      건너뜁니다(az CLI의 _get_latest_deployment_id와 같음, Codex 리뷰 #410).
#   3. 설치 · 앱 시작 확인: Azure 배포 상태 API(.../sites/<앱>/deploymentStatus/<id>)의
#      properties.status가 RuntimeSuccessful이면 성공, BuildFailed · RuntimeFailed면 실패
#      (az CLI의 _poll_deployment_runtime_status와 같음, Codex 리뷰 #410).
# 기다리는 시간은 실제 경과 시간으로 끊습니다(조회마다 걸리는 시간도 포함).
# 로그인은 `az login`(OIDC)으로 받은 토큰을 씁니다. 배포 주체에 그 앱의 Website Contributor 이상 권한이 필요합니다.
#
# 사용: webapp-deploy.sh <리소스 그룹> <앱 이름> <zip 경로> [최대 기다림(초)=1800] [조회 간격(초)=20]
set -u

rg="${1:?리소스 그룹이 필요합니다}"
app="${2:?앱 이름이 필요합니다}"
zip="${3:?zip 경로가 필요합니다}"
limit="${4:-1800}"
delay="${5:-20}"
API_VERSION="2025-05-01" # Microsoft.Web(az CLI 2.92의 웹 관리 API 버전)
ARM="https://management.azure.com"

token=$(az account get-access-token --resource "$ARM/" --query accessToken -o tsv) || {
  echo "Azure 토큰을 받지 못했습니다(az login 확인)" >&2
  exit 1
}
sub=$(az account show --query id -o tsv) || {
  echo "구독을 읽지 못했습니다(az login 확인)" >&2
  exit 1
}
scm=$(az webapp show --resource-group "$rg" --name "$app" \
  --query "enabledHostNames[?contains(@, '.scm.')] | [0]" -o tsv) && [ -n "$scm" ] || {
  echo "앱 '$app'의 배포(scm) 주소를 읽지 못했습니다" >&2
  exit 1
}
scm="https://$scm"
auth=(-H "Authorization: Bearer $token")
deadline=$(($(date +%s) + limit))

# 남은 시간(초). 조회 한 번은 30초를 넘지 않게
left() { echo $((deadline - $(date +%s))); }
cap() { local l; l=$(left); [ "$l" -lt 30 ] && echo $((l > 1 ? l : 1)) || echo 30; }
# 조회 간격만큼 쉬되 남은 시간을 넘기지 않음
nap() { local l; l=$(left); [ "$l" -gt 0 ] && sleep $((delay < l ? delay : l)); return 0; }

# 배포를 시작하기 전의 최근 배포 id: 시작 뒤에도 잠깐 이 기록이 latest로 보일 수 있어 건너뜀
before=$(curl -sS --fail --max-time 30 "${auth[@]}" "$scm/api/deployments/latest" 2>/dev/null |
  jq -r '.id // ""' 2>/dev/null) || before=""

code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 600 -X POST "${auth[@]}" \
  -H 'Content-Type: application/octet-stream' --data-binary "@$zip" \
  "$scm/api/publish?type=zip&async=true") || code=""
if [ "$code" != "202" ] && [ "$code" != "200" ]; then
  echo "배포를 시작하지 못했습니다(HTTP ${code:-응답 없음})" >&2
  exit 1
fi
echo "배포 시작(HTTP $code)"

last_error=""
id=""
while [ "$(left)" -gt 0 ]; do
  body=$(curl -sS --fail --max-time "$(cap)" "${auth[@]}" "$scm/api/deployments/latest" 2>&1) || {
    last_error="$body"
    nap
    continue
  }
  got=$(jq -r '.id // ""' <<<"$body" 2>/dev/null) || got=""
  if [ -n "$got" ] && [[ "$got" != *temp* ]] && [ "$got" != "$before" ]; then
    id="$got"
    break
  fi
  echo "배포 id를 기다림(지금: ${got:-없음})"
  nap
done
if [ -z "$id" ]; then
  echo "이 배포의 id를 찾지 못했습니다(${limit}초).${last_error:+ 마지막 조회 오류: $last_error}" >&2
  exit 1
fi
echo "배포 id: $id"

status_url="$ARM/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Web/sites/$app/deploymentStatus/$id?api-version=$API_VERSION"
build_log="$scm/api/deployments/$id/log"
last_error=""
state=""
while [ "$(left)" -gt 0 ]; do
  if body=$(curl -sS --fail --max-time "$(cap)" "${auth[@]}" "$status_url" 2>&1) &&
    state=$(jq -r '.properties.status // ""' <<<"$body" 2>/dev/null) && [ -n "$state" ]; then
    echo "상태: $state (진행 $(jq -r '.properties.numberOfInstancesInProgress // 0' <<<"$body") ·" \
      "성공 $(jq -r '.properties.numberOfInstancesSuccessful // 0' <<<"$body") ·" \
      "실패 $(jq -r '.properties.numberOfInstancesFailed // 0' <<<"$body"))"
    case "$state" in
      RuntimeSuccessful)
        exit 0
        ;;
      BuildFailed | RuntimeFailed)
        if [ "$state" = BuildFailed ]; then
          echo "배포 실패: 패키지 설치(빌드)가 실패했습니다. 빌드 로그: $build_log" >&2
        else
          echo "배포 실패: 앱이 시작하지 못했습니다(실패한 인스턴스 $(jq -r '.properties.numberOfInstancesFailed // 0' <<<"$body")개)." \
            "시작 로그: az webapp log startup show -n $app -g $rg" >&2
        fi
        jq -r '.properties.errors[]? | "오류: \(.message // "") \(.extendedCode // "")"' <<<"$body" >&2
        jq -r '.properties.failedInstancesLogs[]? | "실패한 인스턴스 로그: \(.)"' <<<"$body" >&2
        exit 1
        ;;
    esac
  else
    last_error="$body" # 배포 상태가 아직 만들어지지 않았으면(404) 다시 시도
  fi
  nap
done
echo "배포가 ${limit}초 안에 끝나지 않았습니다(마지막 상태: ${state:-없음}). 빌드 로그: $build_log${last_error:+ 마지막 조회 오류: $last_error}" >&2
exit 1
