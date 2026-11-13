import { JwtService } from '@nestjs/jwt';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { RoomServiceClient, ServerError } from 'livekit-server-sdk';
import { StudyLiveService } from '../src/modules/studyroom/study-live.service.js';

const ROOM = '507f1f77bcf86cd799439011';
const USER = '507f1f77bcf86cd799439012';
const secret = 'test-secret-at-least-thirty-two-bytes';
const values: Record<string, string> = {
  LIVEKIT_URL: 'wss://test.livekit.cloud',
  LIVEKIT_API_KEY: 'test-key',
  LIVEKIT_API_SECRET: secret,
};
const setup = () => {
  const requireMember = vi.fn().mockResolvedValue({});
  const config = { get: (key: string) => values[key] };
  return {
    requireMember,
    service: new StudyLiveService(config as never, { requireMember } as never),
  };
};
describe('스터디 라이브 토큰', () => {
  it('현재 방 참여자에게 해당 방과 사용자로 제한된 짧은 토큰을 발급한다', async () => {
    const { service, requireMember } = setup();
    const result = await service.issueToken(ROOM, USER);
    const claims = await new JwtService().verifyAsync(result.token, { secret });
    expect(requireMember).toHaveBeenCalledWith(ROOM, USER);
    expect(result.url).toBe(values.LIVEKIT_URL);
    expect(claims.sub).toBe(USER);
    expect(claims.video).toMatchObject({
      roomJoin: true,
      room: `study-room-${ROOM}`,
      canPublish: true,
      canSubscribe: true,
    });
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(300);
  });
  it('참여자가 아닌 사용자는 토큰을 받지 못한다', async () => {
    const { service, requireMember } = setup();
    requireMember.mockRejectedValueOnce(new NotFoundException());
    await expect(service.issueToken(ROOM, USER)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('토큰 생성 도중 퇴장한 사용자에게는 토큰을 돌려주지 않는다', async () => {
    const { service, requireMember } = setup();
    requireMember.mockResolvedValueOnce({}).mockRejectedValueOnce(new NotFoundException());
    await expect(service.issueToken(ROOM, USER)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('퇴장하면 해당 방의 참여자 연결을 끊고 기존 토큰을 무효화한다', async () => {
    const disconnect = vi
      .spyOn(RoomServiceClient.prototype, 'removeParticipant')
      .mockResolvedValueOnce(undefined);
    try {
      await setup().service.disconnect(ROOM, USER);
      expect(disconnect).toHaveBeenCalledWith(`study-room-${ROOM}`, USER, {
        revokeTokenTs: expect.any(BigInt),
      });
    } finally {
      disconnect.mockRestore();
    }
  });
  it('LiveKit 연결 해제가 실패하면 성공으로 응답하지 않는다', async () => {
    const disconnect = vi
      .spyOn(RoomServiceClient.prototype, 'removeParticipant')
      .mockRejectedValueOnce(new Error('unavailable'));
    try {
      await expect(setup().service.disconnect(ROOM, USER)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      disconnect.mockRestore();
    }
  });
  it('이미 없는 참가자는 반복 종료해도 성공하고 다른 실패는 알린다', async () => {
    const disconnect = vi.spyOn(RoomServiceClient.prototype, 'removeParticipant');
    disconnect.mockResolvedValueOnce(undefined);
    disconnect.mockRejectedValueOnce(
      new ServerError('Not Found', 'participant not found', 404, 'not_found'),
    );
    disconnect.mockRejectedValueOnce(
      new ServerError('Unavailable', 'network failure', 503, 'unavailable'),
    );
    try {
      const { service } = setup();
      await expect(service.disconnect(ROOM, USER)).resolves.toBeUndefined();
      await expect(service.disconnect(ROOM, USER)).resolves.toBeUndefined();
      await expect(service.disconnect(ROOM, USER)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(disconnect).toHaveBeenCalledTimes(3);
    } finally {
      disconnect.mockRestore();
    }
  });
  it('LiveKit 설정이 누락되면 서비스를 사용할 수 없다고 알린다', async () => {
    const { service } = setup();
    const old = values.LIVEKIT_API_SECRET;
    delete values.LIVEKIT_API_SECRET;
    try {
      await expect(service.issueToken(ROOM, USER)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    } finally {
      values.LIVEKIT_API_SECRET = old!;
    }
  });
});
