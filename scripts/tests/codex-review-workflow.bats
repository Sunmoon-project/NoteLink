#!/usr/bin/env bats
# .github/workflows/codex-review.yml 의 "리뷰 컴퓨터 확인" 단계 중 Git Bash 판별 부분 테스트
#   실행: npx --yes bats@1.13.0 scripts/tests
# 워크플로에서 판별 부분(run 첫 줄 ~ "for c in" 앞)을 꺼내, runner.os와 Git 루트 확인 경로를
# 변수로 바꾼 뒤 러너와 같은 옵션(bash --noprofile --norc -eo pipefail)으로 실행합니다.

setup_file() {
  local workflow="$BATS_TEST_DIRNAME/../../.github/workflows/codex-review.yml"
  awk '
    /- name: 리뷰 컴퓨터 확인/ { found = 1; next }
    found && /run: \|/ { body = 1; next }
    body && /^ *for c in / { exit }
    body { sub(/^          /, ""); print }
  ' "$workflow" |
    sed -e 's|\${{ runner\.os }}|$FAKE_RUNNER_OS|g' -e 's|/cmd/git\.exe|"$FAKE_GIT_EXE"|g' \
      > "$BATS_FILE_TMPDIR/check.sh"
}

setup() {
  CHECK="$BATS_FILE_TMPDIR/check.sh"
  export FAKE_GIT_EXE="$BATS_TEST_TMPDIR/git root/cmd/git.exe"  # 공백이 든 경로도 되는지 함께 봄
}

# $1 = runner.os, $2 = Git 루트에 git.exe를 둘지(yes/no), $3 = OSTYPE
run_check() {
  if [ "$2" = yes ]; then mkdir -p "${FAKE_GIT_EXE%/*}" && : > "$FAKE_GIT_EXE"; fi
  FAKE_RUNNER_OS="$1" run bash --noprofile --norc -eo pipefail -c \
    "OSTYPE='$3'; source '$CHECK'; echo 통과"
}

@test "판별 부분만 꺼낸다 (bash 문법 통과, 다음 반복문 · YAML 없음)" {
  bash -n "$CHECK"
  grep -q 'FAKE_GIT_EXE' "$CHECK"
  grep -q 'FAKE_RUNNER_OS' "$CHECK"
  grep -q 'exit 1' "$CHECK"
  not grep -qE 'for c in|- name:|\$\{\{' "$CHECK"
}

@test "Windows · Git 루트에 git.exe 있음 → OSTYPE이 msys(Git 2.51)든 cygwin(Git 2.56)이든 통과" {
  for os_type in msys cygwin; do
    run_check Windows yes "$os_type"
    [ "$status" -eq 0 ]
    [ "$output" = "통과" ]
  done
}

@test "Windows · Cygwin bash(OSTYPE=cygwin, 루트에 git.exe 없음) → 오류에 루트를 남긴다" {
  cygpath() { echo 'C:\cygwin64\'; }
  export -f cygpath
  run_check Windows no cygwin
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error::Git Bash가 아닌 bash(cygwin, "*"루트 C:\\cygwin64\\)"* ]]
}

@test "Windows · WSL bash(cygpath 없음) → 오류, 루트는 '알 수 없음'" {
  cygpath() { return 127; }
  export -f cygpath
  run_check Windows no linux-gnu
  [ "$status" -eq 1 ]
  [[ "$output" == *"::error::Git Bash가 아닌 bash(linux-gnu, "*"루트 알 수 없음)"* ]]
}

@test "Windows가 아니면 검사하지 않는다" {
  run_check Linux no linux-gnu
  [ "$status" -eq 0 ]
  [ "$output" = "통과" ]
}

# bats에서 `! cmd` 한 줄은 실패해도 테스트를 실패시키지 않으므로 대신 씀
not() { if "$@"; then return 1; fi; }

@test "사용량: 리뷰 단계가 적는 파일과 올리는 파일이 같고, 리뷰가 실패해도 올린다" {
  local workflow="$BATS_TEST_DIRNAME/../../.github/workflows/codex-review.yml"
  grep -qF 'CODEX_USAGE_FILE: ${{ runner.temp }}/codex-usage.txt' "$workflow"
  grep -qF 'path: ${{ runner.temp }}/codex-usage.txt' "$workflow"
  awk '/- name: Codex 사용량 올리기/ { f = 1 } f && /if: always\(\)/ { ok = 1 } f && /name: codex-usage/ { n = 1 } END { exit !(ok && n) }' "$workflow"
  # runner-status.sh가 찾는 결과 파일 · 파일 이름과 같아야 함
  grep -qF 'USAGE_ARTIFACT="${USAGE_ARTIFACT:-codex-usage}"' "$BATS_TEST_DIRNAME/../runner-status.sh"
  grep -qF 'USAGE_FILE_NAME="codex-usage.txt"' "$BATS_TEST_DIRNAME/../runner-status.sh"
}

@test "멈춤: 리뷰 단계가 적는 파일과 올리는 파일이 같고, 이름이 runner-status.sh가 찾는 것과 같다" {
  local workflow="$BATS_TEST_DIRNAME/../../.github/workflows/codex-review.yml"
  grep -qF 'CODEX_PAUSED_FILE: ${{ runner.temp }}/codex-paused.txt' "$workflow"
  grep -qF 'path: ${{ runner.temp }}/codex-paused.txt' "$workflow"
  grep -qF 'name: codex-paused' "$workflow"
  grep -qF 'PAUSED_ARTIFACT="${PAUSED_ARTIFACT:-codex-paused}"' "$BATS_TEST_DIRNAME/../runner-status.sh"
  grep -qF 'PAUSED_FILE_NAME="codex-paused.txt"' "$BATS_TEST_DIRNAME/../runner-status.sh"
  # 다시 돌린 실행이 같은 이름으로 다시 올릴 수 있어야 함
  [ "$(grep -c 'overwrite: true' "$workflow")" -eq 2 ]
}

# ---------- 언제 도는지 (자동은 첫 리뷰만, 재리뷰는 라벨 · 댓글 · Run workflow 요청) ----------

WF_FILE() { echo "$BATS_TEST_DIRNAME/../../.github/workflows/codex-review.yml"; }
# review job의 if · concurrency 부분만 꺼냄
review_if() { awk '/^  review:/ { r = 1 } r && /^    if: >-/ { f = 1; next } f && /^    [a-z#]/ { exit } f' "$(WF_FILE)"; }
review_group() { awk '/^  review:/ { r = 1 } r && /^    concurrency:/ { f = 1; next } f && /^    runs-on:/ { exit } f' "$(WF_FILE)"; }
# 댓글이 명령인지 보는 식(본문 전체가 명령이거나 명령 바로 뒤에 줄바꿈). if와 그룹이 똑같이 써야 함
COMMAND_EXPR="github.event.comment.body == '/codex review' ||"
COMMAND_NL="startsWith(github.event.comment.body, format('/codex review{0}', fromJSON('\"\\n\"')))"
COMMAND_CR="startsWith(github.event.comment.body, format('/codex review{0}', fromJSON('\"\\r\"')))"

@test "트리거: PR 이벤트에 labeled, 댓글(issue_comment created), 직접 요청(workflow_dispatch, PR 번호)을 받는다" {
  local workflow; workflow=$(WF_FILE)
  grep -qF 'types: [opened, synchronize, reopened, ready_for_review, labeled]' "$workflow"
  awk '/^  issue_comment:/ { f = 1; next } f && /types: \[created\]/ { ok = 1 } END { exit !ok }' "$workflow"
  awk '/^  workflow_dispatch:/ { f = 1; next } f && /^      pr:/ { ok = 1 } END { exit !ok }' "$workflow"
}

@test "트리거: 라벨 이름 · 댓글 명령이 스크립트와 같고, job 조건과 동시 실행 그룹이 같은 식으로 거른다" {
  local script="$BATS_TEST_DIRNAME/../codex-review.sh"
  grep -qF 'REQUEST_LABEL="codex-review"' "$script"
  grep -qF 'REQUEST_COMMAND="/codex review"' "$script"
  grep -qF 'REVIEW_WORKFLOW_FILE="codex-review.yml"' "$script"
  cond=$(review_if); group=$(review_group)
  [ -n "$cond" ] && [ -n "$group" ]
  for part in "$COMMAND_EXPR" "$COMMAND_NL" "$COMMAND_CR"; do
    [[ "$cond" == *"$part"* ]] || { echo "if에 없음: $part"; return 1; }
    [[ "$group" == *"$part"* ]] || { echo "그룹에 없음: $part"; return 1; }
  done
  [[ "$cond" == *"github.event.label.name == 'codex-review'"* ]]
  [[ "$group" == *"github.event.label.name != 'codex-review'"* ]]
  # 접두어만 보는 옛 식이 남지 않음
  not grep -qF "startsWith(github.event.comment.body, '/codex review')" "$(WF_FILE)"
  # 이 두 값 말고 다른 라벨 이름을 쓰지 않음
  [ "$(grep -oE "label\.name [!=]= '[^']*'" <<< "$group$cond" | sed "s/.*'\(.*\)'/\1/" | sort -u)" = codex-review ]
}

@test "트리거: 닫힌 PR은 거르고, 직접 요청은 기본 브랜치에서 돌린 것만 받는다" {
  cond=$(review_if)
  [[ "$cond" == *"github.event.pull_request.state == 'open'"* ]]
  [[ "$cond" == *"github.event.issue.state == 'open'"* ]]
  [[ "$cond" == *"(github.event_name == 'workflow_dispatch' &&"* ]]
  [[ "$cond" == *"github.ref == format('refs/heads/{0}', github.event.repository.default_branch))"* ]]
  # workflow_dispatch가 브랜치 조건 없이 따로 허용되지 않음
  not grep -qE "^ *github\.event_name == 'workflow_dispatch' *$" <<< "$cond"
}

@test "checkout: 이벤트와 상관없이 기본 브랜치를 받는다(Run workflow가 고른 브랜치의 스크립트를 돌리지 않게)" {
  awk '/- uses: actions\/checkout@/ { f = 1; next } f && /^      - / { exit } f' "$(WF_FILE)" \
    | grep -qF 'ref: ${{ github.event.repository.default_branch }}'
}

@test "트리거: 동시 실행은 review job에만 있고, 걸러지는 실행 · 직접 요청은 실행마다 따로인 그룹, 요청은 사람마다 그룹이 다르다" {
  local workflow; workflow=$(WF_FILE)
  not grep -q '^concurrency:' "$workflow"
  group=$(review_group)
  [[ "$group" == *"format('codex-review-ignore-{0}', github.run_id)"* ]]
  [[ "$group" == *"format('codex-review-{0}-dispatch-{1}', inputs.pr, github.run_id)"* ]]
  [[ "$group" == *"format('codex-review-{0}-{1}', github.event.pull_request.number || github.event.issue.number,"* ]]
  [[ "$group" == *"&& format('request-{0}', github.event.comment.user.login || github.event.sender.login) || 'auto')"* ]]
  [[ "$group" == *"cancel-in-progress: true"* ]]
}

@test "unlabel: codex-review 라벨이 붙으면 리뷰 job과 따로(동시 실행 그룹 없이) 클라우드 러너에서 바로 뗀다" {
  job=$(awk '/^  unlabel:/ { f = 1 } f && /^  review:/ { exit } f' "$(WF_FILE)")
  [[ "$job" == *"github.event.action == 'labeled' &&"* ]]
  [[ "$job" == *"github.event.label.name == 'codex-review'"* ]]
  [[ "$job" == *"runs-on: ubuntu-latest"* ]]
  [[ "$job" == *"pull-requests: write"* ]]
  [[ "$job" == *'gh api --method DELETE "repos/$REPO/issues/$PR/labels/codex-review"'* ]]
  [[ "$job" != *"concurrency"* ]]
  [[ "$job" != *"self-hosted"* ]]
}

@test "트리거: 리뷰 단계에 PR 번호 · 실행 종류 · 요청 정보를 env로만 넘긴다" {
  local workflow; workflow=$(WF_FILE)
  grep -qF 'PR: ${{ github.event.pull_request.number || github.event.issue.number || inputs.pr }}' "$workflow"
  grep -qF "CODEX_TRIGGER: \${{ (github.event_name == 'issue_comment' || github.event_name == 'workflow_dispatch' || github.event.action == 'labeled') && 'request' || 'auto' }}" "$workflow"
  grep -qF "CODEX_REQUEST_LABEL: \${{ github.event.action == 'labeled' && github.event.label.name || '' }}" "$workflow"
  grep -qF 'CODEX_REQUESTER: ${{ github.event.comment.user.login || github.event.sender.login }}' "$workflow"
  grep -qF 'CODEX_REQUEST_COMMENT: ${{ github.event.comment.id }}' "$workflow"
  grep -qF 'CODEX_REQUEST_BODY: ${{ github.event.comment.body }}' "$workflow"
  # 이벤트 값 · 입력은 run 안에 직접 넣지 않음(명령 주입 방지): run 블록 안에 github.event · inputs가 없어야 함
  not awk '/^ *run: / { r = 1 } /^ *- (name|uses): |^  [a-z]+:|^    [a-z-]+:/ { r = 0 } r && /\$\{\{ *(github\.event\.|inputs\.)/ { found = 1 } END { exit !found }' "$workflow"
}
