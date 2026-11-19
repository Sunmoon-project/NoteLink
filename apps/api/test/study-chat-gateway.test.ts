import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenService } from '../src/modules/auth/token.service.js';
import { StudyChatGateway } from '../src/modules/studyroom/study-chat.gateway.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';
import { StudyRoomNoticesService } from '../src/modules/studyroom/study-room-notices.service.js';

const message = {
  _id: 'msg',
  chatRoomId: 'chat',
  senderId: 'a',
  type: 'text',
  text: '안녕',
  sharedItemId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  clientId: 'client1',
};
const chat = {
  getChat: vi.fn(),
  requireChat: vi.fn(),
  requireActiveUser: vi.fn(),
  requireMember: vi.fn(),
  history: vi.fn(),
  send: vi.fn(),
  sendAttachment: vi.fn(),
};
const tokens = { verifyAccess: vi.fn() };
const notices = { chatMessage: vi.fn(async () => {}) };
let app: INestApplication;
let a: Socket;
let b: Socket;
let serverUrl: string;
beforeAll(async () => {
  const module = await Test.createTestingModule({
    providers: [
      StudyChatGateway,
      { provide: StudyChatService, useValue: chat },
      { provide: TokenService, useValue: tokens },
      { provide: StudyRoomNoticesService, useValue: notices },
    ],
  }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  tokens.verifyAccess.mockImplementation(async (token: string) => ({ userId: token }));
  const address = app.getHttpServer().address();
  const url = `http://127.0.0.1:${address.port}`;
  serverUrl = url;
  a = io(url, { transports: ['websocket'], auth: { token: 'a' } });
  b = io(url, { transports: ['websocket'], auth: { token: 'b' } });
  await Promise.all(
    [a, b].map(
      (socket) =>
        new Promise<void>((resolve, reject) => {
          socket.once('connect', resolve);
          socket.once('connect_error', reject);
        }),
    ),
  );
});
afterAll(async () => {
  a?.disconnect();
  b?.disconnect();
  await app?.close();
});
beforeEach(async () => {
  vi.resetAllMocks();
  tokens.verifyAccess.mockImplementation(async (token: string) => ({ userId: token }));
  chat.getChat.mockResolvedValue({ _id: 'chat' });
  chat.history.mockResolvedValue([]);
  chat.requireChat.mockResolvedValue({});
  chat.send.mockResolvedValue(message);
  await Promise.all(
    [a, b].map((socket) => socket.timeout(1000).emitWithAck('room:join', { roomId: 'room' })),
  );
});
describe('스터디룸 Socket.IO', () => {
  it('방 타이머 변경을 같은 방의 모든 참여자에게 전달한다', async () => {
    const receivedA = vi.fn();
    const receivedB = vi.fn();
    a.on('room:timer', receivedA);
    b.on('room:timer', receivedB);
    const rule = {
      enabled: true,
      type: 'pomodoro' as const,
      focusMin: 25,
      breakMin: 5,
      repeat: 4,
      periods: [],
    };
    const state = { phase: 'focus' as const, endsAt: '2026-11-15T10:25:00.000Z' };

    app.get(StudyChatGateway).notifyTimer('room', rule, state);

    await vi.waitFor(() => {
      expect(receivedA).toHaveBeenCalledWith({
        roomId: 'room',
        rule,
        phase: 'focus',
        endsAt: state.endsAt,
      });
      expect(receivedB).toHaveBeenCalledWith({
        roomId: 'room',
        rule,
        phase: 'focus',
        endsAt: state.endsAt,
      });
    });
    a.off('room:timer', receivedA);
    b.off('room:timer', receivedB);
  });

  it('탈퇴 중인 사용자의 방 구독(room:join)은 거절한다', async () => {
    chat.requireActiveUser.mockRejectedValueOnce(new Error('withdrawing'));
    chat.getChat.mockClear();
    expect(await a.timeout(2000).emitWithAck('room:join', { roomId: 'room' })).toEqual({
      ok: false,
    });
    expect(chat.requireActiveUser).toHaveBeenCalledWith('a');
    expect(chat.getChat).not.toHaveBeenCalled();
  });

  describe('채팅 기록을 불러오는 동안 상태가 바뀌는 입장(room:join)', () => {
    // 같은 사용자의 이전 구독 기록이 없도록 새 사용자(c)로 연결한다
    let c: Socket;
    const serverSocket = async () => {
      const { server } = app.get(StudyChatGateway) as unknown as {
        server: {
          fetchSockets: () => Promise<
            {
              handshake: { auth: { token?: string } };
              rooms: Set<string>;
              data: { studyChats?: Record<string, string> };
            }[]
          >;
        };
      };
      return (await server.fetchSockets()).find((socket) => socket.handshake.auth.token === 'c');
    };
    beforeEach(async () => {
      c = io(serverUrl, { transports: ['websocket'], auth: { token: 'c' } });
      await new Promise<void>((resolve, reject) => {
        c.once('connect', resolve);
        c.once('connect_error', reject);
      });
    });
    afterEach(() => void c.disconnect());

    it('정상 입장은 { ok: true } 와 놓친 메시지를 돌려주고 구독을 기록한다', async () => {
      chat.history.mockResolvedValue([message]);
      expect(await c.timeout(2000).emitWithAck('room:join', { roomId: 'room' })).toEqual({
        ok: true,
        missed: [message],
      });
      const joined = await serverSocket();
      expect(joined?.rooms).toContain('study-chat:chat');
      expect(joined?.rooms).toContain('study-room:room');
      expect(joined?.data.studyChats).toEqual({ room: 'study-chat:chat' });
    });

    it.each([
      ['탈퇴를 시작했으면', () => chat.requireActiveUser],
      ['방 멤버가 아니게 됐으면', () => chat.requireMember],
    ])(
      'history 를 기다리는 사이 사용자가 %s 실패하고 채널에서 빠지며 기록하지 않는다',
      async (_name, recheck) => {
        let finishHistory!: (messages: unknown[]) => void;
        chat.history.mockReturnValueOnce(
          new Promise((resolve) => {
            finishHistory = resolve;
          }),
        );
        const join = c.timeout(2000).emitWithAck('room:join', { roomId: 'room' });
        // history 를 기다리는 동안 이미 채널에는 들어가 있다(evict 가 아직 못 찾는 구간)
        await vi.waitFor(async () =>
          expect((await serverSocket())?.rooms).toContain('study-chat:chat'),
        );
        recheck().mockRejectedValueOnce(new Error('changed while loading history'));
        // 탈퇴 정리의 강제 구독 해제(evict)도 같은 사이에 실행된다: 아직 기록이 없어 채팅 채널은 못 찾아도 입장 쪽 재확인이 마저 뺀다
        await app.get(StudyChatGateway).evict('room', 'c');
        finishHistory([message]);
        expect(await join).toEqual({ ok: false });
        const after = await serverSocket();
        expect(after?.rooms).not.toContain('study-chat:chat');
        expect(after?.rooms).not.toContain('study-room:room');
        expect(after?.data.studyChats?.room).toBeUndefined();
      },
    );
  });

  it('이전 입장 요청이 늦게 실패해도 나중 입장의 구독을 해제하지 않는다', async () => {
    let failHistory!: (error: Error) => void;
    chat.history.mockReset();
    chat.history.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        failHistory = reject;
      }),
    );
    chat.history.mockResolvedValueOnce([]);
    const oldJoin = a.timeout(2000).emitWithAck('room:join', { roomId: 'room' });
    await vi.waitFor(() => expect(chat.history).toHaveBeenCalledTimes(1));
    const newJoin = a.timeout(2000).emitWithAck('room:join', { roomId: 'room' });
    failHistory(new Error('history failed'));
    expect(await oldJoin).toEqual({ ok: false });
    expect(await newJoin).toEqual({ ok: true, missed: [] });
    const received = vi.fn();
    a.on('room:members-changed', received);
    app.get(StudyChatGateway).notifyMembersChanged('room');
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith({ roomId: 'room' }));
    a.off('room:members-changed', received);
  });
  it('참가자 변경 알림은 해당 방에만 전달하고 강퇴된 사용자는 제외한다', async () => {
    const receivedA = vi.fn();
    const receivedB = vi.fn();
    a.on('room:members-changed', receivedA);
    b.on('room:members-changed', receivedB);
    await app.get(StudyChatGateway).evict('room', 'b');
    app.get(StudyChatGateway).notifyMembersChanged('room');
    await vi.waitFor(() => expect(receivedA).toHaveBeenCalledWith({ roomId: 'room' }));
    expect(receivedB).not.toHaveBeenCalled();
    a.off('room:members-changed', receivedA);
    b.off('room:members-changed', receivedB);
  });
  it('유효하지 않은 토큰으로 연결할 수 없다', async () => {
    tokens.verifyAccess.mockRejectedValueOnce(new Error('invalid token'));
    const invalid = io(serverUrl, {
      transports: ['websocket'],
      auth: { token: 'invalid' },
      reconnection: false,
    });
    const error = await new Promise<Error>((resolve) => invalid.once('connect_error', resolve));
    expect(error.message).toBe('unauthorized');
    invalid.disconnect();
  });
  it('저장이 완료된 후 참여자에게 전달하고 보낸 사람에게 확인한다', async () => {
    let finish!: (value: typeof message) => void;
    chat.send.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onMessage = vi.fn();
    b.on('chat:message', onMessage);
    const ack = a
      .timeout(1000)
      .emitWithAck('chat:send', { chatRoomId: 'chat', text: '안녕', clientId: 'client1' });
    await vi.waitFor(() => expect(chat.send).toHaveBeenCalledOnce());
    expect(onMessage).not.toHaveBeenCalled();
    finish(message);
    expect(await ack).toEqual(message);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(message));
    // 소켓으로 받은 사람(보낸 사람 포함)을 알려 그 사람들은 푸시에서 빠지게 한다
    const [sentMessage, delivered] = notices.chatMessage.mock.calls.at(-1) as unknown as [
      typeof message,
      string[],
    ];
    expect(sentMessage).toEqual(message);
    expect([...delivered].sort()).toEqual(['a', 'b']);
    b.off('chat:message', onMessage);
  });
  // 스터디룸 채팅 사진 · 파일: 같은 chat:send에 attachment를 담아 보낸다
  it('attachment를 담아 보내면 첨부 메시지로 저장해 참여자에게 전달한다', async () => {
    const photo = { ...message, type: 'image', text: null };
    chat.sendAttachment.mockResolvedValue(photo);
    const onMessage = vi.fn();
    b.on('chat:message', onMessage);
    const attachment = {
      blobUrl: 'https://store/raw/chat/image/a/x.jpg',
      kind: 'image',
      name: 'x.jpg',
    };
    const ack = await a
      .timeout(1000)
      .emitWithAck('chat:send', { chatRoomId: 'chat', clientId: 'client2', attachment });
    expect(chat.sendAttachment).toHaveBeenCalledWith(
      'chat',
      expect.any(String),
      attachment,
      'client2',
    );
    expect(ack).toEqual(photo);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(photo));
    b.off('chat:message', onMessage);
  });
  it('퇴장한 참여자는 방송에서 제외한다', async () => {
    chat.requireChat.mockImplementation(async (_chatId: string, userId: string) => {
      if (userId === 'b') throw new Error('not a member');
      return {};
    });
    const onMessage = vi.fn();
    b.on('chat:message', onMessage);
    await a
      .timeout(1000)
      .emitWithAck('chat:send', { chatRoomId: 'chat', text: '안녕', clientId: 'client1' });
    expect(onMessage).not.toHaveBeenCalled();
    b.off('chat:message', onMessage);
  });
  it('폐기되거나 만료된 DM 세션에는 스터디룸 초대 메시지를 전달하지 않는다', async () => {
    chat.requireChat.mockResolvedValue({ type: 'direct' });
    for (const socket of [a, b]) {
      expect(
        await socket.timeout(1000).emitWithAck('chat:join', { chatRoomId: 'chat' }),
      ).toMatchObject({ ok: true });
    }
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === 'b') throw new Error('session revoked');
      return { userId: token };
    });
    const receivedA = vi.fn();
    const receivedB = vi.fn();
    a.on('chat:message', receivedA);
    b.on('chat:message', receivedB);

    await app.get(StudyChatGateway).notifyDirectMessage({
      chatRoomId: 'chat',
      type: 'study_room_invite',
      studyRoomInvite: { inviteCode: 'SECRET' },
    } as never);
    await vi.waitFor(() => expect(receivedA).toHaveBeenCalledOnce());
    expect(receivedB).not.toHaveBeenCalled();
    // 초대 카드도 알림으로 넘긴다(만료된 b는 받은 사람에서 빠진다)
    expect(notices.chatMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'study_room_invite' }),
      ['a'],
    );

    a.off('chat:message', receivedA);
    b.off('chat:message', receivedB);
  });
  it('DM 입장 조회 중 퇴장 요청이 오면 퇴장을 마지막에 적용한다', async () => {
    chat.requireChat.mockResolvedValue({ type: 'direct' });
    let finishJoin!: (value: { type: 'direct' }) => void;
    chat.requireChat.mockReturnValueOnce(new Promise((resolve) => (finishJoin = resolve)));
    const received = vi.fn();
    a.on('chat:message', received);

    const joining = a.timeout(2000).emitWithAck('chat:join', { chatRoomId: 'chat' });
    await vi.waitFor(() => expect(chat.requireChat).toHaveBeenCalledOnce());
    const leaving = a.timeout(2000).emitWithAck('chat:leave', { chatRoomId: 'chat' });
    finishJoin({ type: 'direct' });
    expect(await joining).toMatchObject({ ok: true });
    await leaving;

    await app.get(StudyChatGateway).notifyDirectMessage({ chatRoomId: 'chat' } as never);
    expect(received).not.toHaveBeenCalled();
    a.off('chat:message', received);
  });
  it('이전 DM 입장의 늦은 실패가 뒤이은 성공 구독을 해제하지 않는다', async () => {
    chat.requireChat.mockResolvedValue({ type: 'direct' });
    let failOldJoin!: (error: Error) => void;
    chat.requireChat.mockReturnValueOnce(new Promise((_resolve, reject) => (failOldJoin = reject)));
    const received = vi.fn();
    a.on('chat:message', received);

    const oldJoin = a.timeout(2000).emitWithAck('chat:join', { chatRoomId: 'chat' });
    await vi.waitFor(() => expect(chat.requireChat).toHaveBeenCalledOnce());
    const newJoin = a.timeout(2000).emitWithAck('chat:join', { chatRoomId: 'chat' });
    failOldJoin(new Error('old membership check failed'));
    expect(await oldJoin).toMatchObject({ ok: false });
    expect(await newJoin).toMatchObject({ ok: true });

    await app.get(StudyChatGateway).notifyDirectMessage({ chatRoomId: 'chat' } as never);
    await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
    a.off('chat:message', received);
  });
  it('강퇴된 사용자의 방 구독을 제거한다', async () => {
    const receive = vi.fn();
    b.on('chat:message', receive);
    await app.get(StudyChatGateway).evict('room', 'b');
    await a.timeout(1000).emitWithAck('chat:send', {
      chatRoomId: 'chat',
      text: '안녕',
      clientId: 'client1',
    });
    expect(receive).not.toHaveBeenCalled();
    b.off('chat:message', receive);
  });
  it('DB 저장이 실패하면 성공 확인과 방송을 보내지 않는다', async () => {
    chat.send.mockRejectedValue(new Error('DB unavailable'));
    const receive = vi.fn();
    b.on('chat:message', receive);
    await expect(
      a.timeout(150).emitWithAck('chat:send', {
        chatRoomId: 'chat',
        text: '안녕',
        clientId: 'client1',
      }),
    ).rejects.toThrow();
    expect(receive).not.toHaveBeenCalled();
    b.off('chat:message', receive);
  });
  it('만료된 토큰으로 보낸 메시지는 거부하고 새 토큰으로 재연결·재입장하면 복구된다', async () => {
    tokens.verifyAccess.mockImplementation(async (token: string) => {
      if (token === 'a') throw new Error('expired');
      return { userId: token === 'renewed-a' ? 'a' : token };
    });
    await expect(
      a.timeout(150).emitWithAck('chat:send', {
        chatRoomId: 'chat',
        text: '안녕',
        clientId: 'expired',
      }),
    ).rejects.toThrow();
    expect(chat.send).not.toHaveBeenCalled();
    a.disconnect();
    a.auth = { token: 'renewed-a' };
    const reconnected = new Promise<void>((resolve, reject) => {
      a.once('connect', resolve);
      a.once('connect_error', reject);
    });
    a.connect();
    await reconnected;
    expect(await a.timeout(1000).emitWithAck('room:join', { roomId: 'room' })).toMatchObject({
      ok: true,
    });
    const received = vi.fn();
    a.on('chat:message', received);
    await b.timeout(1000).emitWithAck('chat:send', {
      chatRoomId: 'chat',
      text: '안녕',
      clientId: 'after-reconnect',
    });
    await vi.waitFor(() => expect(received).toHaveBeenCalledWith(message));
    a.off('chat:message', received);
  });
});
