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
import { StudyRoom } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';
import { StudyChatGateway } from '../src/modules/studyroom/study-chat.gateway.js';
import { StudyRoomsController } from '../src/modules/studyroom/study-rooms.controller.js';
import { StudyRoomsService } from '../src/modules/studyroom/study-rooms.service.js';

const userId = new Types.ObjectId();
const roomId = new Types.ObjectId();
const chatId = new Types.ObjectId();
const studyRooms = { findOne: vi.fn() };
const chats = { findOneAndUpdate: vi.fn(), findOne: vi.fn() };
const lean = (value: unknown) => ({ lean: () => Promise.resolve(value) });
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [StudyRoomsController],
    providers: [
      StudyChatService,
      { provide: StudyChatGateway, useValue: { evict: vi.fn() } },
      { provide: StudyRoomsService, useValue: {} },
      { provide: getModelToken(StudyRoom.name), useValue: studyRooms },
      { provide: getModelToken(ChatRoom.name), useValue: chats },
      { provide: getModelToken(Message.name), useValue: {} },
      { provide: getModelToken(User.name), useValue: {} },
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
