import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { ChatRoom } from '../src/modules/social/schemas/chat-room.schema.js';
import { Message } from '../src/modules/social/schemas/message.schema.js';
import { Report } from '../src/modules/social/schemas/report.schema.js';
import { ReportsController } from '../src/modules/social/reports.controller.js';
import { ReportsService } from '../src/modules/social/reports.service.js';
import { StudyRoom } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';
import { BlobStorageService } from '../src/modules/upload/blob-storage.service.js';

const reporter = new Types.ObjectId();
const target = new Types.ObjectId();
const roomId = new Types.ObjectId();
const reportId = new Types.ObjectId();
const rooms = { findOne: vi.fn() };
const reports = { create: vi.fn() };
const storage = { keepReportImages: vi.fn() };
const KEPT = ['https://blob.example.com/raw/reports/kept.jpg'];
const valid = {
  roomId: String(roomId),
  targetUserId: String(target),
  reportType: 'spam',
  details: '반복적으로 광고 메시지를 보냅니다',
  imageUrls: ['https://blob.example.com/image.jpg'],
};
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [ReportsController],
    providers: [
      ReportsService,
      StudyChatService,
      { provide: BlobStorageService, useValue: storage },
      { provide: getModelToken(StudyRoom.name), useValue: rooms },
      { provide: getModelToken(Report.name), useValue: reports },
      { provide: getModelToken(ChatRoom.name), useValue: {} },
      { provide: getModelToken(Message.name), useValue: {} },
      { provide: getModelToken(User.name), useValue: {} },
      {
        provide: TokenService,
        useValue: {
          verifyAccess: (token: string) =>
            token === 'valid'
              ? Promise.resolve({ userId: String(reporter) })
              : Promise.reject(new UnauthorizedException()),
        },
      },
    ],
  }).compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.init();
});
afterAll(async () => app.close());
beforeEach(() => {
  vi.resetAllMocks();
  storage.keepReportImages.mockImplementation(async (_: string, urls: string[]) =>
    urls.length ? KEPT : [],
  );
  rooms.findOne.mockReturnValue({
    lean: async () => ({
      members: [
        { userId: reporter, status: 'joined' },
        { userId: target, status: 'joined' },
      ],
    }),
  });
  reports.create.mockResolvedValue({ _id: reportId, status: 'pending' });
});

describe('POST /api/v1/reports', () => {
  it('방 참여자의 신고를 인증된 신고자와 함께 저장하고 접수 결과를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set('Authorization', 'Bearer valid')
      .send({ ...valid, details: `  ${valid.details}  ` });
    expect(response.status).toBe(201);
    expect(response.body).toEqual({ data: { _id: String(reportId), status: 'pending' } });
    expect(storage.keepReportImages).toHaveBeenCalledWith(String(reporter), valid.imageUrls);
    expect(rooms.findOne).toHaveBeenCalledWith({
      _id: roomId,
      closedAt: null,
      members: { $elemMatch: { userId: reporter, status: 'joined' } },
    });
    expect(reports.create).toHaveBeenCalledWith({
      roomId,
      reporterId: reporter,
      targetUserId: target,
      reportType: 'spam',
      details: valid.details,
      // 앱이 보낸 임시 주소가 아니라 보관 경로로 복사한 주소를 저장
      imageUrls: KEPT,
      status: 'pending',
    });
  });

  it('인증되지 않은 요청이나 현재 방에 참여하지 않은 신고자는 거부한다', async () => {
    expect((await request(app.getHttpServer()).post('/api/v1/reports').send(valid)).status).toBe(
      401,
    );
    rooms.findOne.mockReturnValue({ lean: async () => null });
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set('Authorization', 'Bearer valid')
      .send(valid);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ code: 'NOT_FOUND' });
    expect(reports.create).not.toHaveBeenCalled();
  });

  it('자기 자신이나 퇴장한 참가자는 신고할 수 없다', async () => {
    const self = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set('Authorization', 'Bearer valid')
      .send({ ...valid, targetUserId: String(reporter).toUpperCase() });
    expect(self.status).toBe(400);
    rooms.findOne.mockReturnValue({
      lean: async () => ({
        members: [
          { userId: reporter, status: 'joined' },
          { userId: target, status: 'left' },
        ],
      }),
    });
    const left = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set('Authorization', 'Bearer valid')
      .send(valid);
    expect(left.status).toBe(404);
    expect(reports.create).not.toHaveBeenCalled();
  });

  it.each([
    { ...valid, details: '   짧은 내용   ' },
    { ...valid, details: '가'.repeat(501) },
    { ...valid, reportType: 'unknown' },
    { ...valid, roomId: 'invalid' },
    { ...valid, imageUrls: Array(6).fill('https://blob.example.com/image.jpg') },
    { ...valid, imageUrls: ['file:///private/photo.jpg'] },
    { ...valid, reporterId: String(target) },
  ])('잘못된 입력을 거부하고 저장하지 않는다', async (body) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set('Authorization', 'Bearer valid')
      .send(body);
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'BAD_REQUEST' });
    expect(reports.create).not.toHaveBeenCalled();
  });

  it('첨부 없이 10글자 신고를 접수한다', async () => {
    const { imageUrls: _, ...withoutImages } = valid;
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set('Authorization', 'Bearer valid')
      .send({ ...withoutImages, details: '가'.repeat(10) });
    expect(response.status).toBe(201);
    expect(reports.create).toHaveBeenCalledWith(
      expect.objectContaining({ imageUrls: [], details: '가'.repeat(10) }),
    );
  });

  it('신고 사진 검증에 실패하면 신고를 저장하지 않는다', async () => {
    storage.keepReportImages.mockRejectedValueOnce(new UnauthorizedException());
    const response = await request(app.getHttpServer())
      .post('/api/v1/reports')
      .set('Authorization', 'Bearer valid')
      .send(valid);
    expect(response.status).toBe(401);
    expect(reports.create).not.toHaveBeenCalled();
  });
});
