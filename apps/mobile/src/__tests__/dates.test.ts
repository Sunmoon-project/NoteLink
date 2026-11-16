import {
  addDays,
  diffLabel,
  dLabel,
  daysBetween,
  goalLabel,
  hms,
  md,
  seoul,
  today,
  ymd,
} from '../lib/dates';

describe('dates', () => {
  it('초를 00:00:00으로 바꾼다', () => {
    expect(hms(0)).toBe('00:00:00');
    expect(hms(2 * 3600 + 14 * 60 + 37)).toBe('02:14:37');
    expect(hms(-5)).toBe('00:00:00');
  });

  it('D-day 표기: 남은 날 · 당일 · 지난 날', () => {
    expect(dLabel(3)).toBe('D-3');
    expect(dLabel(0)).toBe('D-day');
    expect(dLabel(-55)).toBe('D+55');
  });

  it('두 날짜 사이 일수를 달 경계와 상관없이 센다', () => {
    expect(daysBetween('2026-09-28', '2026-10-03')).toBe(5);
    expect(daysBetween('2026-10-03', '2026-09-28')).toBe(-5);
  });

  it('로컬 날짜 기준으로 YYYY-MM-DD를 만든다', () => {
    expect(ymd(new Date(2026, 8, 1))).toBe('2026-09-01');
    expect(ymd(addDays(new Date(2026, 8, 30), 1))).toBe('2026-10-01');
  });

  it('요일이 붙은 날짜와 목표 시간 표기', () => {
    expect(md('2026-09-22')).toBe('9월 22일 (화)');
    expect(goalLabel(60)).toBe('1시간');
    expect(goalLabel(40)).toBe('40분');
    expect(goalLabel(null)).toBe('목표 없음');
  });

  it('서울 자정을 기준으로 날짜를 바꾼다 (기기 시간대와 상관없이)', () => {
    // 15:00Z = 서울 자정
    expect(ymd(seoul('2026-10-26T14:59:59Z'))).toBe('2026-10-26');
    expect(ymd(seoul('2026-10-26T15:00:00Z'))).toBe('2026-10-27');
    expect(seoul('2026-10-26T15:30:00Z').getHours()).toBe(0);
    jest.useFakeTimers({ now: new Date('2026-10-26T15:30:00Z') });
    expect(today()).toBe('2026-10-27');
    jest.useRealTimers();
  });

  it('지난주와 비교한 문구', () => {
    expect(diffLabel(6000)).toBe('지난주보다 1시간 40분 늘었어요');
    expect(diffLabel(-1800)).toBe('지난주보다 30분 줄었어요');
    expect(diffLabel(30)).toBe('지난주와 비슷해요');
  });
});
