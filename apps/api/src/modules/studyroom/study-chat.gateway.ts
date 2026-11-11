import { Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { TokenService } from '../auth/token.service.js';
import { StudyChatService } from './study-chat.service.js';

@Injectable()
@WebSocketGateway()
export class StudyChatGateway {
  @WebSocketServer() private server: Server;
  constructor(
    private readonly tokens: TokenService,
    private readonly chat: StudyChatService,
  ) {}

  afterInit(server: Server) {
    server.use((socket, next) => {
      void this.identity(socket).then(
        () => next(),
        () => next(new Error('unauthorized')),
      );
    });
  }

  private async identity(socket: Socket) {
    const token = socket.handshake.auth?.token;
    if (typeof token !== 'string') throw new Error('unauthorized');
    return (await this.tokens.verifyAccess(token)).userId;
  }

  @SubscribeMessage('room:join')
  async join(@ConnectedSocket() socket: Socket, @MessageBody() data: { roomId?: unknown }) {
    let channel: string | undefined;
    try {
      const userId = await this.identity(socket);
      if (typeof data?.roomId !== 'string') return { ok: false };
      const chat = await this.chat.getChat(data.roomId, userId);
      channel = `study-chat:${String(chat._id)}`;
      await socket.join(channel);
      await socket.join(`study-room:${data.roomId}`);
      const missed = await this.chat.history(String(chat._id), userId);
      const subscriptions = (socket.data.studyChats ??= {});
      subscriptions[data.roomId] = channel;
      return { ok: true, missed };
    } catch {
      if (channel) await socket.leave(channel);
      if (typeof data?.roomId === 'string') await socket.leave(`study-room:${data.roomId}`);
      return { ok: false };
    }
  }

  @SubscribeMessage('room:leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() data: { roomId?: unknown }) {
    if (typeof data?.roomId !== 'string') return;
    const channel = socket.data.studyChats?.[data.roomId];
    if (typeof channel === 'string') await socket.leave(channel);
    await socket.leave(`study-room:${data.roomId}`);
    if (socket.data.studyChats) delete socket.data.studyChats[data.roomId];
  }

  async evict(roomId: string, userId: string) {
    const sockets = await this.server.in(`study-room:${roomId}`).fetchSockets();
    for (const socket of sockets) {
      try {
        const token = socket.handshake.auth?.token;
        if (typeof token !== 'string') continue;
        if ((await this.tokens.verifyAccess(token)).userId !== userId) continue;
        await socket.leave(`study-room:${roomId}`);
        const channel = socket.data.studyChats?.[roomId];
        if (typeof channel === 'string') await socket.leave(channel);
      } catch {
        // 유효하지 않은 토큰도 더 이상 방 이벤트를 받지 못하게 한다.
        await socket.leave(`study-room:${roomId}`);
        const channel = socket.data.studyChats?.[roomId];
        if (typeof channel === 'string') await socket.leave(channel);
      }
    }
  }

  @SubscribeMessage('chat:send')
  async send(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chatRoomId?: unknown; text?: unknown; clientId?: unknown },
  ) {
    const userId = await this.identity(socket);
    if (typeof data?.chatRoomId !== 'string' || !socket.rooms.has(`study-chat:${data.chatRoomId}`))
      throw new Error('not joined');
    const message = await this.chat.send(data.chatRoomId, userId, data.text, data.clientId);
    const channel = `study-chat:${data.chatRoomId}`;
    // 나간 사용자에게 전달하지 않도록 각 연결의 토큰과 현재 멤버십을 다시 검사한다.
    for (const recipient of await this.server.in(channel).fetchSockets()) {
      try {
        const token = recipient.handshake.auth?.token;
        if (typeof token !== 'string') throw new Error('unauthorized');
        const receiver = await this.tokens.verifyAccess(token);
        await this.chat.requireChat(data.chatRoomId, receiver.userId);
        recipient.emit('chat:message', message);
      } catch {
        await recipient.leave(channel);
      }
    }
    return message;
  }
}
