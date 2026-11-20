import { Injectable } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import type { Types } from 'mongoose';
import type { StudyRoom, TimerRule } from '@notelink/shared';
import { TokenService } from '../auth/token.service.js';
import { StudyChatService } from './study-chat.service.js';
import { StudyRoomNoticesService, type ChatMessageView } from './study-room-notices.service.js';

const LIVE_PREFIX = 'study-room:';
const WATCH_PREFIX = 'study-room-watch:';
/** 목록 한 번에 지켜보는 방 수 상한(참여 방 수보다 넉넉히) */
const MAX_WATCH = 100;

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
  notifyTimer(roomId: string, rule: TimerRule | null, state: StudyRoom['timerState']) {
    this.server.to(`study-room:${roomId}`).emit('room:timer', {
      roomId,
      rule,
      phase: state?.phase ?? 'focus',
      endsAt: state?.endsAt ?? null,
    });
  }
  async notifyDirectMessage(message: ChatMessageView) {
    const channel = `direct-chat:${message.chatRoomId}`;
    const delivered: string[] = [];
    const recipients = await this.server
      .in(channel)
      .fetchSockets()
      .catch(() => []);
    for (const recipient of recipients) {
      try {
        const token = recipient.handshake.auth?.token;
        if (typeof token !== 'string') throw new Error('unauthorized');
        const { userId } = await this.tokens.verifyAccess(token);
        const chat = await this.chat.requireChat(message.chatRoomId, userId);
        if (chat.type !== 'direct') throw new Error('not a direct chat member');
        recipient.emit('chat:message', message);
        delivered.push(userId);
      } catch {
        await recipient.leave(channel);
      }
    }
    // 그 채팅을 보고 있지 않은 상대에게 푸시(초대 카드는 방 활동 알림). 기다리지 않는다
    void this.notices.chatMessage(message, delivered);
  }
  async notifyStudyMessage(message: { chatRoomId: string }) {
    if (!this.server) return;
    const channel = `study-chat:${message.chatRoomId}`;
    const recipients = await this.server
      .in(channel)
      .fetchSockets()
      .catch(() => []);
    for (const recipient of recipients) {
      try {
        const token = recipient.handshake.auth?.token;
        if (typeof token !== 'string') throw new Error('unauthorized');
        const { userId } = await this.tokens.verifyAccess(token);
        const chat = await this.chat.requireChat(message.chatRoomId, userId);
        if (chat.type !== 'study_room') throw new Error('not a study room');
        recipient.emit('chat:message', message);
      } catch {
        await recipient.leave(channel);
      }
    }
  }
  @WebSocketServer() private server: Server;
  constructor(
    private readonly tokens: TokenService,
    private readonly chat: StudyChatService,
    private readonly notices: StudyRoomNoticesService,
  ) {}

  afterInit(server: Server) {
    server.use((socket, next) => {
      void this.identity(socket).then(
        (userId) => {
          // 접속 현황(room:live)은 소켓 id 로만 알 수 있어 연결 때 확인한 사용자를 붙여 둔다
          socket.data.userId = userId;
          next();
        },
        () => next(new Error('unauthorized')),
      );
    });
    // 방 화면은 들어오면 room:join, 나가면 room:leave(끊기면 저절로 빠진다)로 study-room:<id> 채널을 드나든다.
    // 들어오기는 멤버 확인이 끝난 뒤(joinRoom), 나가기는 채널에서 빠질 때마다 지켜보는 목록에 바로 알린다
    server.of('/').adapter.on('leave-room', (channel: string) => {
      if (channel.startsWith(LIVE_PREFIX)) this.notifyLive(channel.slice(LIVE_PREFIX.length));
    });
  }

  private notifyLive(roomId: string) {
    this.server
      .to(`${WATCH_PREFIX}${roomId}`)
      .emit('room:live', { roomId, userIds: this.liveUserIds(roomId) });
  }

  /** 지금 그 방 화면에 들어와 있는 사람: 입장(room:join)이 확정된 소켓만, 같은 사람의 여러 기기는 한 번 */
  private liveUserIds(roomId: string) {
    const sockets = this.server.of('/').sockets;
    const ids = [...(this.server.of('/').adapter.rooms.get(`${LIVE_PREFIX}${roomId}`) ?? [])]
      .map((id) => sockets.get(id)?.data)
      .filter((data) => typeof data?.studyChats?.[roomId] === 'string')
      .map((data) => data?.userId as unknown)
      .filter((userId): userId is string => typeof userId === 'string');
    return [...new Set(ids)];
  }

  /** 스터디룸 목록: 내 방들의 접속 현황을 지켜본다. 멤버가 아닌 방은 빼고 돌려준다 */
  @SubscribeMessage('rooms:watch')
  async watch(@ConnectedSocket() socket: Socket, @MessageBody() data: { roomIds?: unknown }) {
    const roomIds = Array.isArray(data?.roomIds)
      ? [...new Set(data.roomIds.filter((id): id is string => typeof id === 'string'))].slice(
          0,
          MAX_WATCH,
        )
      : [];
    let watched: string[];
    try {
      const userId = await this.identity(socket);
      const members = async (ids: string[]) =>
        (
          await Promise.all(
            ids.map(async (roomId) => {
              try {
                await this.chat.requireMember(roomId, userId);
                return roomId;
              } catch {
                return null;
              }
            }),
          )
        ).filter((roomId): roomId is string => roomId !== null);
      const allowed = await members(roomIds);
      await socket.join(allowed.map((roomId) => `${WATCH_PREFIX}${roomId}`));
      // 확인과 가입 사이에 강퇴(evict)되면 evict 가 이 채널을 못 찾는다: 가입한 뒤 다시 확인해 빠진 방은 뺀다(joinRoom 과 같은 방식)
      watched = await members(allowed);
      for (const roomId of allowed)
        if (!watched.includes(roomId)) await socket.leave(`${WATCH_PREFIX}${roomId}`);
    } catch {
      return { ok: false, live: {} };
    }
    // 가입을 모두 마친 뒤 한꺼번에 계산한다: 이후 바뀐 것은 room:live 로 오고, 그 전 것이 뒤늦게 덮어쓰지 않는다
    return { ok: true, live: Object.fromEntries(watched.map((id) => [id, this.liveUserIds(id)])) };
  }

  @SubscribeMessage('rooms:unwatch')
  async unwatch(@ConnectedSocket() socket: Socket, @MessageBody() data: { roomIds?: unknown }) {
    const roomIds = Array.isArray(data?.roomIds) ? data.roomIds : [];
    for (const roomId of roomIds)
      if (typeof roomId === 'string') await socket.leave(`${WATCH_PREFIX}${roomId}`);
    return { ok: true };
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
      await this.chat.requireActiveUser(userId);
      const chat = await this.chat.getChat(roomId, userId);
      channel = `study-chat:${String(chat._id)}`;
      await socket.join(channel);
      await socket.join(`study-room:${roomId}`);
      const missed = await this.chat.history(String(chat._id), userId);
      // history 를 기다리는 사이 탈퇴 정리 · 퇴장이 있었으면 구독을 확정하지 않는다(실패하면 아래 catch 가 채널에서 뺀다).
      // 확인 직후 바로 기록해야 그 뒤의 evict 가 이 구독을 찾을 수 있으니 이 둘 사이에는 await 를 두지 않는다
      await this.chat.requireActiveUser(userId);
      await this.chat.requireMember(roomId, userId);
      const subscriptions = (socket.data.studyChats ??= {});
      subscriptions[roomId] = channel;
      this.notifyLive(roomId);
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
    const chatRoomId = data.chatRoomId;
    return this.inRoomOrder(socket, `direct:${chatRoomId}`, async () => {
      const channel = `direct-chat:${chatRoomId}`;
      try {
        const userId = await this.identity(socket);
        const chat = await this.chat.requireChat(chatRoomId, userId);
        if (chat.type !== 'direct') {
          await socket.leave(channel);
          return { ok: false };
        }
        await socket.join(channel);
        return { ok: true, missed: await this.chat.history(chatRoomId, userId) };
      } catch {
        await socket.leave(channel);
        return { ok: false };
      }
    });
  }

  @SubscribeMessage('chat:leave')
  async leaveDirectChat(
    @ConnectedSocket() socket: Socket,
    @MessageBody() data: { chatRoomId?: unknown },
  ) {
    if (typeof data?.chatRoomId === 'string') {
      const chatRoomId = data.chatRoomId;
      return this.inRoomOrder(socket, `direct:${chatRoomId}`, async () => {
        await socket.leave(`direct-chat:${chatRoomId}`);
        return { ok: true };
      });
    }
  }

  async evict(roomId: string, userId: string) {
    // 방 화면에 있는 소켓과 목록에서 접속 현황만 지켜보는 소켓 모두
    const sockets = await this.server
      .in([`study-room:${roomId}`, `${WATCH_PREFIX}${roomId}`])
      .fetchSockets();
    for (const socket of sockets) {
      try {
        const token = socket.handshake.auth?.token;
        if (typeof token !== 'string') continue;
        if ((await this.tokens.verifyAccess(token)).userId !== userId) continue;
        // 지켜보기부터 뺀다: study-room 에서 빠지면 접속 현황(room:live)이 지켜보는 채널로 나가는데, 강퇴된 사람이 받지 않게
        await socket.leave(`${WATCH_PREFIX}${roomId}`);
        await socket.leave(`study-room:${roomId}`);
        const channel = socket.data.studyChats?.[roomId];
        if (typeof channel === 'string') await socket.leave(channel);
      } catch {
        // 유효하지 않은 토큰도 더 이상 방 이벤트를 받지 못하게 한다.
        await socket.leave(`${WATCH_PREFIX}${roomId}`);
        await socket.leave(`study-room:${roomId}`);
        const channel = socket.data.studyChats?.[roomId];
        if (typeof channel === 'string') await socket.leave(channel);
      }
    }
  }

  @SubscribeMessage('chat:send')
  async send(
    @ConnectedSocket() socket: Socket,
    @MessageBody()
    data: { chatRoomId?: unknown; text?: unknown; clientId?: unknown; attachment?: unknown },
  ) {
    const userId = await this.identity(socket);
    if (
      typeof data?.chatRoomId !== 'string' ||
      (!socket.rooms.has(`study-chat:${data.chatRoomId}`) &&
        !socket.rooms.has(`direct-chat:${data.chatRoomId}`))
    )
      throw new Error('not joined');
    // 사진 · 파일은 attachment로, 글은 text로 보낸다
    const message =
      data.attachment !== undefined
        ? await this.chat.sendAttachment(data.chatRoomId, userId, data.attachment, data.clientId)
        : await this.chat.send(data.chatRoomId, userId, data.text, data.clientId);
    const channel = socket.rooms.has(`study-chat:${data.chatRoomId}`)
      ? `study-chat:${data.chatRoomId}`
      : `direct-chat:${data.chatRoomId}`;
    const delivered = await this.deliver(channel, data.chatRoomId, message);
    // 소켓으로 받은 사람(그 채팅을 보고 있는 사람)을 뺀 멤버에게 푸시. 기다리지 않는다(보낸 사람 확인을 늦추지 않게)
    void this.notices.chatMessage(message, delivered);
    return message;
  }

  /**
   * 노트를 방에 공유하면 방 채팅에 자료 카드를 올리고, 그 채팅을 보고 있는 멤버에게 바로 보낸다.
   * 푸시는 보내지 않는다(공유가 이미 「노트를 공유했어요」 알림을 보낸다)
   */
  async postSharedNotes(
    roomId: string,
    userId: string,
    items: { sharedItemId: Types.ObjectId; title: string }[],
  ) {
    const { chatRoomId, messages } = await this.chat.postSharedNotes(roomId, userId, items);
    for (const message of messages)
      await this.deliver(`study-chat:${chatRoomId}`, chatRoomId, message);
  }

  /** 나간 사용자에게 전달하지 않도록 각 연결의 토큰과 현재 멤버십을 다시 검사해 보낸다. 받은 사람 id 를 돌려준다 */
  private async deliver(channel: string, chatRoomId: string, message: unknown) {
    const delivered: string[] = [];
    for (const recipient of await this.server.in(channel).fetchSockets()) {
      try {
        const token = recipient.handshake.auth?.token;
        if (typeof token !== 'string') throw new Error('unauthorized');
        const receiver = await this.tokens.verifyAccess(token);
        await this.chat.requireChat(chatRoomId, receiver.userId);
        recipient.emit('chat:message', message);
        delivered.push(receiver.userId);
      } catch {
        await recipient.leave(channel);
      }
    }
    return delivered;
  }
}
