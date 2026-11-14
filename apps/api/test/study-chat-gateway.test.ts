import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenService } from '../src/modules/auth/token.service.js';
import { StudyChatGateway } from '../src/modules/studyroom/study-chat.gateway.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';

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
const chat = { getChat: vi.fn(), requireChat: vi.fn(), history: vi.fn(), send: vi.fn() };
const tokens = { verifyAccess: vi.fn() };
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

    await app.get(StudyChatGateway).notifyDirectMessage({ chatRoomId: 'chat' });
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

    await app.get(StudyChatGateway).notifyDirectMessage({ chatRoomId: 'chat' });
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
