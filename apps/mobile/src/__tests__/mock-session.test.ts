import { mockApi } from './fixtures/api';
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// 공부 시간과 포인트는 서버 기록으로 계산한다 — 기기가 보낸 시간을 믿지 않는다
describe('mock study session', () => {
  beforeEach(() => jest.useFakeTimers({ now: new Date('2026-10-26T10:00:00Z') }));
  afterEach(() => jest.useRealTimers());

  async function settle<T>(p: Promise<T>): Promise<T> {
    await jest.advanceTimersByTimeAsync(500);
    return p;
  }

  it('클라이언트가 부풀린 시간을 보내도 서버 기록 기준으로 계산한다', async () => {
    const item = await settle(
      mockApi.study.addItem({ title: '이차방정식', subjectName: '수학', goalMin: 60 }),
    );
    const s = await settle(mockApi.study.startSession({ studyItemId: item._id, mode: 'personal' }));
    // settle이 시계를 0.5초씩 밀므로 시작 시각 기준으로 5분 뒤에 끝낸다
    jest.setSystemTime(Date.parse(s.startedAt) + 5 * 60 * 1000);
    const r = await settle(
      mockApi.study.endSession(s._id, { clientDurationSec: 99999, endReason: 'manual' }),
    );
    expect(r.durationSec).toBeGreaterThanOrEqual(300);
    expect(r.durationSec).toBeLessThan(310);
    expect(r.pointsEarned).toBe(0); // 10분 미만은 포인트 없음
  });

  it('일시정지한 시간은 빼고 센다', async () => {
    const item = await settle(
      mockApi.study.addItem({ title: '가정법', subjectName: '영어', goalMin: 40 }),
    );
    const s = await settle(mockApi.study.startSession({ studyItemId: item._id, mode: 'personal' }));
    jest.setSystemTime(new Date('2026-10-26T10:10:00Z'));
    await settle(mockApi.study.pauseSession(s._id));
    jest.setSystemTime(new Date('2026-10-26T10:30:00Z'));
    await settle(mockApi.study.resumeSession(s._id));
    jest.setSystemTime(new Date('2026-10-26T10:40:00Z'));
    const r = await settle(
      mockApi.study.endSession(s._id, { clientDurationSec: 0, endReason: 'manual' }),
    );
    // 40분 중 20분 쉼 → 약 20분
    expect(Math.round(r.durationSec / 60)).toBe(20);
    expect(r.pointsEarned).toBe(30);
  });
});
