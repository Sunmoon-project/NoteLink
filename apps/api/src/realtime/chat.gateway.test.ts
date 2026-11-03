import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { Server, Socket } from 'socket.io';

import type { ChatService } from '../modules/studyroom/chat.service.js';
import { ChatGateway } from './chat.gateway.js';

const setup = () => {
  const chat = {
    assertMember: vi.fn().mockResolvedValue(undefined),
    studyRoomOf: vi.fn().mockResolvedValue('r1'),
    saveMessage: vi.fn().mockResolvedValue({ _id: 'm1', clientId: 'c1' }),
  };
  const jwt = { verifyAsync: vi.fn().mockResolvedValue({ sub: 'u1' }) };
  const config = { getOrThrow: () => 'secret' };
  const gateway = new ChatGateway(
    chat as unknown as ChatService,
    jwt as unknown as JwtService,
    config as unknown as ConfigService,
  );
  const emit = vi.fn();
  const socketsLeave = vi.fn();
  const server = {
    to: vi.fn(() => ({ emit })),
    in: vi.fn(() => ({ socketsLeave })),
    use: vi.fn(),
  };
  (gateway as unknown as { server: unknown }).server = server;
  const client = {
    data: { userId: 'u1' },
    handshake: { auth: { token: 't' }, headers: {} },
    join: vi.fn(),
    leave: vi.fn(),
    emit: vi.fn(),
  };
  return { gateway, chat, jwt, emit, socketsLeave, server, client };
};
type Authed = Parameters<ChatGateway['handleJoin']>[0];

describe('ChatGateway', () => {
  it('연결 전에 토큰을 검증하고 사용자 룸에 넣는다', async () => {
    const { gateway, server, client, jwt } = setup();
    gateway.afterInit(server as unknown as Server);
    const guard = server.use.mock.calls[0]?.[0] as unknown as (
      s: Socket,
      next: (e?: Error) => void,
    ) => void;
    await new Promise<void>((done) =>
      guard(client as unknown as Socket, (e) => {
        expect(e).toBeUndefined();
        done();
      }),
    );
    expect(client.join).toHaveBeenCalledWith('user:u1');

    jwt.verifyAsync.mockRejectedValue(new Error('expired'));
    await new Promise<void>((done) =>
      guard(client as unknown as Socket, (e) => {
        expect(e).toBeInstanceOf(Error);
        done();
      }),
    );
  });

  it('room:join은 멤버만 구독하고 확인 응답을 돌려준다', async () => {
    const { gateway, chat, client } = setup();
    await expect(
      gateway.handleJoin(client as unknown as Authed, { roomId: 'r1' }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(client.join).toHaveBeenCalledWith('study-room:r1');

    chat.assertMember.mockRejectedValue(new Error('no'));
    await expect(
      gateway.handleJoin(client as unknown as Authed, { roomId: 'r2' }),
    ).resolves.toEqual({
      ok: false,
    });
  });

  it('chat:send는 chatRoomId로 방을 찾아 방송하고 저장본으로 응답한다', async () => {
    const { gateway, chat, client, emit, server } = setup();
    const ack = await gateway.handleSend(client as unknown as Authed, {
      chatRoomId: 'c9',
      text: ' 안녕 ',
      clientId: 'c1',
    });
    expect(chat.saveMessage).toHaveBeenCalledWith('u1', 'r1', '안녕', 'c1');
    expect(server.to).toHaveBeenCalledWith('study-room:r1');
    expect(emit).toHaveBeenCalledWith('chat:message', ack);
    expect(ack).toMatchObject({ _id: 'm1', clientId: 'c1' });
  });

  it('실패한 전송은 확인 응답 없이 오류 이벤트만 보낸다', async () => {
    const { gateway, chat, client, emit } = setup();
    chat.assertMember.mockRejectedValue(new Error('no'));
    await expect(
      gateway.handleSend(client as unknown as Authed, { chatRoomId: 'c9', text: '안녕' }),
    ).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('chat:error', expect.anything());
  });

  it('스터디룸을 나가면 그 사용자의 모든 소켓을 구독에서 뺀다', () => {
    const { gateway, server, socketsLeave } = setup();
    gateway.removeFromRoom('u1', 'r1');
    expect(server.in).toHaveBeenCalledWith('user:u1');
    expect(socketsLeave).toHaveBeenCalledWith('study-room:r1');
  });
});
