import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getModelToken } from '@nestjs/mongoose';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { Category } from '../src/modules/content/schemas/category.schema.js';
import { ChatRoom } from '../src/modules/social/schemas/chat-room.schema.js';
import { Message } from '../src/modules/social/schemas/message.schema.js';
import { Friendship } from '../src/modules/social/schemas/friendship.schema.js';
import { StudyRoom } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';
import { StudyChatGateway } from '../src/modules/studyroom/study-chat.gateway.js';
import { StudyRoomsController } from '../src/modules/studyroom/study-rooms.controller.js';
import { StudyRoomMembershipService } from '../src/modules/studyroom/study-room-membership.service.js';
import { StudyRoomsService } from '../src/modules/studyroom/study-rooms.service.js';
import { StudyLiveService } from '../src/modules/studyroom/study-live.service.js';

const userId = new Types.ObjectId();
const roomId = new Types.ObjectId();
const chatId = new Types.ObjectId();
const studyRooms = { findOne: vi.fn() };
const chats = { findOneAndUpdate: vi.fn(), findOne: vi.fn() };
const roomsService = { setTimerRule: vi.fn() };
const gateway = { evict: vi.fn(), notifyTimer: vi.fn() };
const live = { issueToken: vi.fn(), disconnect: vi.fn() };
const membership = { leave: vi.fn() };
const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [StudyRoomsController],
    providers: [
      StudyChatService,
      { provide: StudyLiveService, useValue: live },
      { provide: StudyChatGateway, useValue: gateway },
      { provide: StudyRoomsService, useValue: roomsService },
      { provide: StudyRoomMembershipService, useValue: membership },
      { provide: getModelToken(StudyRoom.name), useValue: studyRooms },
      { provide: getModelToken(ChatRoom.name), useValue: chats },
      { provide: getModelToken(Message.name), useValue: {} },
      { provide: getModelToken(User.name), useValue: {} },
      { provide: getModelToken(Friendship.name), useValue: {} },
      { provide: getModelToken(Category.name), useValue: {} },
      {
        provide: TokenService,
        useValue: {
          verifyAccess: (token: string) =>
            token === 'valid'
              ? Promise.resolve({ userId: String(userId) })
              : Promise.reject(new UnauthorizedException()),
        },
      },
    ],
  }).compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.init();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.resetAllMocks();
  roomsService.setTimerRule.mockResolvedValue({
    _id: String(roomId),
    timerRule: {
      enabled: false,
      type: 'pomodoro',
      focusMin: 50,
      breakMin: 10,
      repeat: 4,
      periods: [],
    },
    timerState: null,
  });
  studyRooms.findOne.mockReturnValue(lean({ _id: roomId }));
  chats.findOneAndUpdate.mockReturnValue({
    lean: () => ({ orFail: async () => ({ _id: chatId }) }),
  });
});

describe('스터디룸 채팅방 접근', () => {
  const url = `/api/v1/study-rooms/${roomId}/chat-room`;
  it('참여자에게 채팅방 ID를 반환한다', async () => {
    const res = await request(app.getHttpServer()).get(url).set('Authorization', 'Bearer valid');
    expect(res.status).toBe(200);
    expect(res.body.data.chatRoomId).toBe(String(chatId));
    expect(studyRooms.findOne).toHaveBeenCalledWith({
      _id: roomId,
      closedAt: null,
      members: { $elemMatch: { userId, status: 'joined' } },
    });
    expect(chats.findOneAndUpdate).toHaveBeenCalledWith(
      { type: 'study_room', studyRoomId: roomId },
      expect.anything(),
      expect.objectContaining({ upsert: true }),
    );
  });
  it('인증되지 않은 요청과 현재 참여 중이 아닌 사용자를 거부한다', async () => {
    expect((await request(app.getHttpServer()).get(url)).status).toBe(401);
    studyRooms.findOne.mockReturnValue(lean(null));
    expect(
      (await request(app.getHttpServer()).get(url).set('Authorization', 'Bearer valid')).status,
    ).toBe(404);
    expect(chats.findOneAndUpdate).not.toHaveBeenCalled();
  });
  it('올바르지 않은 방 ID는 DB에 질의하지 않는다', async () => {
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/v1/study-rooms/invalid/chat-room')
          .set('Authorization', 'Bearer valid')
      ).status,
    ).toBe(404);
    expect(studyRooms.findOne).not.toHaveBeenCalled();
  });
  it('유일 인덱스 충돌 시 이미 만들어진 방을 반환한다', async () => {
    chats.findOneAndUpdate.mockReturnValue({
      lean: () => ({
        orFail: async () => {
          throw { code: 11000 };
        },
      }),
    });
    chats.findOne.mockReturnValue(lean({ _id: chatId }));
    const res = await request(app.getHttpServer()).get(url).set('Authorization', 'Bearer valid');
    expect(res.status).toBe(200);
    expect(res.body.data.chatRoomId).toBe(String(chatId));
  });
});

describe('스터디룸 나가기 API', () => {
  const url = `/api/v1/study-rooms/${roomId}/leave`;
  it('묶음 나가기(membership.leave)를 부르고 기존과 같이 { data: null }을 돌려준다', async () => {
    membership.leave.mockResolvedValue(undefined);
    const res = await request(app.getHttpServer()).post(url).set('Authorization', 'Bearer valid');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ data: null });
    expect(membership.leave).toHaveBeenCalledWith(String(userId), String(roomId));
  });
  it('나가기가 실패하면 오류를 그대로 돌려주고, 인증 없이는 부르지 않는다', async () => {
    membership.leave.mockRejectedValue(new Error('연결 끊기 실패'));
    const res = await request(app.getHttpServer()).post(url).set('Authorization', 'Bearer valid');
    expect(res.status).toBe(500);
    membership.leave.mockClear();
    expect((await request(app.getHttpServer()).post(url)).status).toBe(401);
    expect(membership.leave).not.toHaveBeenCalled();
  });
});

describe('스터디룸 타이머 API', () => {
  it('인증된 방장 요청을 규칙 저장 서비스에 전달하고 타이머를 방송한다', async () => {
    const rule = {
      enabled: true,
      type: 'pomodoro',
      focusMin: 25,
      breakMin: 5,
      repeat: 4,
      periods: [],
    };
    roomsService.setTimerRule.mockResolvedValueOnce({
      _id: String(roomId),
      timerRule: rule,
      timerState: { phase: 'focus', endsAt: '2026-11-15T10:25:00.000Z' },
    });

    const response = await request(app.getHttpServer())
      .put(`/api/v1/study-rooms/${roomId}/timer-rule`)
      .set('Authorization', 'Bearer valid')
      .send(rule);

    expect(response.status).toBe(200);
    expect(response.body.data.timerRule).toEqual(rule);
    expect(roomsService.setTimerRule).toHaveBeenCalledWith(String(userId), String(roomId), rule);
    expect(gateway.notifyTimer).toHaveBeenCalledWith(String(roomId), rule, {
      phase: 'focus',
      endsAt: '2026-11-15T10:25:00.000Z',
    });
  });

  it('잘못된 타이머 범위는 저장 서비스에 전달하지 않는다', async () => {
    const response = await request(app.getHttpServer())
      .put(`/api/v1/study-rooms/${roomId}/timer-rule`)
      .set('Authorization', 'Bearer valid')
      .send({
        enabled: true,
        type: 'pomodoro',
        focusMin: 0,
        breakMin: 5,
        repeat: 4,
        periods: [],
      });

    expect(response.status).toBe(400);
    expect(roomsService.setTimerRule).not.toHaveBeenCalled();
  });
});

describe('스터디 라이브 토큰 API', () => {
  it('로그인한 사용자의 방 ID와 사용자 ID로 토큰을 발급한다', async () => {
    live.issueToken.mockResolvedValue({ token: 'test-token', url: 'wss://example.test' });
    const url = `/api/v1/study-rooms/${roomId}/livekit-token`;
    expect((await request(app.getHttpServer()).post(url)).status).toBe(401);
    const response = await request(app.getHttpServer())
      .post(url)
      .set('Authorization', 'Bearer valid');
    expect(response.status).toBe(201);
    expect(response.body.data).toEqual({ token: 'test-token', url: 'wss://example.test' });
    expect(live.issueToken).toHaveBeenCalledWith(String(roomId), String(userId));
  });
});
