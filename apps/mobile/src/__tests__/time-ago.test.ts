// PROF-007: 알림 시간이 59분 전까지 전부 「방금」으로 보였다.
// 1분 미만만 「방금」, 1시간 미만은 「N분 전」(알림함 · 시간표 공유 · 친구 요청이 같이 쓴다)
import { timeAgo } from '../lib/dates';

const NOW = Date.parse('2026-11-22T03:00:00.000Z');
const before = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;

beforeEach(() => jest.useFakeTimers({ now: NOW }));
afterEach(() => jest.useRealTimers());

it('1분 미만은 「방금」', () => {
  expect(timeAgo(before(0))).toBe('방금');
  expect(timeAgo(before(59_000))).toBe('방금');
});

it('1분 이상 1시간 미만은 「N분 전」', () => {
  expect(timeAgo(before(MIN))).toBe('1분 전');
  expect(timeAgo(before(5 * MIN + 30_000))).toBe('5분 전');
  expect(timeAgo(before(59 * MIN + 59_000))).toBe('59분 전');
});

it('1시간부터는 지금처럼 「N시간 전」 · 「N일 전」', () => {
  expect(timeAgo(before(60 * MIN))).toBe('1시간 전');
  expect(timeAgo(before(23 * 60 * MIN))).toBe('23시간 전');
  expect(timeAgo(before(48 * 60 * MIN))).toBe('2일 전');
});

it('기기 시계가 조금 늦어 미래 시각이 와도 「방금」', () => {
  expect(timeAgo(new Date(NOW + 30_000).toISOString())).toBe('방금');
});

it('시각이 비었거나 깨졌으면 「NaN일 전」 대신 빈 글자', () => {
  expect(timeAgo('')).toBe('');
  expect(timeAgo('not-a-date')).toBe('');
});
