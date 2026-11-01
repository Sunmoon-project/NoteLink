#!/usr/bin/env bash
# PR을 Codex로 리뷰하고, 결과를 내 계정의 PR 댓글로 남깁니다.
#
#   scripts/codex-review.sh <PR번호> [--dry-run]
#
# - 먼저 PR 최신 커밋의 CI(lint · typecheck · build · test) 결과를 확인합니다.
#   실행 중이면 끝날 때까지 기다리고, 실패했으면 Codex 리뷰 대신 실패 로그를 댓글로 남깁니다.
# - 처음 실행: PR 전체 변경을 리뷰합니다(치명적 문제 / 중요 / 제안 / 좋았던 점 / 권장 조치).
# - 다시 실행: 지난 Codex 리뷰 이후의 새 커밋을 보고, 이전 지적이 반영됐는지 먼저 확인합니다(재리뷰).
# - CI 실패 알림에는 검사 SHA를 표시하고, 최신 CI 성공 뒤 과거 실패 안내를 해결 표시합니다.
# - 게시 전 HEAD가 바뀌었으면 오래된 결과를 올리지 않습니다. 같은 SHA의 실패는 기존 댓글을 갱신합니다.
# - --dry-run: 댓글을 올리거나 갱신하지 않고 결과만 보여 줍니다.
#
# 필요한 것: git, gh(로그인), codex(로그인). 현재 작업 폴더는 건드리지 않고
# 임시 worktree에서 리뷰합니다. 리뷰 기준은 AGENTS.md의 Code Review Rules입니다.
#
# 테스트: scripts/tests/codex-review.bats (source하면 main은 실행되지 않습니다)

MARKER="codex-review"
CI_WORKFLOW="CI"
CI_RESULT_JOB="CI 결과"
MAX_DIFF_LINES="${MAX_DIFF_LINES:-4000}"
MAX_LOG_LINES="${MAX_LOG_LINES:-40}"
CI_WAIT_TRIES="${CI_WAIT_TRIES:-90}"      # 20초 × 90 = 최대 30분
CI_WAIT_SECONDS="${CI_WAIT_SECONDS:-20}"
EX=( ':(exclude).env' ':(exclude).env.*' ':(exclude)**/.env' ':(exclude)**/.env.*'
     ':(exclude)package-lock.json' ':(exclude)**/package-lock.json' )

# gh --jq 필터 (테스트에서 jq로 같은 필터를 검증합니다)
# 내 댓글 중 Codex 리뷰 표시가 있는 것: created_at \t id   ($me, $marker는 --arg 대신 문자열로 끼움)
prev_review_jq() {  # $1 = 내 로그인
  printf '.[] | select(.user.login == "%s" and (.body | contains("<!-- %s sha="))) | [.created_at, .id] | @tsv' "$1" "$MARKER"
}
# 같은 커밋의 CI 실행 중 가장 최근 것: id \t status
RUNS_JQ='[.workflow_runs[] | select(.name == "'"$CI_WORKFLOW"'")] | sort_by(.created_at) | last // empty | [.id, .status] | @tsv'
# 실행의 job 목록: conclusion \t name \t job id \t url
JOBS_JQ='.jobs[] | [(.conclusion // "none"), .name, .id, .html_url] | @tsv'

# 댓글 본문 끝의 <!-- codex-review sha=... round=... --> 에서 "sha round"를 꺼냄 (없으면 빈 출력)
parse_marker() {  # $1 = 댓글 본문
  sed -n "s/.*<!-- $MARKER sha=\([0-9a-f]\{1,\}\) round=\([0-9]\{1,\}\) -->.*/\1 \2/p" <<< "$1" | tail -n 1
}

# 같은 커밋의 CI 실행을 조회해 RUN_ID · RUN_STATUS를 채움 (없으면 둘 다 빈 값)
ci_run() {
  RUN_ID=""; RUN_STATUS=""
  read -r RUN_ID RUN_STATUS < <(gh api "repos/$REPO/actions/runs?head_sha=$HEAD_SHA&event=pull_request" \
    --jq "$RUNS_JQ" 2>/dev/null || true) || true
}

# CI가 끝날 때까지 기다림. 끝났으면 0, 실행이 없거나 시간 안에 안 끝나면 1
ci_wait() {
  ci_run
  [ "$RUN_STATUS" = "completed" ] && return 0
  echo "▶ CI가 아직 실행 중입니다. 끝날 때까지 기다립니다..."
  local i
  for (( i = 0; i < CI_WAIT_TRIES; i++ )); do
    sleep "$CI_WAIT_SECONDS"
    ci_run
    [ "$RUN_STATUS" = "completed" ] && return 0
  done
  return 1
}

ci_result() {  # $1 = jobs.tsv → "CI 결과" job의 conclusion (없으면 빈 출력)
  awk -F '\t' -v job="$CI_RESULT_JOB" '$2 == job { print $1; exit }' "$1"
}

failed_jobs() {  # $1 = jobs.tsv → 실패 · 취소 · 시간 초과 job 줄만
  awk -F '\t' '$1 == "failure" || $1 == "cancelled" || $1 == "timed_out"' "$1"
}

# 게시 직전에 다시 확인한다. 2는 새 커밋이 들어온 정상적인 생략, 1은 조회 오류다.
current_review_head() {
  local latest
  if ! latest=$(gh pr view "$PR" -R "$REPO" --json headRefOid --jq .headRefOid); then
    echo "PR 최신 커밋 조회 실패: 결과 게시를 보류합니다." >&2
    return 1
  fi
  if [ -z "$latest" ]; then
    echo "PR 최신 커밋이 비어 있어 결과 게시를 보류합니다." >&2
    return 1
  fi
  if [ "$latest" != "$HEAD_SHA" ]; then
    echo "PR 커밋 변경(${HEAD_SHA:0:7} → ${latest:0:7}): 이전 결과 게시를 생략합니다." >&2
    return 2
  fi
}

# 리뷰 계정 자신의 미해결 CI 실패 안내만 고른다. 일반 코드 리뷰는 정리하지 않는다.
ci_comments_jq() {
  printf '.[] | select(.user.login == "%s" and (.body | contains("<!-- %s-ci sha=")) and (.body | contains("<!-- %s-ci-resolved ") | not)) | .id' "$1" "$MARKER" "$MARKER"
}

parse_ci_marker() {
  sed -n "s/.*<!-- $MARKER-ci sha=\([0-9a-f]\{1,\}\) -->.*/\1/p" <<< "$1" | tail -n 1
}

publish_review_comment() {  # $1 = 본문 파일, $2 = 갱신할 댓글 ID (없으면 새 댓글)
  current_review_head || return $?
  local file="$1" id="${2:-}" payload
  if $DRY_RUN; then
    echo "----- (dry-run) 게시·갱신할 댓글 ${id:-new} -----"
    cat "$file"
  elif [ -n "$id" ]; then
    payload="$WORK/comment-$id.json"
    jq -n --rawfile body "$file" '{body:$body}' > "$payload" || return 1
    gh api "repos/$REPO/issues/comments/$id" --method PATCH --input "$payload" >/dev/null || return 1
  else
    gh pr comment "$PR" -R "$REPO" --body-file "$file" >/dev/null || return 1
  fi
}

post_ci_failure() {  # 같은 커밋의 실패 알림은 중복 생성하지 않는다.
  local ids id body existing=""
  ids=$(gh api --paginate "repos/$REPO/issues/$PR/comments" --jq "$(ci_comments_jq "$ME")") || return 1
  for id in $ids; do
    body=$(gh api "repos/$REPO/issues/comments/$id" --jq .body) || return 1
    if [ "$(parse_ci_marker "$body")" = "$HEAD_SHA" ]; then existing="$id"; break; fi
  done
  publish_review_comment "$1" "$existing"
}

resolve_ci_failures() {
  [ "$CI_RESULT" = success ] || return 0
  local ids id body previous file
  ids=$(gh api --paginate "repos/$REPO/issues/$PR/comments" --jq "$(ci_comments_jq "$ME")") || return 1
  for id in $ids; do
    body=$(gh api "repos/$REPO/issues/comments/$id" --jq .body) || return 1
    previous=$(parse_ci_marker "$body")
    [ -n "$previous" ] || continue
    file="$WORK/resolved-$id.md"
    {
      echo "### 🤖 Codex 자동 검증 — 해결됨 ✅"
      echo
      echo "과거 커밋 \`${previous:0:7}\`의 실패 기록입니다. 후속 검사에서 커밋 \`${HEAD_SHA:0:7}\`의 **[CI 결과가 통과](https://github.com/$REPO/actions/runs/$RUN_ID)**해 이 실패는 해결됐습니다."
      echo
      echo "아래는 원래 검사 당시의 기록이며, 후속 커밋의 실패를 뜻하지 않습니다."
      echo
      echo '<details><summary>과거 실패 원문과 로그</summary>'
      echo
      printf '%s\n' "$body"
      echo
      echo '</details>'
      echo
      echo "<!-- $MARKER-ci-resolved sha=$HEAD_SHA previous=$previous -->"
    } > "$file"
    publish_review_comment "$file" "$id" || return $?
  done
}

# 파일 단위로 diff를 모읍니다. 줄 수 한도(MAX_DIFF_LINES)를 넘는 파일은 중간에 자르지 않고
# 통째로 빼서 "$2.omitted"에 적고, Codex가 직접 열어 보도록 프롬프트에 목록으로 넘깁니다.
build_diff() {  # $1 = 범위, $2 = 출력 파일 (저장소 위치는 $WT)
  : > "$2"; : > "$2.omitted"
  local used=0 f part n
  while IFS= read -r -d '' f; do
    part=$(git -C "$WT" diff "$1" -- "$f")
    n=$(printf '%s\n' "$part" | wc -l | tr -d ' ')
    if [ $(( used + n )) -le "$MAX_DIFF_LINES" ]; then
      printf '%s\n' "$part" >> "$2"
      used=$(( used + n ))
    else
      printf '%s\t%s\n' "$f" "$n" >> "$2.omitted"
    fi
  done < <(git -C "$WT" diff -z --name-only "$1" -- . "${EX[@]}")
}

omitted_note() {  # $1 = 범위, $2 = diff 파일
  [ -s "$2.omitted" ] || return 0
  echo
  echo "**분량 때문에 위 디프에서 빠진 파일 — 반드시 아래 명령으로 직접 열어 리뷰하세요:**"
  local f n
  while IFS=$'\t' read -r f n; do
    echo "- \`$f\` (${n}줄) → \`git diff $1 -- '$f'\`"
  done < "$2.omitted"
}

# 결과에 임시 폴더 경로가 섞이면 저장소 기준 경로로 바꾸기
strip_prefix() {
  # -v는 역슬래시를 이스케이프로 읽어 Windows 경로가 깨지므로 환경 변수로 넘김
  P="$1" awk 'BEGIN { p = ENVIRON["P"] } p != "" { while ((i = index($0, p)) > 0) $0 = substr($0, 1, i - 1) substr($0, i + length(p)) } { print }'
}

main() {
  set -euo pipefail

  PR="${1:-}"
  DRY_RUN=false
  [ "${2:-}" = "--dry-run" ] && DRY_RUN=true
  if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
    echo "사용법: scripts/codex-review.sh <PR번호> [--dry-run]" >&2
    exit 1
  fi

  cd "$(git rev-parse --show-toplevel)"
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  ME=$(gh api user --jq .login)

  read -r STATE BASE HEAD_SHA < <(gh pr view "$PR" --json state,baseRefName,headRefOid \
    --jq '[.state, .baseRefName, .headRefOid] | @tsv')
  TITLE=$(gh pr view "$PR" --json title --jq .title)
  if [ "$STATE" != "OPEN" ]; then
    echo "PR #$PR 은(는) 열려 있지 않습니다 ($STATE)." >&2
    exit 1
  fi
  echo "▶ PR #$PR \"$TITLE\" ($BASE ← ${HEAD_SHA:0:7})"

  # ---------- 지난 Codex 리뷰 ----------
  PREV_ID=$(gh api --paginate "repos/$REPO/issues/$PR/comments" --jq "$(prev_review_jq "$ME")" \
    | sort | tail -n 1 | cut -f 2)
  PREV_BODY=""; PREV_SHA=""; ROUND=1
  if [ -n "$PREV_ID" ]; then
    PREV_BODY=$(gh api "repos/$REPO/issues/comments/$PREV_ID" --jq .body)
    read -r PREV_SHA PREV_ROUND <<< "$(parse_marker "$PREV_BODY")" || true
    ROUND=$(( ${PREV_ROUND:-1} + 1 ))
  fi

  WORK=$(mktemp -d)
  WT="$WORK/pr-$PR"
  trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

  post() {  # 변경된 HEAD는 정상 생략하고, 게시 오류는 실패로 전달한다.
    local result=0
    publish_review_comment "$1" || result=$?
    [ "$result" -ne 2 ] || exit 0
    return "$result"
  }

  if [ "$ROUND" -eq 1 ]; then
    HEADING="### 🤖 Codex 리뷰 · PR #$PR"
  else
    HEADING="### 🤖 Codex 재리뷰 (${ROUND}차) · PR #$PR"
  fi

  # ---------- CI 결과 확인 (PR 최신 커밋에 pull_request 이벤트로 돈 CI 워크플로 기준) ----------
  if ! ci_wait || [ -z "$RUN_ID" ]; then
    echo "CI 상태를 확인하지 못했습니다(${RUN_STATUS:-CI 실행 없음}). 댓글을 남기지 않고 멈춥니다." >&2
    echo "PR 화면의 Checks 탭을 확인한 뒤 다시 실행하세요." >&2
    exit 1
  fi
  JOBS="$WORK/jobs.tsv"
  gh api "repos/$REPO/actions/runs/$RUN_ID/jobs" --jq "$JOBS_JQ" > "$JOBS"
  CI_RESULT=$(ci_result "$JOBS")
  if [ -z "$CI_RESULT" ]; then
    echo "CI 실행 $RUN_ID 에서 '$CI_RESULT_JOB' job을 찾지 못했습니다. 댓글을 남기지 않고 멈춥니다." >&2
    exit 1
  fi

  current_review_head || { result=$?; [ "$result" -ne 2 ] || exit 0; exit "$result"; }

  if [ "$CI_RESULT" != "success" ]; then
    echo "▶ CI 결과: $CI_RESULT — Codex 리뷰 대신 실패 내용을 남깁니다."
    BODY_FILE="$WORK/body.md"
    {
      echo "$HEADING"
      echo
      echo "**자동 검증(lint·typecheck·build·test): 실패/중단 ($CI_RESULT) ❌**"
      echo
      echo "**검사 대상: [\`${HEAD_SHA:0:7}\`](https://github.com/$REPO/commit/$HEAD_SHA) · [CI 실행](https://github.com/$REPO/actions/runs/$RUN_ID)**"
      echo
      echo "_이 결과는 표시된 커밋의 검사 기록입니다. 후속 커밋의 상태와 구분해 주세요._"
      echo
      echo "---"
      echo
      echo "_자동 검증이 통과하지 않아 Codex 리뷰를 실행하지 않았습니다. 고친 뒤 다시 요청해 주세요._"
      failed_jobs "$JOBS" | while IFS=$'\t' read -r conclusion name job_id link; do
        echo
        echo "#### ❌ \`$name\` — $conclusion · [로그 열기]($link)"
        [ "$name" = "$CI_RESULT_JOB" ] && continue
        LOG=$(gh run view --job "$job_id" -R "$REPO" --log-failed 2>/dev/null | cut -f 3- | sed 's/^[0-9T:.-]*Z //' | tail -n "$MAX_LOG_LINES" | sed "s/\`\`\`/'''/g")
        if [ -n "$LOG" ]; then
          echo
          echo "<details><summary>로그 끝부분 ${MAX_LOG_LINES}줄</summary>"
          echo
          echo '```'
          echo "$LOG"
          echo '```'
          echo
          echo "</details>"
        fi
      done
      echo
      echo "<!-- $MARKER-ci sha=$HEAD_SHA -->"
    } > "$BODY_FILE"
    post_ci_failure "$BODY_FILE" || { result=$?; [ "$result" -ne 2 ] || exit 0; exit "$result"; }
    exit 0
  fi
  echo "▶ CI 통과 ✅"
  # 같은 커밋의 코드 리뷰가 이미 있어도, 성공한 CI의 과거 실패 안내는 먼저 정리한다.
  resolve_ci_failures || {
    result=$?
    [ "$result" -ne 2 ] || exit 0
    echo "::warning::과거 CI 댓글 정리에 실패했습니다. 코드 리뷰는 계속합니다."
  }
  if [ -n "$PREV_SHA" ] && [ "$PREV_SHA" = "$HEAD_SHA" ]; then
    echo "마지막 Codex 리뷰(${PREV_SHA:0:7}) 이후 새 커밋이 없습니다."
    exit 0
  fi

  # ---------- diff 준비 ----------
  git fetch -q origin "+refs/heads/$BASE:refs/remotes/origin/$BASE" "+refs/pull/$PR/head:refs/codex-review/pr-$PR"
  git worktree add -q --detach "$WT" "$HEAD_SHA"
  BASE_SHA=$(git merge-base "origin/$BASE" "$HEAD_SHA")
  git -C "$WT" diff --stat "$BASE_SHA...HEAD" -- . "${EX[@]}" > "$WORK/stat.txt" || true
  build_diff "$BASE_SHA...HEAD" "$WORK/pr.diff"

  INCREMENTAL=false
  if [ -n "$PREV_SHA" ] && git merge-base --is-ancestor "$PREV_SHA" "$HEAD_SHA" 2>/dev/null; then
    INCREMENTAL=true
    build_diff "$PREV_SHA..HEAD" "$WORK/new.diff"
  fi

  # ---------- Codex 입력 ----------
  PROMPT="$WORK/prompt.md"
  {
    cat <<'EOF'
# 역할
당신은 이 저장소(NoteLink)를 잘 아는 시니어 코드 리뷰어입니다. 아래 변경 디프를 근거로 이 PR을 한국어로 리뷰하세요.
자동 검증(lint·typecheck·build·test)은 이미 통과한 상태이므로, 코드 품질·설계·보안·경계조건 위주로 봅니다.
read-only 권한으로 저장소 파일을 열어 맥락을 확인해도 됩니다.
디프 아래에 "빠진 파일" 목록이 있으면, 적힌 git diff 명령으로 그 파일들을 모두 직접 열어 리뷰에 포함하세요.
리뷰 기준은 저장소 루트 AGENTS.md의 "Code Review Rules"와 README.md 5장 "개발 규칙"입니다.

# 출력 규칙 (반드시)
EOF
    if [ -n "$PREV_BODY" ]; then
      cat <<'EOF'
- 이번은 재리뷰입니다. 아래 6개 섹션 제목을 정확히 이 순서·문구로. 다른 상위 제목/서문/맺음말 금지.
- 각 섹션에 내용이 없으면 한 줄로 명시("발견된 코드 레벨 차단 이슈는 없습니다." / "없습니다.").
- 추측 금지. 디프에 실제로 있는 근거만, 파일경로/함수명을 구체적으로 인용. 간결하게(각 항목 한두 문장).

## 이전 리뷰 반영 확인
아래 "지난 리뷰"의 치명적 문제·중요·제안·권장 조치 항목을 하나씩 "✅ 해결됨 / ⚠️ 부분 해결 / ❌ 미해결"로 표시하고 근거(파일경로/함수명)를 한 문장으로. 지난 리뷰에 지적이 없었으면: "지난 리뷰에 지적 사항이 없었습니다."
## 치명적 문제
이번 변경에서 새로 생겼거나 아직 남아 있는, 머지를 막아야 하는 문제(크래시, 데이터 손상, 보안 취약점, 명백한 버그). 없으면: "발견된 코드 레벨 차단 이슈는 없습니다."
EOF
    else
      cat <<'EOF'
- 아래 5개 섹션 제목을 정확히 이 순서·문구로. 다른 상위 제목/서문/맺음말 금지.
- 각 섹션에 내용이 없으면 한 줄로 명시("발견된 코드 레벨 차단 이슈는 없습니다." / "없습니다.").
- 추측 금지. 디프에 실제로 있는 근거만, 파일경로/함수명을 구체적으로 인용. 간결하게(각 항목 한두 문장).

## 치명적 문제
머지를 막아야 하는 문제(크래시, 데이터 손상, 보안 취약점, 명백한 버그). 없으면: "발견된 코드 레벨 차단 이슈는 없습니다."
EOF
    fi
    cat <<'EOF'
## 중요
당장 머지를 막진 않지만 곧 고쳐야 할 것. 없으면: "없습니다."
## 제안
선택적 개선. 없으면: "없습니다."
## 좋았던 점
이 PR에서 잘한 부분 2~4가지.
## 권장 조치
구체적인 다음 행동. 없으면: "없습니다."
EOF
    echo
    echo "---"
    echo "## PR 메타"
    echo "- 저장소: $REPO"
    echo "- PR: #$PR \"$TITLE\""
    echo "- base 브랜치: $BASE"
    echo "- 최신 커밋: $HEAD_SHA"
    echo "- 자동 검증(lint·typecheck·build·test): 통과"
    if [ -n "$PREV_BODY" ]; then
      echo
      echo "## 지난 리뷰 (${PREV_SHA:0:7} 기준)"
      sed "/<!-- $MARKER /d" <<< "$PREV_BODY"
      echo
      if $INCREMENTAL; then
        echo "## 지난 리뷰 이후 새 변경 디프 (${PREV_SHA:0:7}..HEAD)"
        echo '```diff'; cat "$WORK/new.diff"; echo '```'
        omitted_note "$PREV_SHA..HEAD" "$WORK/new.diff"
      else
        echo "_지난 리뷰 이후 히스토리가 바뀌었습니다(force push 등). 아래 PR 전체 디프로 확인하세요._"
      fi
    fi
    echo
    echo "## 변경 요약 (diff --stat)"
    echo '```'; cat "$WORK/stat.txt"; echo '```'
    echo
    echo "## PR 전체 변경 디프 (base...HEAD)"
    echo '```diff'; cat "$WORK/pr.diff"; echo '```'
    omitted_note "$BASE_SHA...HEAD" "$WORK/pr.diff"
  } > "$PROMPT"

  echo "▶ Codex 리뷰 중... ($( [ "$ROUND" -eq 1 ] && echo 1차 || echo "${ROUND}차 재리뷰" ))"
  REVIEW="$WORK/review.md"
  ( cd "$WT" && codex exec --sandbox read-only --output-last-message "$REVIEW" - < "$PROMPT" > "$WORK/codex.log" 2>&1 ) || true
  if [ ! -s "$REVIEW" ]; then
    echo "codex 실행 실패. 로그 마지막 부분:" >&2
    tail -n 20 "$WORK/codex.log" >&2
    exit 1
  fi

  WIN_WT=$(cygpath -w "$WT" 2>/dev/null || true)
  BODY_FILE="$WORK/body.md"
  {
    echo "$HEADING"
    echo
    if [ -n "$PREV_BODY" ]; then
      echo "**자동 검증(lint·typecheck·build·test): 통과 ✅** — 지난 리뷰(\`${PREV_SHA:0:7}\`) 이후 \`${HEAD_SHA:0:7}\`까지의 변경을 다시 봤습니다."
    else
      echo "**자동 검증(lint·typecheck·build·test): 통과 ✅** — 아래는 코드 리뷰입니다."
    fi
    echo
    echo "---"
    echo
    strip_prefix "${WIN_WT:+$WIN_WT\\}" < "$REVIEW" | strip_prefix "$WT/"
    echo
    echo "<!-- $MARKER sha=$HEAD_SHA round=$ROUND -->"
  } > "$BODY_FILE"

  post "$BODY_FILE"
  $DRY_RUN || echo "  괜찮으면 승인: gh pr review $PR --approve"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
