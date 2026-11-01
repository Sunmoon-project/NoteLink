import { describe, expect, it } from 'vitest';
import { StudyRoom } from './schemas.js';

const oldRoom = {
  _id: 'room-timer-contract',
  title: '타이머 계약 방',
  categoryId: 'study',
  hostId: 'host',
  isPublic: true,
  inviteCode: 'TIMER1',
  maxCapacity: 8,
  memberCount: 0,
  timerRule: null,
  members: [],
  createdAt: '2026-11-01T00:00:00.000Z',
  closedAt: null,
};
const endsAt = '2026-11-01T00:25:00.000Z';

describe('StudyRoom 서버 타이머 스냅샷 계약', () => {
  it('timerState가 없는 기존 방 응답도 그대로 허용한다', () => {
    const parsed = StudyRoom.parse(oldRoom);
    expect(parsed).toEqual(oldRoom);
    expect(parsed).not.toHaveProperty('timerState');
  });

  it.each(['focus', 'break', 'period'])('%s 단계와 UTC 종료 시각을 검증하고 보존한다', (phase) => {
    const timerState = { phase, endsAt };
    expect(StudyRoom.parse({ ...oldRoom, timerState }).timerState).toEqual(timerState);
  });

  it('종료 시각이 없는 단계는 endsAt null을 보존한다', () => {
    const timerState = { phase: 'period', endsAt: null };
    expect(StudyRoom.parse({ ...oldRoom, timerState }).timerState).toEqual(timerState);
  });

  it('활성 타이머가 없다는 timerState null 응답을 허용한다', () => {
    expect(StudyRoom.parse({ ...oldRoom, timerState: null }).timerState).toBeNull();
  });

  it('계약에 없는 단계는 거절한다', () => {
    expect(
      StudyRoom.safeParse({ ...oldRoom, timerState: { phase: 'paused', endsAt } }).success,
    ).toBe(false);
  });

  it.each(['2026-11-01T09:25:00+09:00', '2026-11-01T00:25:00', '2026-11-01', '잘못된 시각'])(
    'UTC 종료 시각이 아닌 %s는 거절한다',
    (value) => {
      expect(
        StudyRoom.safeParse({ ...oldRoom, timerState: { phase: 'focus', endsAt: value } }).success,
      ).toBe(false);
    },
  );
});
