#!/usr/bin/env bats
# 댓글 게시 시점의 HEAD 및 과거 CI 실패 안내 정리 회귀 테스트.
# GitHub 호출은 로컬 fixture를 갱신하는 함수로 대체한다.

setup() {
  source "$BATS_TEST_DIRNAME/../codex-review.sh"
  TMP="$BATS_TEST_TMPDIR"
  REPO="team/repo"
  PR=33
  HEAD_SHA="abc123"
  ME="reviewer"
  WORK="$TMP/work"
  RUN_ID=777
  CI_RESULT=success
  DRY_RUN=false
  FAKE_HEAD="$HEAD_SHA"
  FAKE_HEAD_ERROR=false
  FAKE_CI_RESULT=success
  mkdir -p "$WORK" "$TMP/payloads"
  : > "$TMP/writes.tsv"
  printf '[]\n' > "$TMP/comments.json"
  printf '검증 결과\n인용 "내용"\n두 번째 줄\n' > "$TMP/body.md"

  gh() {
    local command="$1" sub="${2:-}" method="GET" endpoint="" query="" input="" body_file=""
    local arg previous=""
    shift
    for arg in "$@"; do
      case "$previous" in
        --method|-X) method="$arg" ;;
        --input) input="$arg" ;;
        --jq|-q) query="$arg" ;;
        --body-file) body_file="$arg" ;;
      esac
      case "$arg" in repos/*) endpoint="$arg" ;; esac
      previous="$arg"
    done
    if [ "$command" = repo ] && [ "$sub" = view ]; then
      printf '%s\n' "$REPO"
      return
    fi
    if [ "$command" = api ] && [ "$sub" = user ]; then
      printf '%s\n' "$ME"
      return
    fi
    if [ "$command" = api ] && [[ "$endpoint" == */actions/runs/*/jobs ]]; then
      jq -rn --arg result "$FAKE_CI_RESULT" '{jobs:[{id:88,name:"CI 결과",conclusion:$result,html_url:"https://github.com/team/repo/actions/runs/777/job/88"}]} | '"$query"
      return
    fi
    if [ "$command" = pr ] && [ "$sub" = view ]; then
      $FAKE_HEAD_ERROR && return 1
      if [ -n "$query" ]; then
        jq -rn --arg head "$FAKE_HEAD" '{headRefOid:$head,state:"OPEN",baseRefName:"develop",title:"테스트 PR",url:"https://github.com/team/repo/pull/33"} | '"$query"
      else
        jq -n --arg head "$FAKE_HEAD" '{headRefOid:$head}'
      fi
      return
    fi
    if [ "$command" = pr ] && [ "$sub" = comment ]; then
      [ -n "$body_file" ] || return 1
      printf 'POST\tnew\n' >> "$TMP/writes.tsv"
      cp "$body_file" "$TMP/new-comment.md"
      local next_id
      next_id=$((900 + $(wc -l < "$TMP/writes.tsv")))
      jq --argjson id "$next_id" --arg me "$ME" --rawfile body "$body_file" \
        '. + [{id:$id,user:{login:$me},body:$body,created_at:"2026-11-01T00:00:00Z"}]' \
        "$TMP/comments.json" > "$TMP/comments.next"
      mv "$TMP/comments.next" "$TMP/comments.json"
      return
    fi
    if [ "$command" = api ] && [ "$method" = PATCH ]; then
      local id="${endpoint##*/}"
      [ -n "$input" ] || return 1
      if [ "$input" = - ]; then cat > "$TMP/payloads/$id.json"
      else cp "$input" "$TMP/payloads/$id.json"; fi
      jq -e '.body | type == "string"' "$TMP/payloads/$id.json" >/dev/null || return 1
      printf 'PATCH\t%s\n' "$id" >> "$TMP/writes.tsv"
      jq --arg id "$id" --slurpfile payload "$TMP/payloads/$id.json" \
        'map(if (.id|tostring)==$id then .body=$payload[0].body else . end)' \
        "$TMP/comments.json" > "$TMP/comments.next"
      mv "$TMP/comments.next" "$TMP/comments.json"
      return
    fi
    if [ "$command" = api ] && [[ "$endpoint" == */issues/comments/* ]]; then
      local id="${endpoint##*/}"
      if [ -n "$query" ]; then
        jq -r --arg id "$id" '.[] | select((.id|tostring)==$id) | '"$query" "$TMP/comments.json"
      else
        jq --arg id "$id" '.[] | select((.id|tostring)==$id)' "$TMP/comments.json"
      fi
      return
    fi
    if [ "$command" = api ] && [[ "$endpoint" == */issues/*/comments ]]; then
      if [ -n "$query" ]; then jq -r "$query" "$TMP/comments.json"
      else cat "$TMP/comments.json"; fi
      return
    fi
    printf 'Unexpected gh invocation: %s %s\n' "$command" "$*" >&2
    return 1
  }
}

ci_fixtures() {
  cat > "$TMP/comments.json" <<'JSON'
[
 {"id":101,"created_at":"t1","user":{"login":"reviewer"},"body":"## 자동 검증 실패\n원본 로그: TypeError: example\n<!-- codex-review-ci sha=aaa111 -->"},
 {"id":102,"created_at":"t2","user":{"login":"other"},"body":"다른 리뷰어 실패\n<!-- codex-review-ci sha=bbb222 -->"},
 {"id":103,"created_at":"t3","user":{"login":"reviewer"},"body":"일반 코드 리뷰\n<!-- codex-review sha=aaa111 round=1 -->"},
 {"id":104,"created_at":"t4","user":{"login":"reviewer"},"body":"이미 해결됨\n<!-- codex-review-ci sha=ccc333 -->\n<!-- codex-review-ci-resolved sha=abc123 -->"}
]
JSON
}

@test "current_review_head: 같은 HEAD면 0, 바뀐 HEAD면 2, 조회 실패면 1" {
  run current_review_head
  [ "$status" -eq 0 ]
  FAKE_HEAD=def456
  run current_review_head
  [ "$status" -eq 2 ]
  FAKE_HEAD_ERROR=true
  run current_review_head
  [ "$status" -eq 1 ]
}

@test "publish_review_comment: 대기 중 HEAD가 바뀌면 새 댓글도 기존 댓글도 쓰지 않는다" {
  FAKE_HEAD=def456
  run publish_review_comment "$TMP/body.md"
  [ "$status" -eq 2 ]
  run publish_review_comment "$TMP/body.md" 101
  [ "$status" -eq 2 ]
  [ ! -s "$TMP/writes.tsv" ]
}

@test "publish_review_comment: HEAD 조회를 못 하면 결과 게시를 보류한다" {
  FAKE_HEAD_ERROR=true
  run publish_review_comment "$TMP/body.md"
  [ "$status" -eq 1 ]
  [ ! -s "$TMP/writes.tsv" ]
}

@test "publish_review_comment: dry-run은 PATCH와 새 댓글 모두 쓰지 않는다" {
  DRY_RUN=true
  publish_review_comment "$TMP/body.md"
  publish_review_comment "$TMP/body.md" 101
  [ ! -s "$TMP/writes.tsv" ]
}

@test "publish_review_comment: 기존 댓글은 JSON PATCH로 본문을 정확히 보존한다" {
  publish_review_comment "$TMP/body.md" 101
  [ "$(cat "$TMP/writes.tsv")" = $'PATCH\t101' ]
  jq -j '.body' "$TMP/payloads/101.json" > "$TMP/actual.md"
  cmp "$TMP/body.md" "$TMP/actual.md"
}

@test "publish_review_comment: 기존 댓글 ID가 없으면 body-file로 새 댓글을 쓴다" {
  publish_review_comment "$TMP/body.md"
  [ "$(cat "$TMP/writes.tsv")" = $'POST\tnew' ]
  cmp "$TMP/body.md" "$TMP/new-comment.md"
}

@test "post_ci_failure: 같은 SHA 실패를 반복하면 내 기존 댓글 하나를 갱신한다" {
  ci_fixtures
  HEAD_SHA=aaa111
  FAKE_HEAD="$HEAD_SHA"
  printf '다시 확인한 실패\n<!-- codex-review-ci sha=aaa111 -->\n' > "$TMP/body.md"
  post_ci_failure "$TMP/body.md"
  post_ci_failure "$TMP/body.md"
  [ "$(cat "$TMP/writes.tsv")" = $'PATCH\t101\nPATCH\t101' ]
  [ "$(jq '[.[]|select(.user.login=="reviewer" and (.body|contains("codex-review-ci sha=aaa111")))]|length' "$TMP/comments.json")" -eq 1 ]
}

@test "post_ci_failure: 해당 SHA의 내 실패가 없으면 다른 사람 댓글 대신 새 댓글을 쓴다" {
  ci_fixtures
  HEAD_SHA=bbb222
  FAKE_HEAD="$HEAD_SHA"
  printf '새 실패\n<!-- codex-review-ci sha=bbb222 -->\n' > "$TMP/body.md"
  post_ci_failure "$TMP/body.md"
  [ "$(cat "$TMP/writes.tsv")" = $'POST\tnew' ]
  [ "$(jq -r '.[]|select(.id==102)|.body' "$TMP/comments.json")" = $'다른 리뷰어 실패\n<!-- codex-review-ci sha=bbb222 -->' ]
}

@test "resolve_ci_failures: 최신 성공이면 내 미해결 CI 실패만 해결 표시하고 원본을 보존한다" {
  ci_fixtures
  resolve_ci_failures
  [ "$(cat "$TMP/writes.tsv")" = $'PATCH\t101' ]
  body=$(jq -r '.body' "$TMP/payloads/101.json")
  [[ "$body" == *"해결됨"* ]]
  [[ "$body" == *"TypeError: example"* ]]
  [[ "$body" == *"$HEAD_SHA"* ]]
  [[ "$body" == *"https://github.com/$REPO/actions/runs/$RUN_ID"* ]]
  [[ "$body" == *"codex-review-ci-resolved"* ]]
  # GitHub 조회 fixture까지 갱신하므로 두 번째 실행은 이미 해결한 댓글을 다시 포장하지 않는다.
  resolve_ci_failures
  [ "$(wc -l < "$TMP/writes.tsv")" -eq 1 ]
}

@test "resolve_ci_failures: 현재 실패·취소·미확인 결과는 과거 실패를 해결 처리하지 않는다" {
  ci_fixtures
  for CI_RESULT in failure cancelled timed_out none ""; do
    resolve_ci_failures
  done
  [ ! -s "$TMP/writes.tsv" ]
}

@test "resolve_ci_failures: 성공이어도 HEAD가 달라졌거나 확인 불가면 쓰지 않는다" {
  declare -F resolve_ci_failures >/dev/null
  ci_fixtures
  FAKE_HEAD=def456
  run resolve_ci_failures
  [ ! -s "$TMP/writes.tsv" ]
  FAKE_HEAD_ERROR=true
  run resolve_ci_failures
  [ ! -s "$TMP/writes.tsv" ]
}

@test "resolve_ci_failures: dry-run에서는 과거 실패 기록을 변경하지 않는다" {
  ci_fixtures
  DRY_RUN=true
  resolve_ci_failures
  [ ! -s "$TMP/writes.tsv" ]
}


# main 전체를 실행하되 GitHub와 Codex는 호출하지 않는다. 같은 HEAD의 기존 코드 리뷰와
# 과거 CI 실패가 함께 있을 때, 새 코드 리뷰를 생략하기 전에 CI 안내를 바로잡는지 확인한다.
main_same_head_fixture() {
  ci_fixtures
  jq --arg head "$HEAD_SHA" 'map(if .id==103 then .body="기존 코드 리뷰\n<!-- codex-review sha="+$head+" round=1 -->" else . end)' \
    "$TMP/comments.json" > "$TMP/comments.next"
  mv "$TMP/comments.next" "$TMP/comments.json"
  ci_wait() {
    printf 'checked\n' > "$TMP/ci-checked"
    RUN_ID=777
    RUN_STATUS=completed
    return 0
  }
  codex() {
    printf 'unexpected codex\n' > "$TMP/codex-called"
    return 1
  }
}

@test "main: 같은 HEAD를 이미 리뷰했어도 최신 CI 성공을 확인해 과거 실패를 해결 처리한다" {
  main_same_head_fixture
  FAKE_CI_RESULT=success
  run main "$PR"
  [ "$status" -eq 0 ]
  [ -f "$TMP/ci-checked" ]
  [ ! -e "$TMP/codex-called" ]
  [ "$(cat "$TMP/writes.tsv")" = $'PATCH\t101' ]
  archived=$(jq -r '.body' "$TMP/payloads/101.json")
  [[ "$archived" == *"해결됨"* ]]
  [[ "$archived" == *"원본 로그: TypeError: example"* ]]
  [[ "$archived" == *"$HEAD_SHA"* ]]
}

@test "main: 같은 HEAD를 이미 리뷰했어도 현재 CI 실패는 생략하지 않고 안내한다" {
  main_same_head_fixture
  FAKE_CI_RESULT=failure
  run main "$PR"
  [ "$status" -eq 0 ]
  [ -f "$TMP/ci-checked" ]
  [ ! -e "$TMP/codex-called" ]
  [ "$(cat "$TMP/writes.tsv")" = $'POST\tnew' ]
  grep -q "codex-review-ci sha=$HEAD_SHA" "$TMP/new-comment.md"
  grep -q '실패/중단' "$TMP/new-comment.md"
  [ -z "$(jq -r '.[]|select(.id==101)|.body|select(contains("codex-review-ci-resolved"))' "$TMP/comments.json")" ]
}
