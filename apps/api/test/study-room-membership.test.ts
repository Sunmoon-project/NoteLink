import { describe, expect, it, vi } from 'vitest';

import { StudyRoomMembershipService } from '../src/modules/studyroom/study-room-membership.service.js';

// 스터디룸 나가기 묶음(방 멤버 상태 · 소켓 구독 · 알림 · LiveKit 연결 종료)의 호출 순서를 가짜 의존으로 본다.
function setup(roomIds: string[] = []) {
  const calls: string[] = [];
  // 나간 방은 참여 중 목록에서 빠진다(실제 DB처럼)
  const remaining = new Set(roomIds);
  const rooms = {
    rollbackMembership: undefined as unknown,
    list: vi.fn(async () => [...remaining].map((_id) => ({ _id }))),
    leaveRoom: vi.fn(async (_userId: string, roomId: string) => {
      remaining.delete(roomId);
      calls.push(`leaveRoom:${roomId}`);
    }),
  };
  const gateway = {
    evict: vi.fn(async (roomId: string) => void calls.push(`evict:${roomId}`)),
    notifyMembersChanged: vi.fn((roomId: string) => void calls.push(`notify:${roomId}`)),
  };
  const live = {
    disconnect: vi.fn(async (roomId: string) => void calls.push(`disconnect:${roomId}`)),
  };
  const service = new StudyRoomMembershipService(rooms as never, gateway as never, live as never);
  return { service, rooms, gateway, live, calls };
}

describe('일반 나가기(leave)', () => {
  it('나간 뒤에 소켓을 풀고, 알리고, LiveKit 연결을 끊는다(기존 컨트롤러 순서)', async () => {
    const { service, calls } = setup();
    await service.leave('u1', 'r1');
    expect(calls).toEqual(['leaveRoom:r1', 'evict:r1', 'notify:r1', 'disconnect:r1']);
  });

  it('나가기가 실패하면 연결은 건드리지 않고 오류를 던진다', async () => {
    const { service, rooms, gateway, live } = setup();
    rooms.leaveRoom.mockRejectedValueOnce(new Error('나가기 실패'));
    await expect(service.leave('u1', 'r1')).rejects.toThrow('나가기 실패');
    expect(gateway.evict).not.toHaveBeenCalled();
    expect(live.disconnect).not.toHaveBeenCalled();
  });
});

describe('입장 · 생성 뒤 되돌리기(rollbackMembership)', () => {
  const rollback = (rooms: { rollbackMembership: unknown }) =>
    rooms.rollbackMembership as (u: string, r: string) => Promise<void>;

  it('탈퇴용 순서(소켓 해제 → 연결 종료 → 나가기 → 알림)로 StudyRoomsService 에 연결된다', async () => {
    const { rooms, calls } = setup(['r9']);
    expect(typeof rooms.rollbackMembership).toBe('function');
    await rollback(rooms)('u1', 'r9');
    expect(calls).toEqual(['evict:r9', 'disconnect:r9', 'leaveRoom:r9', 'notify:r9']);
  });

  it('연결 끊기가 실패하면 멤버십이 남아서 탈퇴를 다시 시도할 때 그 방을 다시 처리한다', async () => {
    const { service, rooms, live, calls } = setup(['r9']);
    live.disconnect.mockRejectedValueOnce(new Error('LiveKit 장애'));
    await expect(rollback(rooms)('u1', 'r9')).rejects.toThrow('LiveKit 장애');
    expect(rooms.leaveRoom).not.toHaveBeenCalled();
    expect((await rooms.list()).map((room) => room._id)).toEqual(['r9']);
    calls.length = 0;
    await service.leaveAllForWithdrawal('u1');
    expect(calls).toEqual(['evict:r9', 'disconnect:r9', 'leaveRoom:r9', 'notify:r9']);
  });
});

describe('탈퇴용 나가기(leaveAllForWithdrawal)', () => {
  it('방마다 소켓 구독 해제 → LiveKit 연결 종료 → 나가기 → 알림 순서로 한다', async () => {
    const { service, rooms, calls } = setup(['r1', 'r2']);
    await service.leaveAllForWithdrawal('u1');
    expect(rooms.list).toHaveBeenCalledWith('u1', 'mine');
    expect(calls).toEqual([
      'evict:r1',
      'disconnect:r1',
      'leaveRoom:r1',
      'notify:r1',
      'evict:r2',
      'disconnect:r2',
      'leaveRoom:r2',
      'notify:r2',
    ]);
  });

  it('참여 중인 방이 없으면 아무것도 하지 않는다', async () => {
    const { service, calls } = setup([]);
    await service.leaveAllForWithdrawal('u1');
    expect(calls).toEqual([]);
  });

  it('연결 끊기가 실패하면 나가기 · 알림 없이 던지고, 다시 시도하면 그 방도 다시 처리한다', async () => {
    const { service, live, calls } = setup(['r1']);
    live.disconnect.mockRejectedValueOnce(new Error('LiveKit 장애'));
    await expect(service.leaveAllForWithdrawal('u1')).rejects.toThrow('LiveKit 장애');
    // 나가기 전에 실패했으니 방은 아직 참여 중 목록에 있다(실제로는 DB가 그대로)
    expect(calls).toEqual(['evict:r1']);
    calls.length = 0;
    await service.leaveAllForWithdrawal('u1');
    expect(calls).toEqual(['evict:r1', 'disconnect:r1', 'leaveRoom:r1', 'notify:r1']);
  });

  it('나가기가 실패하면 알리지 않고 던진다(연결은 이미 끊겼고, 다시 시도하면 이어서 한다)', async () => {
    const { service, rooms, calls } = setup(['r1']);
    rooms.leaveRoom.mockRejectedValueOnce(new Error('나가기 실패'));
    await expect(service.leaveAllForWithdrawal('u1')).rejects.toThrow('나가기 실패');
    expect(calls).toEqual(['evict:r1', 'disconnect:r1']);
  });

  it('첫 목록을 처리한 뒤 새로 생긴 참여는 재확인에서 같은 순서로 정리한다', async () => {
    const { service, rooms, calls } = setup(['r1']);
    // 첫 목록 처리 중에 새 참여(r2)가 생겼다고 가정한다
    rooms.leaveRoom.mockImplementationOnce(async (_userId: string, roomId: string) => {
      calls.push(`leaveRoom:${roomId}`);
      rooms.list.mockResolvedValueOnce([{ _id: 'r2' }]);
    });
    rooms.list.mockResolvedValueOnce([{ _id: 'r1' }]);
    await service.leaveAllForWithdrawal('u1');
    expect(rooms.list).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      'evict:r1',
      'disconnect:r1',
      'leaveRoom:r1',
      'notify:r1',
      'evict:r2',
      'disconnect:r2',
      'leaveRoom:r2',
      'notify:r2',
    ]);
  });

  it('재확인은 한 번뿐이고, 재확인에서 처리가 실패하면 던진다', async () => {
    const { service, rooms, live } = setup([]);
    rooms.list.mockResolvedValueOnce([]).mockResolvedValueOnce([{ _id: 'r2' }]);
    live.disconnect.mockRejectedValueOnce(new Error('LiveKit 장애'));
    await expect(service.leaveAllForWithdrawal('u1')).rejects.toThrow('LiveKit 장애');
    expect(rooms.list).toHaveBeenCalledTimes(2);
    expect(rooms.leaveRoom).not.toHaveBeenCalled();
  });

  it('앞의 방이 실패하면 뒤의 방은 하지 않는다', async () => {
    const { service, live, calls } = setup(['r1', 'r2']);
    live.disconnect.mockRejectedValueOnce(new Error('LiveKit 장애'));
    await expect(service.leaveAllForWithdrawal('u1')).rejects.toThrow();
    expect(calls).not.toContain('evict:r2');
  });
});
