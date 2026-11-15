import { weeklyProgress } from '../features/session/weekly-progress';

describe('주간 목표 80% 계산', () => {
  it('20시간 목표에서 16시간 직전은 아직 달성하지 않는다', () => {
    const result = weeklyProgress(16 * 3600 - 1, 20 * 60);
    expect(result?.reached80).toBe(false);
    expect(result?.percent).toBeLessThan(80);
  });

  it('20시간 목표에서 16시간 이상이면 달성한다', () => {
    expect(weeklyProgress(16 * 3600, 20 * 60)).toEqual({ percent: 80, reached80: true });
    expect(weeklyProgress(17 * 3600, 20 * 60)?.reached80).toBe(true);
  });

  it('목표가 없거나 0이면 달성률을 계산하지 않는다', () => {
    expect(weeklyProgress(100, 0)).toBeNull();
    expect(weeklyProgress(100, undefined)).toBeNull();
  });

  it('30분 단위 목표도 분과 초를 맞춰 계산한다', () => {
    expect(weeklyProgress(24 * 60, 30)).toEqual({ percent: 80, reached80: true });
  });
});
