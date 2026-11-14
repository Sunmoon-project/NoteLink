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
  private readonly roomOperations = new WeakMap<Socket, Map<string, Promise<unknown>>>();

  /** 같은 소켓·방의 입장과 퇴장이 서로의 구독을 지우지 않도록 순서대로 처리한다. */
  private inRoomOrder<T>(socket: Socket, roomId: string, operation: () => Promise<T>): Promise<T> {
    let rooms = this.roomOperations.get(socket);
    if (!rooms) {
      rooms = new Map();
      this.roomOperations.set(socket, rooms);
    }
    const previous = rooms.get(roomId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    rooms.set(roomId, current);
    void current
      .finally(() => {
        if (rooms.get(roomId) === current) rooms.delete(roomId);
      })
      .catch(() => {});
    return current;
  }
  notifyMembersChanged(roomId: string) {
    this.server.to(`study-room:${roomId}`).emit('room:members-changed', {
      roomId,
    });
  }
  notifyDirectMessage(message: { chatRoomId: string }) {
    this.server.to(`direct-chat:${message.chatRoomId}`).emit('chat:message', message);
  }
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
    if (typeof data?.roomId !== 'string') return { ok: false };
    const roomId = data.roomId;
    return this.inRoomOrder(socket, roomId, () => this.joinRoom(socket, roomId));
  }

  private async joinRoom(socket: Socket, roomId: string) {
    let channel: string | undefined;
    try {
      const userId = await this.identity(socket);
      const chat = await this.chat.getChat(roomId, userId);
      channel = `study-chat:${String(chat._id)}`;
      await socket.join(channel);
      await socket.join(`study-room:${roomId}`);
      const missed = await this.chat.history(String(chat._id), userId);
      const subscriptions = (socket.data.studyChats ??= {});
      subscriptions[roomId] = channel;
      return { ok: true, missed };
    } catch {
      if (channel) await socket.leave(channel);
      await socket.leave(`study-room:${roomId}`);
      return { ok: false };
    }
  }

  @SubscribeMessage('room:leave')
  async leave(@ConnectedSocket() socket: Socket, @MessageBody() data: { roomId?: unknown }) {
    if (typeof data?.roomId !== 'string') return;
    const roomId = data.roomId;
    return this.inRoomOrder(socket, roomId, async () => {
      const channel = socket.data.studyChats?.[roomId];
      if (typeof channel === 'string') await socket.leave(channel);
      await socket.leave(`study-room:${roomId}`);
      if (socket.data.studyChats) delete socket.data.studyChats[roomId];
    });
  }

  @SubscribeMessage('chat:join')
  async joinDirectChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chatRoomId?: unknown },
  ) {
    if (typeof data?.chatRoomId !== 'string') return { ok: false };
    const userId = await this.identity(socket);
    try {
      const chat = await this.chat.requireChat(data.chatRoomId, userId);
      if (chat.type !== 'direct') return { ok: false };
      const channel = `direct-chat:${data.chatRoomId}`;
      await socket.join(channel);
      return { ok: true, missed: await this.chat.history(data.chatRoomId, userId) };
    } catch {
      await socket.leave(`direct-chat:${data.chatRoomId}`);
      return { ok: false };
    }
  }

  @SubscribeMessage('chat:leave')
  async leaveDirectChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chatRoomId?: unknown },
  ) {
    if (typeof data?.chatRoomId === 'string') await socket.leave(`direct-chat:${data.chatRoomId}`);
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
    if (
      typeof data?.chatRoomId !== 'string' ||
      (!socket.rooms.has(`study-chat:${data.chatRoomId}`) &&
        !socket.rooms.has(`direct-chat:${data.chatRoomId}`))
    )
      throw new Error('not joined');
    const message = await this.chat.send(data.chatRoomId, userId, data.text, data.clientId);
    const channel = socket.rooms.has(`study-chat:${data.chatRoomId}`)
      ? `study-chat:${data.chatRoomId}`
      : `direct-chat:${data.chatRoomId}`;
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
