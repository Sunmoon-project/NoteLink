// 처음 푼 문제의 복습 상태(FR-37). 처리기(apps/ai services/quiz/srs.py)의 update(None, ok, today, at)와 같은 값이다:
// 첫 간격(REVIEW_STEPS_DAYS[0] = 1일)은 맞혀도 틀려도 같아서, 다음 서울 0시가 복습 날짜다.
// 형식 · 상수는 srs.py가 정한다. test/first-review.test.ts가 srs.py 상수와 값을 맞춘다
import { dayEnd } from '../review-reminders/review-remind.js';
import { seoulDate } from '../modules/session/study-time.js';

export function firstReview(ok: boolean, at: Date): Record<string, unknown> {
  return {
    step: 0,
    dueAt: dayEnd(seoulDate(at)),
    lastResult: ok ? 'right' : 'wrong',
    streak: ok ? 1 : 0,
    reviews: 1,
    state: 'active',
    carriedReviews: 0,
  };
}
