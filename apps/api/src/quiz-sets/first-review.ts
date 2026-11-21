// 퀴즈를 끝낼 때 쓰는 복습 상태(FR-37). 처리기(apps/ai services/quiz/srs.py)의 update와 같은 값이다.
// 형식 · 상수는 srs.py가 정한다. test/first-review.test.ts가 srs.py 상수와 값을 맞춘다
import { addDays, dayEnd } from '../review-reminders/review-remind.js';
import { seoulDate } from '../modules/session/study-time.js';

/** 다음 복습까지 날 수(srs.py REVIEW_STEPS_DAYS). 틀리면 첫 간격으로 돌아간다 */
export const REVIEW_STEPS_DAYS = [1, 3, 7] as const;
/** 연속으로 이만큼 맞히면 다 익힘(srs.py MASTER_STREAK) */
export const MASTER_STREAK = 2;
/** 이만큼 풀어도 못 익히면 그만 냄(srs.py MAX_REVIEWS) */
export const MAX_REVIEWS = 5;

type Srs = Record<string, unknown>;

/** 서울 날짜 day의 0시에서 days일 뒤(srs.py today + timedelta(days)) */
const dueAfter = (at: Date, days: number) => dayEnd(addDays(seoulDate(at), days - 1));

/**
 * 처음 푼 문제의 복습 상태 = srs.py update(None, ok, today, at). 첫 간격(1일)은 맞혀도 틀려도 같아서, 다음 서울 0시가
 * 복습 날짜다. checked: 만들 때 '정답 둘' 검사를 통과한 문제(맞춤 퀴즈 pass, #625)면 붙여 오늘의 복습이 다시 검사하지 않게 한다
 */
export function firstReview(ok: boolean, at: Date, checked = false): Srs {
  return {
    step: 0,
    dueAt: dayEnd(seoulDate(at)),
    lastResult: ok ? 'right' : 'wrong',
    streak: ok ? 1 : 0,
    reviews: 1,
    state: 'active',
    carriedReviews: 0,
    ...(checked ? { checked: true } : {}),
  };
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * 이미 복습 상태가 있는 문제를 한 번 더 풀었을 때 = srs.py update(prev, ok, today, at)(#625). 형식이 틀린 상태(step ·
 * streak · reviews가 정수가 아님)는 null: 처리기도 이 입력은 받지 않는다(review.py parse_srs).
 * 상태와 상관없이 계산한다(review.py run 1단계와 같음): moved · flawed · mastered · stopped 문제를 다시 풀어도 그 풀이로
 * 다시 셈해 active · mastered · stopped 중 하나가 된다. 다른 필드(movedTo · dueBefore · flaw · checked 등)는 그대로 둔다
 */
export function nextReview(prev: Srs, ok: boolean, at: Date): Srs | null {
  if (!isInt(prev['step']) || !isInt(prev['streak']) || !isInt(prev['reviews'])) return null;
  // review.py parse_srs: state가 없던 예전 기록은 복습 중, endedAt이 null이면 없는 것으로
  const s: Srs = { dueAt: null, lastResult: null, state: 'active', ...prev };
  if (s['endedAt'] == null) delete s['endedAt'];
  const step = prev['step'];
  const streak = prev['streak'];
  s['reviews'] = prev['reviews'] + 1;
  if (ok) {
    s['streak'] = streak + 1;
    s['step'] = Math.min(step + 1, REVIEW_STEPS_DAYS.length - 1);
    // python 인덱스와 같게(음수는 뒤에서부터)
    const days = REVIEW_STEPS_DAYS.at(s['step'] as number) ?? REVIEW_STEPS_DAYS[0];
    s['dueAt'] = dueAfter(at, days);
    s['lastResult'] = 'right';
  } else {
    s['streak'] = 0;
    s['step'] = 0;
    s['dueAt'] = dueAfter(at, REVIEW_STEPS_DAYS[0]);
    s['lastResult'] = 'wrong';
  }
  if ((s['streak'] as number) >= MASTER_STREAK) {
    s['state'] = 'mastered';
    s['dueAt'] = null;
  } else if ((s['reviews'] as number) >= MAX_REVIEWS) {
    s['state'] = 'stopped';
    s['dueAt'] = null;
  } else s['state'] = 'active';
  if (s['state'] === 'mastered' || s['state'] === 'stopped') s['endedAt'] = at;
  else delete s['endedAt'];
  return s;
}

/** 퀴즈를 끝낼 때 문제 하나에 쓸 복습 상태. first: 복습 상태가 없던 문제(처음 상태) */
export interface ReviewWrite {
  questionId: string;
  srs: Srs;
  first: boolean;
}

/**
 * 끝낸 풀이의 답으로 쓸 복습 상태를 정한다(#625).
 * - 무효 답(void: 결함 문제, 오늘의 복습이 정함)은 없는 풀이로 본다(review.py run과 같음)
 * - 복습 상태가 없는(null · {}) 문제: 처음 상태(firstReview). checked는 그 문제의 검사 표시
 * - 복습 상태가 있는 문제: auto(퀴즈를 끝낸 뒤 자동 오답 복습)가 켜져 있으면 그 처리기가 옮기므로 그대로 두고,
 *   꺼져 있으면 다음 상태(nextReview). 그 상태를 쓴 때(srsAt)가 이 풀이보다 늦으면 그대로 둔다(saveSrs의
 *   「더 새 것만」과 같음)
 */
export function reviewWrites(
  questions: { _id: { toString(): string }; srs?: unknown; srsAt?: Date; checked?: boolean }[],
  answers: { questionId: { toString(): string }; correct: boolean; void?: unknown }[],
  at: Date,
  auto: boolean,
): ReviewWrite[] {
  const byId = new Map(questions.map((q) => [q._id.toString(), q]));
  const out: ReviewWrite[] = [];
  const seen = new Set<string>();
  for (const a of answers) {
    const id = a.questionId.toString();
    const q = byId.get(id);
    if (!q || seen.has(id) || a.void === true || (typeof a.void === 'string' && a.void !== ''))
      continue;
    seen.add(id);
    const prev = q.srs;
    const none = prev == null || (typeof prev === 'object' && Object.keys(prev).length === 0);
    if (none) {
      out.push({
        questionId: id,
        srs: firstReview(a.correct, at, q.checked === true),
        first: true,
      });
      continue;
    }
    if (auto || typeof prev !== 'object' || (q.srsAt && q.srsAt > at)) continue;
    const next = nextReview(prev as Srs, a.correct, at);
    if (next) out.push({ questionId: id, srs: next, first: false });
  }
  return out;
}
