import { useSession } from '../stores/session';
jest.mock('../lib/api', () => ({ api: { study: {} } }));
afterEach(() => useSession.getState().reset());
it('서울 자정 전후의 실행 구간을 날짜별로 분리한다', () => {
  const midnight = Date.parse('2026-11-01T15:00:00Z');
  useSession.setState({
    segments: [{ start: midnight - 10000, end: midnight - 5000 }],
    banked: 5,
    since: midnight - 2000,
  });
  expect(useSession.getState().elapsedSince(midnight, midnight + 3000)).toBe(3);
  expect(useSession.getState().elapsed(midnight + 3000)).toBe(10);
});
it('자정 전에 일시정지한 시간은 다음날 누적에 포함하지 않는다', () => {
  const midnight = Date.parse('2026-11-01T15:00:00Z');
  useSession.setState({
    segments: [{ start: midnight - 10000, end: midnight - 5000 }],
    banked: 5,
    since: null,
    pausedAt: midnight - 5000,
  });
  expect(useSession.getState().elapsedSince(midnight, midnight + 100000)).toBe(0);
});
it('월요일 이전의 구간은 새 주 누적에 포함하지 않는다', () => {
  const monday = Date.parse('2026-11-01T15:00:00Z');
  useSession.setState({
    segments: [{ start: monday - 60000, end: monday + 2000 }],
    banked: 62,
    since: monday + 4000,
  });
  expect(useSession.getState().elapsedSince(monday, monday + 7000)).toBe(5);
});

it('종료 구간 중간의 과거 시각 이후 시간은 합산하지 않는다', () => {
  useSession.setState({ segments: [{ start: 1000, end: 11000 }], banked: 10, since: null });
  expect(useSession.getState().elapsedSince(1000, 6000)).toBe(5);
  expect(useSession.getState().elapsedSince(7000, 6000)).toBe(0);
});
