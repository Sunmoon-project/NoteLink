import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Types } from 'mongoose';
import type { Server, Socket } from 'socket.io';

import { CHAT_EVENTS } from '../modules/studyroom/chat.events.js';
import { ChatMessageView, ChatService } from '../modules/studyroom/chat.service.js';

// 소켓에 로그인 사용자 정보를 붙여두기 위한 타입
interface AuthedSocket extends Socket {
  data: { userId?: string };
}

/**
 * 스터디룸 채팅 게이트웨이 (Socket.IO).
 * REST가 경로로 분기한다면, 여기서는 @SubscribeMessage(이벤트 이름)로 분기합니다.
 */
// 소켓 본문은 DTO 검증을 거치지 않으므로 입구에서 형식을 확인합니다.
const HEX_ID = /^[0-9a-fA-F]{24}$/;
const hexId = (value: unknown): string => {
  if (typeof value !== 'string' || !HEX_ID.test(value)) {
    throw { code: 'ROOM_NOT_FOUND', message: '존재하지 않는 스터디룸입니다.' };
  }
  return value.toLowerCase();
};

// 앱은 기본 네임스페이스에 연결합니다 (apps/mobile lib/socket.ts).
@WebSocketGateway({
  cors: { origin: '*' }, // 개발용. 운영에서는 허용 도메인으로 제한하세요.
})
export class ChatGateway implements OnGatewayInit {
  @WebSocketServer()
  private server!: Server;

  constructor(
    private readonly chatService: ChatService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  /** 연결 전에 JWT를 검증해, connect가 끝난 소켓은 항상 로그인 상태입니다. */
  afterInit(server: Server): void {
    server.use((client: AuthedSocket, next) => {
      void this.authenticate(client).then(
        () => next(),
        () =>
          next(Object.assign(new Error('인증이 필요합니다.'), { data: { code: 'UNAUTHORIZED' } })),
      );
    });
  }

  private async authenticate(client: AuthedSocket): Promise<void> {
    const payload = await this.jwtService.verifyAsync<{ sub: string }>(this.extractToken(client), {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
    });
    client.data.userId = payload.sub;
    // 사용자 단위로 내보낼 수 있게 (removeFromRoom)
    await client.join(this.userRoom(payload.sub));
  }

  /** 스터디룸을 나간 사용자의 모든 소켓을 그 방 구독에서 뺍니다. */
  removeFromRoom(userId: string, roomId: string): void {
    this.server.in(this.userRoom(userId)).socketsLeave(this.roomName(roomId));
  }

  /** 방 입장: 참여 멤버인지 확인 후 Socket.IO 룸에 join */
  @SubscribeMessage(CHAT_EVENTS.JOIN)
  async handleJoin(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId: string },
  ): Promise<{ ok: boolean }> {
    try {
      const roomId = hexId(body?.roomId);
      await this.chatService.assertMember(client.data.userId!, roomId);
      await client.join(this.roomName(roomId));
      return { ok: true };
    } catch (err) {
      this.emitError(client, err);
      return { ok: false };
    }
  }

  /** 방 퇴장: Socket.IO 룸에서 나감(스터디룸 자체 탈퇴와는 별개) */
  @SubscribeMessage(CHAT_EVENTS.LEAVE)
  async handleLeave(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { roomId: string },
  ): Promise<void> {
    if (HEX_ID.test(String(body?.roomId))) await client.leave(this.roomName(body.roomId));
  }

  /** 메시지 전송: 저장한 뒤 같은 방에 방송하고, 보낸 사람에게 저장본을 확인 응답으로 돌려줍니다. */
  @SubscribeMessage(CHAT_EVENTS.SEND)
  async handleSend(
    @ConnectedSocket() client: AuthedSocket,
    @MessageBody() body: { chatRoomId: string; text: string; clientId?: string },
  ): Promise<ChatMessageView | undefined> {
    const userId = client.data.userId!;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      this.emitError(client, {
        code: 'EMPTY_MESSAGE',
        message: '빈 메시지는 보낼 수 없습니다.',
      });
      return undefined;
    }

    try {
      const roomId = await this.chatService.studyRoomOf(hexId(body.chatRoomId));
      await this.chatService.assertMember(userId, roomId);
      const message = await this.chatService.saveMessage(userId, roomId, text, body.clientId);
      this.server.to(this.roomName(roomId)).emit(CHAT_EVENTS.MESSAGE, message);
      return message;
    } catch (err) {
      // 앱의 확인 콜백은 Message만 받으므로 실패는 오류 이벤트로만 알립니다.
      this.emitError(client, err);
      return undefined;
    }
  }

  // --- 헬퍼 ---

  private userRoom(userId: string): string {
    return `user:${userId}`;
  }

  private roomName(roomId: string): string {
    // ObjectId는 대소문자 · 12자 표기도 통과하므로 표기를 하나로 맞춥니다.
    return `study-room:${new Types.ObjectId(roomId).toHexString()}`;
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
