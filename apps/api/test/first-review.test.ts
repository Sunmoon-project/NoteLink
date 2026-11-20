// 퀴즈를 끝낼 때 쓰는 처음 복습 상태(firstReview)가 처리기(apps/ai services/quiz/srs.py)의
// update(None, ok, today, at)와 같은 값인지 본다. 기대값은 srs.py를 그대로 돌려 얻은 값이고,
// srs.py의 상수가 바뀌면(첫 간격 · 끝 조건) 아래 상수 시험이 먼저 깨진다
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { firstReview } from '../src/quiz-sets/first-review.js';

const srsPy = readFileSync(
  fileURLToPath(new URL('../../ai/app/services/quiz/srs.py', import.meta.url)),
  'utf8',
);
const constant = (name: string) =>
  srsPy.match(new RegExp(`^${name} = (.+?)(?:\\s+#.*)?$`, 'm'))?.[1];

describe('firstReview: 처리기 srs.update(None, …)와 같은 값', () => {
  it('srs.py 상수가 이 계산의 가정과 같다(첫 간격 1일 · 한 번 풀어서는 끝나지 않음)', () => {
    expect(constant('REVIEW_STEPS_DAYS')).toMatch(/^\(1,/);
    expect(Number(constant('MASTER_STREAK'))).toBeGreaterThan(1);
    expect(Number(constant('MAX_REVIEWS'))).toBeGreaterThan(1);
  });

  // python: srs.update(None, ok, seoul_midnight(seoul_day(at)), at)
  it.each([
    ['서울 오전에 맞힘', '2026-11-20T01:00:00Z', true, '2026-11-20T15:00:00Z', 'right', 1],
    ['서울 오전에 틀림', '2026-11-20T01:00:00Z', false, '2026-11-20T15:00:00Z', 'wrong', 0],
    [
      'UTC로는 전날이지만 서울은 다음 날(서울 0시 30분)',
      '2026-11-20T15:30:00Z',
      true,
      '2026-11-21T15:00:00Z',
      'right',
      1,
    ],
    ['서울 밤 11시 59분에 틀림', '2026-11-20T14:59:00Z', false, '2026-11-20T15:00:00Z', 'wrong', 0],
  ])('%s', (_, at, ok, dueAt, lastResult, streak) => {
    expect(firstReview(ok, new Date(at))).toEqual({
      step: 0,
      dueAt: new Date(dueAt),
      lastResult,
      streak,
      reviews: 1,
      state: 'active',
      carriedReviews: 0,
    });
  });
});
