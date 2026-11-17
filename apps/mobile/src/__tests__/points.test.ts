import { POINTS, quizPoints, sessionPoints } from '../lib/points';

const AVATAR = 500;

it('세션은 10분 이상일 때 하루 2번까지 20P', () => {
  expect(sessionPoints(true, 0)).toBe(20);
  expect(sessionPoints(true, 1)).toBe(20);
  expect(sessionPoints(true, 2)).toBe(0);
  expect(sessionPoints(false, 0)).toBe(0);
});

it('퀴즈는 정답 하나에 4P, 하루 40P까지', () => {
  expect(quizPoints(7, 0)).toBe(28);
  expect(quizPoints(7, 28)).toBe(12);
  expect(quizPoints(10, 40)).toBe(0);
});

it('아바타(500P)는 하루 최대로 해도 7일, 꾸준히 하면 약 일주일 걸린다', () => {
  const max = POINTS.session * POINTS.sessionsPerDay + POINTS.quizPerDay;
  expect(Math.ceil(AVATAR / max)).toBe(7);
  // 하루 세션 2번 + 10문제 퀴즈 1개(정답 7개)
  const steady = sessionPoints(true, 0) + sessionPoints(true, 1) + quizPoints(7, 0);
  expect(Math.ceil(AVATAR / steady)).toBe(8);
});
