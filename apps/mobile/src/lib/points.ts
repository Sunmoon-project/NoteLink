// 포인트 기준 — 꾸준히 쓰면 일주일쯤에 아바타(500P) 하나를 살 수 있게 맞춘다.
// 하루 최대 80P(세션 40 + 퀴즈 40)라 아무리 많이 해도 500P까지 7일이 걸리고,
// 하루 세션 2번 + 10문제 퀴즈 1개(정답률 70%)면 68P/일 → 약 7.4일.
// 서버(apps/api)에 지급 로직을 넣을 때도 같은 값을 쓴다.
export const POINTS = {
  /** 10분 이상 공부 세션을 끝냈을 때 */
  session: 20,
  /** 세션 포인트를 받는 횟수 (하루) */
  sessionsPerDay: 2,
  /** 퀴즈 정답 하나당 */
  perCorrect: 4,
  /** 퀴즈로 받는 포인트 한도 (하루) */
  quizPerDay: 40,
} as const;

/** 오늘 이미 받은 세션 포인트 횟수로 이번 세션 포인트 */
export const sessionPoints = (qualified: boolean, sessionsPaidToday: number) =>
  qualified && sessionsPaidToday < POINTS.sessionsPerDay ? POINTS.session : 0;

/** 오늘 이미 받은 퀴즈 포인트로 이번 풀이 포인트 (한도까지만) */
export const quizPoints = (correctCount: number, quizPaidToday: number) =>
  Math.max(0, Math.min(correctCount * POINTS.perCorrect, POINTS.quizPerDay - quizPaidToday));
