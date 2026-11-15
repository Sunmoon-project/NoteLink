import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomTimerNotificationsService } from '../src/modules/studyroom/room-timer-notifications.service.js';

const roomId = new Types.ObjectId();
const hostId = new Types.ObjectId();
const memberId = new Types.ObjectId();
const invitedId = new Types.ObjectId();
const leftId = new Types.ObjectId();
const startedAt = new Date('2026-11-15T00:00:00.000Z');
const nextAt = new Date(startedAt.getTime() + 25 * 60_000);
const now = new Date(startedAt.getTime() + 26 * 60_000);

const query = <T>(value: T) => ({ lean: async () => value });
const rooms = {
  find: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
};
const devices = {
  find: vi.fn(),
  deleteMany: vi.fn(),
};
const push = { send: vi.fn() };

const dueRoom = {
  _id: roomId,
  title: '아침 집중방',
  members: [
    { userId: hostId, status: 'joined' },
    { userId: memberId, status: 'joined' },
    { userId: invitedId, status: 'invited' },
    { userId: leftId, status: 'left' },
  ],
  timerRule: {
    enabled: true,
    type: 'pomodoro',
    focusMin: 25,
    breakMin: 5,
    repeat: 4,
    periods: [],
  },
  timerStartedAt: startedAt,
  timerNextNotificationAt: nextAt,
  timerRevision: 3,
};

beforeEach(() => {
  vi.resetAllMocks();
  rooms.find.mockReturnValueOnce({ limit: () => ({ lean: async () => [] }) }).mockReturnValueOnce({
    sort: () => ({ limit: () => ({ lean: async () => [dueRoom] }) }),
  });
  rooms.updateOne.mockResolvedValue({ matchedCount: 1 });
  rooms.findOne.mockReturnValue(
    query({
      ...dueRoom,
      timerPendingNotification: {
        transitionAt: nextAt,
        phase: 'break',
        title: '아침 집중방 타이머',
        body: '집중 시간이 끝났어요. 잠시 쉬어 가세요.',
      },
    }),
  );
  const devicesQuery = {
    select: () => devicesQuery,
    lean: async () => [
      { pushToken: 'ExponentPushToken[host-device]' },
      { pushToken: 'ExpoPushToken[member-device]' },
      { pushToken: 'native-apns-token-is-not-an-expo-token' },
    ],
  };
  devices.find.mockReturnValue(devicesQuery);
  devices.deleteMany.mockResolvedValue({ deletedCount: 0 });
  push.send.mockResolvedValue([]);
});

describe('RoomTimerNotificationsService', () => {
  it('다음 단계 변경 때 joined 멤버 기기에만 기본 알림음을 포함해 푸시한다', async () => {
    const service = new RoomTimerNotificationsService(
      rooms as never,
      devices as never,
      push as never,
    );
    await service.runOnce(now);

    expect(rooms.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: roomId,
        timerRevision: 3,
        timerNextNotificationAt: nextAt,
      }),
      {
        $set: {
          timerNextNotificationAt: new Date(startedAt.getTime() + 30 * 60_000),
          timerPendingNotification: {
            transitionAt: nextAt,
            phase: 'break',
            title: '아침 집중방 타이머',
            body: '집중 시간이 끝났어요. 잠시 쉬어 가세요.',
          },
          timerPendingLeaseUntil: null,
        },
      },
    );
    expect(devices.find).toHaveBeenCalledWith(
      {
        userId: { $in: [hostId, memberId] },
      },
      { pushToken: 1 },
    );
    expect(push.send).toHaveBeenCalledWith([
      expect.objectContaining({
        to: 'ExponentPushToken[host-device]',
        sound: 'default',
        priority: 'high',
        channelId: 'study-room-timer',
        data: { type: 'study-room-timer', roomId: String(roomId), phase: 'break' },
      }),
      expect.objectContaining({
        to: 'ExpoPushToken[member-device]',
        sound: 'default',
      }),
    ]);
  });

  it('규칙이 바뀌어 revision이 달라진 due 타이머는 이전 알림을 보내지 않는다', async () => {
    rooms.updateOne.mockResolvedValueOnce({ matchedCount: 0 });
    const service = new RoomTimerNotificationsService(
      rooms as never,
      devices as never,
      push as never,
    );
    await service.runOnce(now);
    expect(push.send).not.toHaveBeenCalled();
  });
});
