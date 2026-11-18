import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  StudyRoomWithdrawnSweeper,
  WITHDRAWN_SWEEP_INTERVAL_MS,
  WITHDRAWN_SWEEP_MAX,
} from '../src/modules/studyroom/study-room-withdrawn-sweeper.service.js';

// 탈퇴한 사용자가 남은 방 스위퍼의 주기 · 중복 실행 · 실패 처리를 가짜 의존으로 본다. 실제 찾기 · 정리는 ...-mongo.test.ts
const pair = () => ({ roomId: new Types.ObjectId(), userId: new Types.ObjectId() });

function setup(found: ReturnType<typeof pair>[] = []) {
  const rooms = {
    aggregate: vi.fn(async (_pipeline: unknown[]) => found),
  };
  const users = { collection: { name: 'users' } };
  const membership = {
    leaveRoomForWithdrawal: vi.fn(async (_userId: string, _roomId: string) => {}),
  };
  const sweeper = new StudyRoomWithdrawnSweeper(
    rooms as never,
    users as never,
    membership as never,
  );
  return { sweeper, rooms, membership };
}

describe('주기 실행', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('만들기만 해서는 저절로 돌지 않는다(서비스를 직접 만드는 테스트에서 타이머가 켜지지 않는다)', async () => {
    const { rooms } = setup();
    await vi.advanceTimersByTimeAsync(WITHDRAWN_SWEEP_INTERVAL_MS * 3);
    expect(rooms.aggregate).not.toHaveBeenCalled();
  });

  it('앱이 시작되면 5분마다 돌고(시작 직후에는 돌지 않는다), 종료하면 멈춘다', async () => {
    expect(WITHDRAWN_SWEEP_INTERVAL_MS).toBe(5 * 60_000);
    const { sweeper, rooms } = setup();
    sweeper.onApplicationBootstrap();
    expect(rooms.aggregate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WITHDRAWN_SWEEP_INTERVAL_MS - 1);
    expect(rooms.aggregate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(rooms.aggregate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WITHDRAWN_SWEEP_INTERVAL_MS);
    expect(rooms.aggregate).toHaveBeenCalledTimes(2);
    sweeper.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(WITHDRAWN_SWEEP_INTERVAL_MS * 2);
    expect(rooms.aggregate).toHaveBeenCalledTimes(2);
  });
});

describe('정리', () => {
  it('찾은 (방, 사용자)마다 탈퇴용 한 방 정리를 부른다', async () => {
    const found = [pair(), pair()];
    const { sweeper, membership } = setup(found);
    await sweeper.sweep();
    expect(membership.leaveRoomForWithdrawal.mock.calls).toEqual(
      found.map(({ roomId, userId }) => [String(userId), String(roomId)]),
    );
  });

  it('열린 방의 joined 멤버 중 deletedAt 이 있는 사람만, 최대 건수까지 찾는다', async () => {
    const { sweeper, rooms } = setup();
    await sweeper.sweep();
    expect(WITHDRAWN_SWEEP_MAX).toBe(100);
    const pipeline = JSON.stringify(rooms.aggregate.mock.calls[0]![0]);
    expect(pipeline).toContain('"closedAt":null');
    expect(pipeline).toContain('"members.status":"joined"');
    expect(pipeline).toContain('"deletedAt":{"$ne":null}');
    expect(pipeline).not.toContain('withdrawingAt');
    expect(pipeline).toContain(`"$limit":${WITHDRAWN_SWEEP_MAX}`);
  });

  it('한 건이 실패해도 로그를 남기고 나머지를 계속 처리한다', async () => {
    const found = [pair(), pair(), pair()];
    const { sweeper, membership } = setup(found);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      membership.leaveRoomForWithdrawal.mockRejectedValueOnce(new Error('LiveKit 장애'));
      await sweeper.sweep();
      expect(membership.leaveRoomForWithdrawal).toHaveBeenCalledTimes(3);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain(String(found[0]!.roomId));
    } finally {
      warn.mockRestore();
    }
  });

  it('찾기 자체가 실패해도 던지지 않고, 다음 실행은 다시 돈다', async () => {
    const { sweeper, rooms, membership } = setup([pair()]);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      rooms.aggregate.mockRejectedValueOnce(new Error('DB 오류'));
      await expect(sweeper.sweep()).resolves.toBeUndefined();
      expect(membership.leaveRoomForWithdrawal).not.toHaveBeenCalled();
      await sweeper.sweep();
      expect(membership.leaveRoomForWithdrawal).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('이전 실행이 아직 돌고 있으면 이번 실행은 건너뛴다', async () => {
    const { sweeper, rooms, membership } = setup([pair()]);
    let finish!: () => void;
    membership.leaveRoomForWithdrawal.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const first = sweeper.sweep();
    await vi.waitFor(() => expect(membership.leaveRoomForWithdrawal).toHaveBeenCalledTimes(1));
    await sweeper.sweep();
    expect(rooms.aggregate).toHaveBeenCalledTimes(1);
    finish();
    await first;
    await sweeper.sweep();
    expect(rooms.aggregate).toHaveBeenCalledTimes(2);
  });
});
