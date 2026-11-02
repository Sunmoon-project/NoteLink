import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import { CHAT_EVENTS } from '../modules/studyroom/chat.events.js';
import { ChatService } from '../modules/studyroom/chat.service.js';

// 소켓에 로그인 사용자 정보를 붙여두기 위한 타입
interface AuthedSocket extends Socket {
  data: { userId?: string };
}

/**
 * 스터디룸 채팅 게이트웨이 (Socket.IO).
 * REST가 경로로 분기한다면, 여기서는 @SubscribeMessage(이벤트 이름)로 분기합니다.
 */
@WebSocketGateway({
  namespace: '/chat',
  cors: { origin: '*' }, // 개발용. 운영에서는 허용 도메인으로 제한하세요.
})
export class ChatGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** 소켓이 연결될 때 JWT를 검증합니다. 실패하면 연결을 끊습니다. */
  async handleConnection(client: AuthedSocket): Promise<void> {
    try {
      const token = this.extractToken(client);
      const payload = await this.jwtService.verifyAsync<{ sub: string }>(
        token,
        { secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET') },
      );
      client.data.userId = payload.sub;
    } catch {
      client.emit(CHAT_EVENTS.ERROR, {
        code: 'UNAUTHORIZED',
        message: '인증이 필요합니다.',
      });
      client.disconnect(true);
    }
  }

  /** 방 입장: 참여 멤버인지 확인 후 Socket.IO 룸에 join */
  @SubscribeMessage(CHAT_EVENTS.JOIN)
  async handleJoin(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId: string },
  ): Promise<void> {
    const userId = client.data.userId;
    if (!userId) {
      return;
    }
    try {
      await this.chatService.assertMember(userId, body.roomId);
      await client.join(this.roomName(body.roomId));
      client.emit(CHAT_EVENTS.JOINED, { roomId: body.roomId });
    } catch (err) {
      this.emitError(client, err);
    }
  }

  /** 방 퇴장: Socket.IO 룸에서 나감(스터디룸 자체 탈퇴와는 별개) */
  @SubscribeMessage(CHAT_EVENTS.LEAVE)
  async handleLeave(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId: string },
  ): Promise<void> {
    await client.leave(this.roomName(body.roomId));
  }

  /** 메시지 전송: 저장한 뒤 같은 방 사람들에게 실시간 전달 */
  @SubscribeMessage(CHAT_EVENTS.SEND)
  async handleSend(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId: string; text: string },
  ): Promise<void> {
    const userId = client.data.userId;
    if (!userId) {
      return;
    }

    const text = (body.text ?? '').trim();
    if (!text) {
      this.emitError(client, {
        code: 'EMPTY_MESSAGE',
        message: '빈 메시지는 보낼 수 없습니다.',
      });
      return;
    }

    try {
      // 멤버 확인 → 저장 → 같은 방에 방송
      await this.chatService.assertMember(userId, body.roomId);
      const message = await this.chatService.saveMessage(
        userId,
        body.roomId,
        text,
      );
      this.server
        .to(this.roomName(body.roomId))
        .emit(CHAT_EVENTS.MESSAGE, message);
    } catch (err) {
      this.emitError(client, err);
    }
  }

  // --- 헬퍼 ---

  private roomName(roomId: string): string {
    return `study-room:${roomId}`;
  }

  /** 핸드셰이크 auth.token 또는 Authorization 헤더에서 JWT를 꺼냅니다. */
  private extractToken(client: Socket): string {
    const authToken = (client.handshake.auth as { token?: string })?.token;
    if (authToken) {
      return authToken.replace(/^Bearer\s+/i, '');
    }
    const header = client.handshake.headers.authorization;
    if (header) {
      return header.replace(/^Bearer\s+/i, '');
    }
    throw new Error('no token');
  }

  private emitError(client: Socket, err: unknown): void {
    const payload =
      err && typeof err === 'object' && 'response' in err
        ? (err as { response: unknown }).response
        : err && typeof err === 'object' && 'code' in err
          ? err
          : { code: 'CHAT_ERROR', message: '채팅 처리 중 오류가 발생했습니다.' };
    client.emit(CHAT_EVENTS.ERROR, payload);
  }
}
