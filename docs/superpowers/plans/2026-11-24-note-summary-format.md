# 노트 정리 양식 고르기 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 필기 · 문서 노트를 만들 때와 「다시 만들기」 때 정리 양식(핵심 요약 · 문답 · 용어 정리 · 한눈 요약)을 고르고, 위쪽 요약 칸을 양식대로 그린다.

**Architecture:** AI 요약 호출은 한 번 그대로, 양식별 지침 · 스키마만 바꾸고 결과는 공통 `items[{head,text,refs}]`. API는 노트에 `summaryFormat`을 두고 작업 입력에 `format`을 실어 보내며, 결과를 옮길 때 `summary.items` · `summary.format`을 저장하고 `points`를 한 줄 글로 채운다. 앱은 공용 양식 시트와 양식별 요약 칸을 그린다.

**Tech Stack:** FastAPI(pytest) · NestJS/Mongoose(node:test) · Expo/React Native(jest) · zod(shared)

**Spec:** `docs/superpowers/specs/2026-11-23-note-summary-format-design.md`

## Global Constraints

- 양식 값: `points` · `qa` · `terms` · `brief`. 모르는 값 · 없음 → `points`.
- 개수: points 3~7(상한 7) · qa 상한 6 · terms 상한 8 · brief 상한 3. 앞말 ≤ 30자, 내용 ≤ 120자(넘으면 버림).
- `terms` 앞말은 노트 글에 글자 그대로 있어야 남김. 모든 항목은 refs가 보낸 문단 번호여야 함.
- 펴기: qa 「질문 — 답」, terms 「용어: 뜻」, 그 밖 내용.
- 녹음 노트는 `format`을 무시하고 앱에서 「다시 만들기」를 숨긴다.
- 다시 만들기에서 지금 양식과 같은 양식은 400. 새 양식은 성공해 옮길 때만 노트에 적는다.
- 다시 만들기 결과 항목 0개 → 실패 처리: 옛 결과 · 옛 양식 유지, 하루 횟수 1 되돌림.
- `summary.items` · `summary.format` · `Material.summaryFormat`은 모두 선택 필드(옛 노트 · 기기 저장 모드 호환).

## Review Focus

- 옛 노트(`summaryFormat` · `items` 없음): 앱은 「핵심 요약」 모양, 다시 만들기 시트는 `points`가 지금 양식 → Task 4 시험.
- 요약 편집(PATCH)이 `items` · `format`을 지우지 않음 → Task 2 시험.
- AI가 모르는 양식 문자열을 받음 → `points`로 → Task 1 시험.
- 다시 만들기 0개 → 하루 횟수 되돌림 → Task 2 시험.
- 문서 노트 첫 정리 0개 → 조각 제목으로 `points` 대체(지금 그대로) → Task 2 기존 시험 유지.

---

### Task 1: AI 양식별 요약 (`apps/ai`)

**Files:** Modify `app/services/note/summary.py`, `app/services/note/job.py` · Test `tests/.../test_summary*.py`

**Interfaces:**
- Produces: `summarize_note(llm, model, chunks, fmt: str = "points") -> NoteSummary | None`; `NoteSummary = {format, items: list[{head: str|None, text: str}], points, keywords, headings}`. job은 `inp.get("format")`을 넘김.

- [ ] 시험: 양식별 스키마 · 검사(refs 밖 버림, terms 앞말 글자 그대로, 길이 초과 버림, 개수 상한, 모르는 양식 → points, points 펴기)
- [ ] 구현 · 통과 · 커밋

### Task 2: API 양식 저장 · 다시 만들기 (`packages/shared`, `apps/api`)

**Files:** `packages/shared/src/schemas.ts`(SummaryFormat, Material.summary.items/format, Material.summaryFormat), DTO(create · regenerate body), `materials.service.ts`(jobInput format, regenerate format · 400, syncRegen 0개 실패 · 횟수 되돌림 · 성공 때 summaryFormat), `material-sync.ts`(items · format 옮기기, points 펴기), `material-view.ts`, 요약 편집 보존.

- [ ] 시험: 등록 · 다시 만들기 입력 `format`, 같은 양식 400, 성공 때만 양식 바꿈, 0개 → 옛 결과 · 횟수 반환, 펴기, PATCH가 items 보존, 녹음 무시
- [ ] 구현 · 통과 · 커밋

### Task 3: 앱 양식 시트 · 요청 (`apps/mobile`)

**Files:** `features/content/format-sheet.tsx`(새), `convert.tsx`(등록 전 시트 · 다시 만들기 시트 · 녹음 숨김), `lib/api/types.ts` · `http-api.ts` · `lib/local/api.ts`, `stores/draft.ts`

- [ ] 시험: 시트 선택 → createMaterial `format`, 다시 만들기 시트 지금 양식 비활성 → regenerate(id, format), 녹음 버튼 없음
- [ ] 구현 · 통과 · 커밋

### Task 4: 앱 양식별 요약 칸 (`apps/mobile`)

**Files:** `convert.tsx`(`SummaryCard`), `detail.tsx`(필기 상세 새 요약 칸 · 문서 상세 · `summaryMarkdown`)

- [ ] 시험: 양식별 그리기(qa 질문 굵게 · terms 칩 · brief 제목), items 없는 옛 노트는 points, 마크다운 양식대로
- [ ] 구현 · 통과 · 커밋
