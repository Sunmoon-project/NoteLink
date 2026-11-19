import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenService } from '../src/modules/auth/token.service.js';
import { StudyChatGateway } from '../src/modules/studyroom/study-chat.gateway.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';
import { StudyRoomNoticesService } from '../src/modules/studyroom/study-room-notices.service.js';

// 스터디룸 목록의 「지금 접속 중」: 방 화면이 room:join 한 소켓을 목록 화면이 rooms:watch 로 지켜본다
const chat = {
  getChat: vi.fn(),
  requireChat: vi.fn(),
  requireActiveUser: vi.fn(),
  requireMember: vi.fn(),
  history: vi.fn(),
};
const tokens = { verifyAccess: vi.fn() };
let app: INestApplication;
let url: string;
const opened: Socket[] = [];

const connect = async (token: string) => {
  const socket = io(url, { transports: ['websocket'], auth: { token }, forceNew: true });
  opened.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
  return socket;
};

beforeAll(async () => {
  const module = await Test.createTestingModule({
    providers: [
      StudyChatGateway,
      { provide: StudyChatService, useValue: chat },
      { provide: TokenService, useValue: tokens },
      { provide: StudyRoomNoticesService, useValue: { chatMessage: vi.fn() } },
    ],
  }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  url = `http://127.0.0.1:${app.getHttpServer().address().port}`;
});
afterAll(async () => {
  await app?.close();
});
beforeEach(() => {
  vi.resetAllMocks();
  tokens.verifyAccess.mockImplementation(async (token: string) => ({ userId: token }));
  chat.getChat.mockResolvedValue({ _id: 'chat' });
  chat.history.mockResolvedValue([]);
});
afterEach(() => {
  opened.splice(0).forEach((socket) => socket.disconnect());
});

describe('스터디룸 목록 접속 현황(rooms:watch · room:live)', () => {
  it('지켜보기 시작하면 지금 방에 들어와 있는 사람을 돌려주고, 들어오고 나갈 때마다 바로 알린다', async () => {
    const watcher = await connect('w');
    const a = await connect('a');
    await a.timeout(2000).emitWithAck('room:join', { roomId: 'r1' });

    expect(
      await watcher.timeout(2000).emitWithAck('rooms:watch', { roomIds: ['r1', 'r2'] }),
    ).toEqual({ ok: true, live: { r1: ['a'], r2: [] } });

    const live = vi.fn();
    watcher.on('room:live', live);
    const b = await connect('b');
    await b.timeout(2000).emitWithAck('room:join', { roomId: 'r1' });
    await vi.waitFor(() =>
      expect(live).toHaveBeenLastCalledWith({ roomId: 'r1', userIds: ['a', 'b'] }),
    );

    a.emit('room:leave', { roomId: 'r1' });
    await vi.waitFor(() => expect(live).toHaveBeenLastCalledWith({ roomId: 'r1', userIds: ['b'] }));

    // 앱을 끄거나 회선이 끊겨도(leave 없이) 바로 빠진다
    b.disconnect();
    await vi.waitFor(() => expect(live).toHaveBeenLastCalledWith({ roomId: 'r1', userIds: [] }));
  });

  it('같은 사람이 두 기기로 들어와 있어도 한 번만 센다', async () => {
    const watcher = await connect('w');
    for (const socket of [await connect('a'), await connect('a')])
      await socket.timeout(2000).emitWithAck('room:join', { roomId: 'r1' });
    expect(await watcher.timeout(2000).emitWithAck('rooms:watch', { roomIds: ['r1'] })).toEqual({
      ok: true,
      live: { r1: ['a'] },
    });
  });

  it('멤버가 아닌 방은 지켜볼 수 없다', async () => {
    chat.requireMember.mockImplementation(async (roomId: string) => {
      if (roomId === 'secret') throw new Error('not a member');
    });
    const watcher = await connect('w');
    const a = await connect('a');
    await a.timeout(2000).emitWithAck('room:join', { roomId: 'secret' });

    expect(await watcher.timeout(2000).emitWithAck('rooms:watch', { roomIds: ['secret'] })).toEqual(
      { ok: true, live: {} },
    );
    const live = vi.fn();
    watcher.on('room:live', live);
    a.emit('room:leave', { roomId: 'secret' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(live).not.toHaveBeenCalled();
  });

  it('그만 지켜보면(rooms:unwatch) 더 알리지 않는다', async () => {
    const watcher = await connect('w');
    await watcher.timeout(2000).emitWithAck('rooms:watch', { roomIds: ['r1'] });
    await watcher.timeout(2000).emitWithAck('rooms:unwatch', { roomIds: ['r1'] });
    const live = vi.fn();
    watcher.on('room:live', live);
    const a = await connect('a');
    await a.timeout(2000).emitWithAck('room:join', { roomId: 'r1' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(live).not.toHaveBeenCalled();
  });
});

describe('강퇴(evict)', () => {
  it('목록에서 지켜보던 소켓도 그 방 접속 현황을 더 받지 않는다', async () => {
    const watcher = await connect('w');
    await watcher.timeout(2000).emitWithAck('rooms:watch', { roomIds: ['r1'] });
    await app.get(StudyChatGateway).evict('r1', 'w');
    const live = vi.fn();
    watcher.on('room:live', live);
    const a = await connect('a');
    await a.timeout(2000).emitWithAck('room:join', { roomId: 'r1' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(live).not.toHaveBeenCalled();
  });
});

describe('입장 확정 전', () => {
  it('멤버 확인이 끝나지 않은 입장은 세지도 알리지도 않고, 확인에 실패하면 끝까지 빠진다', async () => {
    let release!: () => void;
    chat.history.mockImplementation(
      (_chatId: string, userId: string) =>
        new Promise((resolve) => {
          if (userId !== 'gone') return resolve([]);
          release = () => resolve([]);
        }),
    );
    chat.requireMember.mockImplementation(async (_roomId: string, userId: string) => {
      if (userId === 'gone' && release === undefined) return;
      if (userId === 'gone') throw new Error('left');
    });
    const watcher = await connect('w');
    const live = vi.fn();
    watcher.on('room:live', live);
    const gone = await connect('gone');
    const joining = gone.timeout(2000).emitWithAck('room:join', { roomId: 'r1' });
    await vi.waitFor(() => expect(release).toBeDefined());
    // 채널에는 들어갔지만 아직 확정 전: 지켜보기 스냅샷에 없다
    expect(await watcher.timeout(2000).emitWithAck('rooms:watch', { roomIds: ['r1'] })).toEqual({
      ok: true,
      live: { r1: [] },
    });
    release();
    expect(await joining).toEqual({ ok: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const [payload] of live.mock.calls) expect(payload.userIds).not.toContain('gone');
  });
});
