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
  rooms.find
    .mockReturnValueOnce({ limit: () => ({ lean: async () => [] }) })
    .mockReturnValueOnce({
      sort: () => ({ limit: () => ({ lean: async () => [dueRoom] }) }),
    })
    .mockReturnValue({ limit: () => ({ lean: async () => [] }) });
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
      { userId: hostId, pushToken: 'ExponentPushToken[host-device]' },
      { userId: memberId, pushToken: 'ExpoPushToken[member-device]' },
      { userId: invitedId, pushToken: 'native-apns-token-is-not-an-expo-token' },
    ],
  };
  devices.find.mockReturnValue(devicesQuery);
  devices.deleteMany.mockResolvedValue({ deletedCount: 0 });
  push.send.mockResolvedValue({ invalidTokens: [], failedTickets: [] });
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
      { userId: 1, pushToken: 1 },
    );
    expect(push.send).toHaveBeenCalledWith([
      expect.objectContaining({
        to: 'ExponentPushToken[host-device]',
        sound: 'default',
        priority: 'high',
        channelId: 'study-room-timer',
        data: {
          type: 'study-room-timer',
          roomId: String(roomId),
          phase: 'break',
          transitionId: `${roomId}:${nextAt.toISOString()}`,
        },
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

  it('전송 대기 시간이 길어져도 각 방의 lease는 실제 획득 시각부터 30초로 계산한다', async () => {
    const firstRoom = {
      ...dueRoom,
      timerPendingNotification: {
        transitionAt: nextAt,
        phase: 'break',
        title: '첫 번째 방 타이머',
        body: '집중 시간이 끝났어요.',
      },
    };
    const secondRoom = {
      ...firstRoom,
      _id: new Types.ObjectId(),
      timerPendingNotification: {
        ...firstRoom.timerPendingNotification,
        title: '두 번째 방 타이머',
      },
    };
    const leaseStart = new Date('2026-11-15T12:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(leaseStart);
    rooms.find
      .mockReset()
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [firstRoom, secondRoom] }) })
      .mockReturnValueOnce({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })
      .mockReturnValue({ limit: () => ({ lean: async () => [] }) });
    rooms.findOne
      .mockReset()
      .mockReturnValueOnce(query(firstRoom))
      .mockReturnValueOnce(query(secondRoom));
    rooms.updateOne.mockReset().mockResolvedValue({ matchedCount: 1 });
    push.send
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(leaseStart.getTime() + 31_000));
        return { invalidTokens: [], failedTickets: [] };
      })
      .mockResolvedValueOnce({ invalidTokens: [], failedTickets: [] });

    try {
      const service = new RoomTimerNotificationsService(
        rooms as never,
        devices as never,
        push as never,
      );
      await service.runOnce(leaseStart);
    } finally {
      vi.useRealTimers();
    }

    const leases = rooms.updateOne.mock.calls
      .map(([filter, update]) => ({ filter, update }))
      .filter(({ update }) => update.$set?.timerPendingLeaseUntil instanceof Date);
    expect(leases).toHaveLength(2);
    expect(leases[0]!.update.$set.timerPendingLeaseUntil).toEqual(
      new Date(leaseStart.getTime() + 30_000),
    );
    expect(leases[1]!.filter.$or[1].timerPendingLeaseUntil.$lte).toEqual(
      new Date(leaseStart.getTime() + 31_000),
    );
    expect(leases[1]!.update.$set.timerPendingLeaseUntil).toEqual(
      new Date(leaseStart.getTime() + 61_000),
    );
  });

  it('30초가 넘는 발송 중 lease를 갱신해 두 번째 인스턴스의 중복 전송을 막는다', async () => {
    const pendingRoom = {
      ...dueRoom,
      timerPendingNotification: {
        transitionAt: nextAt,
        phase: 'break',
        title: '아침 집중방 타이머',
        body: '집중 시간이 끝났어요. 잠시 쉬어 가세요.',
      },
    };
    let activeLease: Date | null = null;
    rooms.find.mockImplementation((filter: Record<string, unknown>) => ({
      sort: () => ({
        limit: () => ({ lean: async () => (filter.timerPendingNotification === null ? [] : []) }),
      }),
      limit: () => ({
        lean: async () =>
          filter.timerPendingNotification && typeof filter.timerPendingNotification === 'object'
            ? [pendingRoom]
            : [],
      }),
    }));
    rooms.findOne.mockReturnValue(query(pendingRoom));
    rooms.updateOne.mockImplementation(async (filter, update) => {
      const requestedLease = update.$set?.timerPendingLeaseUntil;
      if (requestedLease instanceof Date) {
        if (Array.isArray(filter.$or)) {
          if (activeLease && activeLease.getTime() > Date.now()) return { matchedCount: 0 };
          activeLease = requestedLease;
          return { matchedCount: 1 };
        }
        if (
          filter.timerPendingLeaseUntil instanceof Date &&
          activeLease?.getTime() === filter.timerPendingLeaseUntil.getTime()
        ) {
          activeLease = requestedLease;
          return { matchedCount: 1 };
        }
      }
      if (update.$set?.timerPendingNotification === null) activeLease = null;
      return { matchedCount: 1 };
    });
    let finishPush!: (value: { invalidTokens: string[]; failedTickets: [] }) => void;
    let signalPushStarted!: () => void;
    const pushStarted = new Promise<void>((resolve) => {
      signalPushStarted = resolve;
    });
    push.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPush = resolve;
          signalPushStarted();
        }),
    );
    vi.useFakeTimers();
    const leaseStart = new Date('2026-11-16T00:00:00.000Z');
    vi.setSystemTime(leaseStart);

    try {
      const firstInstance = new RoomTimerNotificationsService(
        rooms as never,
        devices as never,
        push as never,
      );
      const secondInstance = new RoomTimerNotificationsService(
        rooms as never,
        devices as never,
        push as never,
      );
      const firstRun = firstInstance.runOnce(leaseStart);
      await pushStarted;

      await vi.advanceTimersByTimeAsync(31_000);
      expect(activeLease!.getTime()).toBeGreaterThan(leaseStart.getTime() + 30_000);
      await secondInstance.runOnce(new Date());
      expect(push.send).toHaveBeenCalledTimes(1);

      finishPush({ invalidTokens: [], failedTickets: [] });
      await firstRun;
    } finally {
      vi.useRealTimers();
    }
  });

  it('개별 ticket 실패만 수신자별 재시도 큐에 넣고 성공 기기는 재전송하지 않는다', async () => {
    push.send.mockImplementationOnce(async (messages: { to: string }[]) => ({
      invalidTokens: ['ExponentPushToken[host-device]'],
      failedTickets: [{ message: messages[1], error: 'MessageRateExceeded' }],
    }));
    const service = new RoomTimerNotificationsService(
      rooms as never,
      devices as never,
      push as never,
    );

    await service.runOnce(now);

    expect(push.send).toHaveBeenCalledTimes(1);
    expect(devices.deleteMany).toHaveBeenCalledWith({
      pushToken: { $in: ['ExponentPushToken[host-device]'] },
    });
    expect(rooms.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: roomId,
        timerRevision: 3,
        'timerPendingNotification.transitionAt': nextAt,
      }),
      {
        $push: {
          timerNotificationRetries: expect.objectContaining({
            eventId: `${roomId}:${nextAt.toISOString()}`,
            timerRevision: 3,
            recipients: [{ userId: String(memberId), token: 'ExpoPushToken[member-device]' }],
            attempts: 0,
            nextAttemptAt: expect.any(Date),
          }),
        },
      },
    );
    expect(rooms.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: roomId,
        'timerPendingNotification.transitionAt': nextAt,
      }),
      { $set: { timerPendingNotification: null, timerPendingLeaseUntil: null } },
    );
  });

  it('재시도 때 현재 joined 상태와 토큰 소유자를 재검증하고 실패 수신자만 보낸다', async () => {
    const eventId = `${roomId}:${nextAt.toISOString()}`;
    const retry = {
      eventId,
      transitionAt: nextAt,
      phase: 'break',
      title: '아침 집중방 타이머',
      body: '집중 시간이 끝났어요. 잠시 쉬어 가세요.',
      timerRevision: 3,
      recipients: [{ userId: String(memberId), token: 'ExpoPushToken[member-device]' }],
      attempts: 1,
      nextAttemptAt: new Date(0),
    };
    const retryRoom = {
      ...dueRoom,
      timerPendingNotification: null,
      timerNotificationRetries: [retry],
    };
    rooms.find
      .mockReset()
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [] }) })
      .mockReturnValueOnce({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [retryRoom] }) });
    rooms.findOne.mockReset().mockReturnValue(query(retryRoom));
    rooms.updateOne.mockReset().mockResolvedValue({ matchedCount: 1 });
    push.send.mockResolvedValueOnce({ invalidTokens: [], failedTickets: [] });
    const service = new RoomTimerNotificationsService(
      rooms as never,
      devices as never,
      push as never,
    );

    await service.runOnce(new Date());

    expect(devices.find).toHaveBeenCalledWith(
      {
        userId: { $in: [hostId, memberId] },
        pushToken: { $in: ['ExpoPushToken[member-device]'] },
      },
      { userId: 1, pushToken: 1 },
    );
    expect(push.send).toHaveBeenCalledTimes(1);
    expect(push.send).toHaveBeenCalledWith([
      expect.objectContaining({ to: 'ExpoPushToken[member-device]' }),
    ]);
    expect(rooms.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: roomId,
        timerNotificationRetries: { $elemMatch: { eventId } },
      }),
      {
        $pull: { timerNotificationRetries: { eventId } },
      },
    );
  });

  it('지속되는 재시도 오류가 있어도 다음 타이머 단계는 보내고 실패 토큰만 다시 예약한다', async () => {
    const retry = {
      eventId: `${roomId}:old-transition`,
      transitionAt: new Date(startedAt.getTime() - 60_000),
      phase: 'break',
      title: '아침 집중방 타이머',
      body: '집중 시간이 끝났어요. 잠시 쉬어 가세요.',
      timerRevision: 3,
      recipients: [{ userId: String(memberId), token: 'ExpoPushToken[member-device]' }],
      attempts: 1,
      nextAttemptAt: new Date(0),
    };
    const pendingRoom = {
      ...dueRoom,
      timerPendingNotification: {
        transitionAt: nextAt,
        phase: 'break',
        title: '아침 집중방 타이머',
        body: '집중 시간이 끝났어요. 잠시 쉬어 가세요.',
      },
    };
    const retryRoom = {
      ...dueRoom,
      timerPendingNotification: null,
      timerNotificationRetries: [retry],
    };
    rooms.find
      .mockReset()
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [] }) })
      .mockReturnValueOnce({ sort: () => ({ limit: () => ({ lean: async () => [dueRoom] }) }) })
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [retryRoom] }) });
    rooms.findOne
      .mockReset()
      .mockReturnValueOnce(query(pendingRoom))
      .mockReturnValueOnce(query(retryRoom));
    rooms.updateOne.mockReset().mockResolvedValue({ matchedCount: 1 });
    push.send
      .mockImplementationOnce(async () => ({ invalidTokens: [], failedTickets: [] }))
      .mockImplementationOnce(async (messages: { to: string }[]) => ({
        invalidTokens: [],
        failedTickets: [{ message: messages[0], error: 'MessageRateExceeded' }],
      }));
    const service = new RoomTimerNotificationsService(
      rooms as never,
      devices as never,
      push as never,
    );

    await service.runOnce(now);

    expect(push.send).toHaveBeenCalledTimes(2);
    expect(push.send.mock.calls[0]![0]).toHaveLength(2);
    expect(push.send.mock.calls[1]![0]).toEqual([
      expect.objectContaining({ to: 'ExpoPushToken[member-device]' }),
    ]);
    expect(rooms.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: roomId, timerNextNotificationAt: nextAt }),
      expect.objectContaining({
        $set: expect.objectContaining({
          timerNextNotificationAt: new Date(startedAt.getTime() + 30 * 60_000),
        }),
      }),
    );
    expect(rooms.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: roomId,
        timerNotificationRetries: { $elemMatch: { eventId: retry.eventId } },
      }),
      {
        $set: {
          'timerNotificationRetries.$[retry].recipients': [
            { userId: String(memberId), token: 'ExpoPushToken[member-device]' },
          ],
          'timerNotificationRetries.$[retry].attempts': 2,
          'timerNotificationRetries.$[retry].nextAttemptAt': expect.any(Date),
        },
      },
      { arrayFilters: [{ 'retry.eventId': retry.eventId }] },
    );
  });

  it('재시도 저장 중 다른 인스턴스가 추가한 새 항목을 보존한다', async () => {
    const retry = {
      eventId: `${roomId}:old-transition`,
      transitionAt: new Date(startedAt.getTime() - 60_000),
      phase: 'break',
      title: '아침 집중방 타이머',
      body: '집중 시간이 끝났어요. 잠시 쉬어 가세요.',
      timerRevision: 3,
      recipients: [{ userId: String(memberId), token: 'ExpoPushToken[member-device]' }],
      attempts: 1,
      nextAttemptAt: new Date(0),
    };
    const concurrentlyAdded = {
      ...retry,
      eventId: `${roomId}:new-transition`,
      recipients: [{ userId: String(hostId), token: 'ExpoPushToken[host-device]' }],
    };
    const retryRoom = {
      ...dueRoom,
      timerPendingNotification: null,
      timerNotificationRetries: [retry],
    };
    rooms.find
      .mockReset()
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [] }) })
      .mockReturnValueOnce({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) })
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [retryRoom] }) });
    rooms.findOne.mockReset().mockReturnValue(query(retryRoom));
    rooms.updateOne.mockReset().mockImplementation(async (_filter, update) => {
      if (update.$set?.['timerNotificationRetries.$[retry].attempts'] !== undefined) {
        retryRoom.timerNotificationRetries.push(concurrentlyAdded);
        Object.assign(retry, {
          attempts: update.$set['timerNotificationRetries.$[retry].attempts'],
          recipients: update.$set['timerNotificationRetries.$[retry].recipients'],
          nextAttemptAt: update.$set['timerNotificationRetries.$[retry].nextAttemptAt'],
        });
      }
      return { matchedCount: 1 };
    });
    push.send.mockImplementationOnce(async (messages: { to: string }[]) => ({
      invalidTokens: [],
      failedTickets: [{ message: messages[0], error: 'MessageRateExceeded' }],
    }));
    const service = new RoomTimerNotificationsService(
      rooms as never,
      devices as never,
      push as never,
    );

    await service.runOnce(new Date());

    expect(retryRoom.timerNotificationRetries).toHaveLength(2);
    expect(retryRoom.timerNotificationRetries[0]).toMatchObject({
      eventId: retry.eventId,
      attempts: 2,
    });
    expect(retryRoom.timerNotificationRetries[1]).toEqual(concurrentlyAdded);
    expect(rooms.updateOne).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        $set: expect.objectContaining({ timerNotificationRetries: expect.any(Array) }),
      }),
    );
  });

  it('마지막 교시가 끝나면 다음 날 첫 교시를 다음 알림 시각으로 저장한다', async () => {
    const lastPeriodAt = new Date('2026-11-15T06:50:00.000Z');
    const schedulerNow = new Date('2026-11-15T06:50:01.000Z');
    const lastPeriodRoom = {
      ...dueRoom,
      timerRule: {
        enabled: true,
        type: 'period',
        focusMin: 50,
        breakMin: 10,
        repeat: 4,
        periods: [
          { start: '09:00', end: '09:50', label: '1교시' },
          { start: '15:00', end: '15:50', label: '마지막 교시' },
        ],
      },
      timerStartedAt: null,
      timerNextNotificationAt: lastPeriodAt,
    };
    rooms.find
      .mockReset()
      .mockReturnValueOnce({ limit: () => ({ lean: async () => [] }) })
      .mockReturnValueOnce({
        sort: () => ({ limit: () => ({ lean: async () => [lastPeriodRoom] }) }),
      })
      .mockReturnValue({ limit: () => ({ lean: async () => [] }) });
    rooms.findOne.mockReturnValue(
      query({
        ...lastPeriodRoom,
        timerPendingNotification: {
          transitionAt: lastPeriodAt,
          phase: 'break',
          title: '아침 집중방 타이머',
          body: '교시가 끝났어요. 다음 교시를 기다려요.',
        },
      }),
    );
    const service = new RoomTimerNotificationsService(
      rooms as never,
      devices as never,
      push as never,
    );

    await service.runOnce(schedulerNow);

    expect(rooms.updateOne.mock.calls[0]![1]).toMatchObject({
      $set: {
        timerNextNotificationAt: new Date('2026-11-16T00:00:00.000Z'),
        timerPendingNotification: expect.objectContaining({
          transitionAt: lastPeriodAt,
          phase: 'break',
        }),
      },
    });
  });
});
