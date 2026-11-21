// 퀴즈를 끝낼 때 쓰는 복습 상태(firstReview · nextReview)가 처리기(apps/ai services/quiz/srs.py)의
// update(prev, ok, today, at)와 같은 값인지 본다. 기대값은 srs.py를 그대로 돌려 얻은 값이고,
// srs.py의 상수가 바뀌면(간격 · 끝 조건) 아래 상수 시험이 먼저 깨진다
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  firstReview,
  MASTER_STREAK,
  MAX_REVIEWS,
  nextReview,
  REVIEW_STEPS_DAYS,
  reviewWrites,
} from '../src/quiz-sets/first-review.js';

const srsPy = readFileSync(
  fileURLToPath(new URL('../../ai/app/services/quiz/srs.py', import.meta.url)),
  'utf8',
);
const constant = (name: string) =>
  srsPy.match(new RegExp(`^${name} = (.+?)(?:\\s+#.*)?$`, 'm'))?.[1];

describe('firstReview: 처리기 srs.update(None, …)와 같은 값', () => {
  it('srs.py 상수가 이 계산의 상수와 같다(간격 1 · 3 · 7일, 연속 2번 다 익힘, 5번 그만)', () => {
    expect(constant('REVIEW_STEPS_DAYS')).toBe(`(${REVIEW_STEPS_DAYS.join(', ')})`);
    expect(Number(constant('MASTER_STREAK'))).toBe(MASTER_STREAK);
    expect(Number(constant('MAX_REVIEWS'))).toBe(MAX_REVIEWS);
    expect([...REVIEW_STEPS_DAYS]).toEqual([1, 3, 7]);
    expect([MASTER_STREAK, MAX_REVIEWS]).toEqual([2, 5]);
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
    const want = {
      step: 0,
      dueAt: new Date(dueAt),
      lastResult,
      streak,
      reviews: 1,
      state: 'active',
      carriedReviews: 0,
    };
    expect(firstReview(ok, new Date(at))).toEqual(want);
    // 복습 상태가 없던 문제의 다음 상태도 같다(srs.update(None, …))
    expect(firstReview(ok, new Date(at), true)).toEqual({ ...want, checked: true });
  });
});

describe('nextReview: 처리기 srs.update(prev, …)와 같은 값(#625)', () => {
  const AT = new Date('2026-11-20T01:00:00Z'); // 서울 11/20 10시
  const LATE = new Date('2026-11-20T15:30:00Z'); // 서울 11/21 0시 30분
  const day = (iso: string) => new Date(iso);
  const first = firstReview(true, AT);

  // 기대값: srs.update(prev, ok, seoul_midnight(seoul_day(at)), at)를 그대로 돌린 값
  it.each([
    [
      '처음 맞히고 다음에 또 맞히면 연속 2번 → 다 익힘(mastered), 날짜 없음, endedAt = 푼 시각',
      first,
      true,
      AT,
      {
        step: 1,
        dueAt: null,
        lastResult: 'right',
        streak: 2,
        reviews: 2,
        state: 'mastered',
        carriedReviews: 0,
        endedAt: AT,
      },
    ],
    [
      '틀리면 step 0 · 연속 0 · 다음 날',
      first,
      false,
      AT,
      {
        step: 0,
        dueAt: day('2026-11-20T15:00:00Z'),
        lastResult: 'wrong',
        streak: 0,
        reviews: 2,
        state: 'active',
        carriedReviews: 0,
      },
    ],
    [
      'step 0에서 맞히면 3일 뒤',
      {
        step: 0,
        dueAt: null,
        lastResult: 'wrong',
        streak: 0,
        reviews: 2,
        state: 'active',
        carriedReviews: 0,
      },
      true,
      AT,
      {
        step: 1,
        dueAt: day('2026-11-22T15:00:00Z'),
        lastResult: 'right',
        streak: 1,
        reviews: 3,
        state: 'active',
        carriedReviews: 0,
      },
    ],
    [
      'step 1에서 맞히면 7일 뒤(서울 0시 30분: 서울 날짜로 셈)',
      { step: 1, dueAt: null, lastResult: 'wrong', streak: 0, reviews: 2, state: 'active' },
      true,
      LATE,
      {
        step: 2,
        dueAt: day('2026-11-27T15:00:00Z'),
        lastResult: 'right',
        streak: 1,
        reviews: 3,
        state: 'active',
      },
    ],
    [
      'step 2에서 맞혀도 7일(마지막 간격)',
      { step: 2, dueAt: null, lastResult: 'wrong', streak: 0, reviews: 3, state: 'active' },
      true,
      AT,
      {
        step: 2,
        dueAt: day('2026-11-26T15:00:00Z'),
        lastResult: 'right',
        streak: 1,
        reviews: 4,
        state: 'active',
      },
    ],
    [
      '5번째 풀이에서 틀리면 그만(stopped)',
      { step: 0, dueAt: null, lastResult: 'wrong', streak: 0, reviews: 4, state: 'active' },
      false,
      AT,
      {
        step: 0,
        dueAt: null,
        lastResult: 'wrong',
        streak: 0,
        reviews: 5,
        state: 'stopped',
        endedAt: AT,
      },
    ],
    [
      '5번째 풀이에서 맞혀도 연속이 아니면 그만(stopped)',
      { step: 0, dueAt: null, lastResult: 'wrong', streak: 0, reviews: 4, state: 'active' },
      true,
      AT,
      {
        step: 1,
        dueAt: null,
        lastResult: 'right',
        streak: 1,
        reviews: 5,
        state: 'stopped',
        endedAt: AT,
      },
    ],
    [
      '넘겨준(moved) 문제를 다시 풀면 review.py처럼 다시 셈해 복습 중으로(movedTo · dueBefore는 그대로)',
      {
        step: 0,
        dueAt: null,
        lastResult: 'wrong',
        streak: 0,
        reviews: 1,
        state: 'moved',
        movedTo: 'abc',
        dueBefore: day('2026-11-19T15:00:00Z'),
      },
      true,
      AT,
      {
        step: 1,
        dueAt: day('2026-11-22T15:00:00Z'),
        lastResult: 'right',
        streak: 1,
        reviews: 2,
        state: 'active',
        movedTo: 'abc',
        dueBefore: day('2026-11-19T15:00:00Z'),
      },
    ],
    [
      '다 익힌(mastered) 문제를 다시 풀어 틀리면 복습 중으로 돌아가고 endedAt을 지운다',
      {
        step: 1,
        dueAt: null,
        lastResult: 'right',
        streak: 2,
        reviews: 2,
        state: 'mastered',
        endedAt: day('2026-11-18T01:00:00Z'),
      },
      false,
      AT,
      {
        step: 0,
        dueAt: day('2026-11-20T15:00:00Z'),
        lastResult: 'wrong',
        streak: 0,
        reviews: 3,
        state: 'active',
      },
    ],
    [
      '그만 낸(stopped) 문제를 다시 풀면 그대로 그만이고 endedAt은 이번 시각',
      {
        step: 0,
        dueAt: null,
        lastResult: 'wrong',
        streak: 0,
        reviews: 5,
        state: 'stopped',
        endedAt: day('2026-11-18T01:00:00Z'),
      },
      true,
      AT,
      {
        step: 1,
        dueAt: null,
        lastResult: 'right',
        streak: 1,
        reviews: 6,
        state: 'stopped',
        endedAt: AT,
      },
    ],
  ])('%s', (_, prev, ok, at, want) => {
    expect(nextReview(prev as Record<string, unknown>, ok, at)).toEqual(want);
  });

  it('state가 없던 예전 기록은 복습 중으로 보고, 받은 상태 객체는 바꾸지 않는다', () => {
    const prev = { step: 0, streak: 0, reviews: 1 };
    expect(nextReview(prev, false, AT)).toMatchObject({
      state: 'active',
      reviews: 2,
      lastResult: 'wrong',
    });
    expect(prev).toEqual({ step: 0, streak: 0, reviews: 1 });
  });

  it('step · streak · reviews가 정수가 아니면 계산하지 않는다(null)', () => {
    expect(nextReview({ step: '1', streak: 0, reviews: 1 }, true, AT)).toBeNull();
    expect(nextReview({ step: 0, reviews: 1 }, true, AT)).toBeNull();
  });
});

describe('reviewWrites: 끝낸 풀이로 쓸 복습 상태(#625)', () => {
  const AT = new Date('2026-11-20T01:00:00Z');
  const id = () => new Types.ObjectId();
  const active = {
    step: 0,
    dueAt: new Date('2026-11-20T15:00:00Z'),
    lastResult: 'right',
    streak: 1,
    reviews: 1,
    state: 'active',
  };

  it('자동 오답 복습이 꺼져 있으면: 없는 문제는 처음 상태, 있는 문제는 다음 상태', () => {
    const [a, b] = [id(), id()];
    const out = reviewWrites(
      [
        { _id: a, srs: null },
        { _id: b, srs: active },
      ],
      [
        { questionId: a, correct: false },
        { questionId: b, correct: true },
      ],
      AT,
      false,
    );
    expect(out).toEqual([
      { questionId: a.toString(), srs: firstReview(false, AT), first: true },
      { questionId: b.toString(), srs: nextReview(active, true, AT), first: false },
    ]);
    expect(out[1]!.srs).toMatchObject({ state: 'mastered' });
  });

  it('자동 오답 복습이 켜져 있으면 처음 상태만 쓴다(있는 문제는 그 처리기가 옮김: 두 번 세지 않게)', () => {
    const [a, b] = [id(), id()];
    const out = reviewWrites(
      [
        { _id: a, srs: null },
        { _id: b, srs: active },
      ],
      [
        { questionId: a, correct: true },
        { questionId: b, correct: true },
      ],
      AT,
      true,
    );
    expect(out).toEqual([{ questionId: a.toString(), srs: firstReview(true, AT), first: true }]);
  });

  it('무효 답(true · 이유 글)은 없는 풀이로 보고, 빈 글 · false는 셈한다', () => {
    const qs = [id(), id(), id(), id()];
    const out = reviewWrites(
      qs.map((q) => ({ _id: q, srs: null })),
      [
        { questionId: qs[0]!, correct: false, void: true },
        { questionId: qs[1]!, correct: false, void: '정답 둘' },
        { questionId: qs[2]!, correct: false, void: '' },
        { questionId: qs[3]!, correct: false, void: false },
      ],
      AT,
      false,
    );
    expect(out.map((w) => w.questionId)).toEqual([qs[2]!.toString(), qs[3]!.toString()]);
  });

  it('빈 복습 상태({})는 처음 푸는 문제로 본다(review.py parse_srs와 같음)', () => {
    const a = id();
    expect(
      reviewWrites([{ _id: a, srs: {} }], [{ questionId: a, correct: true }], AT, false),
    ).toEqual([{ questionId: a.toString(), srs: firstReview(true, AT), first: true }]);
  });

  it('그 상태를 이 풀이보다 늦게 쓴 문제(srsAt)는 그대로 둔다(saveSrs의 「더 새 것만」)', () => {
    const [a, b] = [id(), id()];
    const out = reviewWrites(
      [
        { _id: a, srs: active, srsAt: new Date(AT.getTime() + 1) },
        { _id: b, srs: active, srsAt: AT },
      ],
      [
        { questionId: a, correct: true },
        { questionId: b, correct: true },
      ],
      AT,
      false,
    );
    expect(out.map((w) => w.questionId)).toEqual([b.toString()]);
  });

  it('검사를 통과한 문제(checked)는 처음 상태에 checked를 붙이고, 표시가 없는 옛 문제는 붙이지 않는다', () => {
    const [a, b] = [id(), id()];
    const out = reviewWrites(
      [
        { _id: a, srs: null, checked: true },
        { _id: b, srs: null },
      ],
      [
        { questionId: a, correct: true },
        { questionId: b, correct: true },
      ],
      AT,
      true,
    );
    expect(out[0]!.srs).toMatchObject({ checked: true });
    expect(out[1]!.srs).not.toHaveProperty('checked');
  });

  it('세트에 없는 문제 · 같은 문제의 두 번째 답은 건너뛴다', () => {
    const a = id();
    const out = reviewWrites(
      [{ _id: a, srs: null }],
      [
        { questionId: id(), correct: true },
        { questionId: a, correct: false },
        { questionId: a, correct: true },
      ],
      AT,
      false,
    );
    expect(out).toEqual([{ questionId: a.toString(), srs: firstReview(false, AT), first: true }]);
  });
});
