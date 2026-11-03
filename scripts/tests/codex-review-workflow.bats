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

# ---------- 언제 도는지 (자동은 첫 리뷰만, 재리뷰는 라벨 · 댓글 요청) ----------

@test "트리거: PR 이벤트에 labeled, 댓글(issue_comment created)을 받는다" {
  local workflow="$BATS_TEST_DIRNAME/../../.github/workflows/codex-review.yml"
  grep -qF 'types: [opened, synchronize, reopened, ready_for_review, labeled]' "$workflow"
  awk '/^  issue_comment:/ { f = 1; next } f && /types: \[created\]/ { ok = 1 } END { exit !ok }' "$workflow"
}

@test "트리거: 라벨 이름 · 댓글 명령이 스크립트와 같고, job 조건 · 동시 실행 그룹에서 같은 값으로 거른다" {
  local workflow="$BATS_TEST_DIRNAME/../../.github/workflows/codex-review.yml"
  local script="$BATS_TEST_DIRNAME/../codex-review.sh"
  grep -qF 'REQUEST_LABEL="codex-review"' "$script"
  grep -qF 'REQUEST_COMMAND="/codex review"' "$script"
  [ "$(grep -cF "github.event.label.name == 'codex-review'" "$workflow")" -eq 1 ]
  [ "$(grep -cF "github.event.label.name != 'codex-review'" "$workflow")" -eq 1 ]
  [ "$(grep -cF "startsWith(github.event.comment.body, '/codex review')" "$workflow")" -eq 2 ]
}

@test "트리거: 상관없는 댓글 · 라벨 실행은 따로인 그룹이라 진행 중인 리뷰를 취소하지 않고, 자동과 요청은 그룹이 다르다" {
  local workflow="$BATS_TEST_DIRNAME/../../.github/workflows/codex-review.yml"
  grep -qF "format('codex-review-ignore-{0}', github.run_id)" "$workflow"
  grep -qF "format('codex-review-{0}-{1}', github.event.pull_request.number || github.event.issue.number," "$workflow"
  grep -qF "(github.event_name == 'issue_comment' || github.event.action == 'labeled') && 'request' || 'auto')" "$workflow"
}

@test "트리거: 리뷰 단계에 PR 번호 · 실행 종류 · 요청 정보를 넘긴다" {
  local workflow="$BATS_TEST_DIRNAME/../../.github/workflows/codex-review.yml"
  grep -qF 'PR: ${{ github.event.pull_request.number || github.event.issue.number }}' "$workflow"
  grep -qF "CODEX_TRIGGER: \${{ (github.event_name == 'issue_comment' || github.event.action == 'labeled') && 'request' || 'auto' }}" "$workflow"
  grep -qF "CODEX_REQUEST_LABEL: \${{ github.event.action == 'labeled' && github.event.label.name || '' }}" "$workflow"
  grep -qF 'CODEX_REQUESTER: ${{ github.event.comment.user.login }}' "$workflow"
  grep -qF 'CODEX_REQUEST_COMMENT: ${{ github.event.comment.id }}' "$workflow"
  # 이벤트 값은 env로만 넘기고 run 안에 직접 넣지 않음(명령 주입 방지)
  not grep -qE 'run: .*\$\{\{ github\.event\.(comment|label|issue)' "$workflow"
}
