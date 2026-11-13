import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessToken, RoomServiceClient, ServerError } from 'livekit-server-sdk';
import { StudyChatService } from './study-chat.service.js';

@Injectable()
export class StudyLiveService {
  constructor(
    private readonly config: ConfigService,
    private readonly chat: StudyChatService,
  ) {}

  async issueToken(roomId: string, userId: string) {
    await this.chat.requireMember(roomId, userId);
    const url = this.config.get<string>('LIVEKIT_URL')?.trim();
    const apiKey = this.config.get<string>('LIVEKIT_API_KEY')?.trim();
    const secret = this.config.get<string>('LIVEKIT_API_SECRET')?.trim();
    if (!url || !apiKey || !secret || !/^wss?:\/\//.test(url)) {
      throw new ServiceUnavailableException({
        code: 'LIVEKIT_UNAVAILABLE',
        message: '라이브 연결을 준비하지 못했어요',
      });
    }
    const token = new AccessToken(apiKey, secret, { identity: userId, ttl: '5m' });
    token.addGrant({
      roomJoin: true,
      room: `study-room-${roomId}`,
      canPublish: true,
      canSubscribe: true,
    });
    const signed = await token.toJwt();
    // 발급 중 퇴장한 사용자는 이미 만든 토큰을 받지 못한다.
    await this.chat.requireMember(roomId, userId);
    return { url, token: signed };
  }

  async disconnect(roomId: string, userId: string) {
    const url = this.config.get<string>('LIVEKIT_URL')?.trim();
    const apiKey = this.config.get<string>('LIVEKIT_API_KEY')?.trim();
    const secret = this.config.get<string>('LIVEKIT_API_SECRET')?.trim();
    // LiveKit을 구성하지 않은 환경은 애초에 라이브 토큰을 발급하지 않는다.
    if (!url && !apiKey && !secret) return;
    if (!url || !apiKey || !secret || !/^wss?:\/\//.test(url)) {
      throw new ServiceUnavailableException({
        code: 'LIVEKIT_UNAVAILABLE',
        message: '라이브 연결을 종료하지 못했어요',
      });
    }
    const host = url.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
    try {
      await new RoomServiceClient(host, apiKey, secret).removeParticipant(
        `study-room-${roomId}`,
        userId,
        { revokeTokenTs: BigInt(Math.floor(Date.now() / 1000)) },
      );
    } catch (error) {
      // 이미 나간 참가자나 사라진 방은 종료할 연결이 없다. 다른 장애는 재시도할 수 있게 알린다.
      if (error instanceof ServerError && error.code === 'not_found') return;
      throw new ServiceUnavailableException({
        code: 'LIVEKIT_DISCONNECT_FAILED',
        message: '라이브 연결을 종료하지 못했어요. 다시 시도해 주세요',
      });
    }
  }
}
