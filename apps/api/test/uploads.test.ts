import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { BlobStorageService } from '../src/modules/upload/blob-storage.service.js';
import { UploadsController } from '../src/modules/upload/uploads.controller.js';
import { UploadsService } from '../src/modules/upload/uploads.service.js';

const user = new Types.ObjectId();
const storage = { createUpload: vi.fn() };
const input = {
  kind: 'image',
  purpose: 'report',
  fileName: 'photo.JPG',
  contentType: 'image/jpeg',
  sizeBytes: 1024,
};
let app: INestApplication;

beforeAll(async () => {
  const module = await Test.createTestingModule({
    controllers: [UploadsController],
    providers: [
      UploadsService,
      { provide: BlobStorageService, useValue: storage },
      {
        provide: TokenService,
        useValue: {
          verifyAccess: (token: string) =>
            token === 'valid'
              ? Promise.resolve({ userId: String(user) })
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
  storage.createUpload.mockResolvedValue({
    uploadUrl: 'https://example.test/a?sas',
    blobUrl: 'https://example.test/a',
    expiresAt: '2026-01-01T00:00:00.000Z',
    headers: { 'x-ms-blob-type': 'BlockBlob' },
  });
});

describe('POST /api/v1/uploads/sas', () => {
  it('인증된 사용자에게 신고 사진 전용 임의 경로의 업로드 주소를 반환한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/uploads/sas')
      .set('Authorization', 'Bearer valid')
      .send(input);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      blobUrl: 'https://example.test/a',
      headers: { 'x-ms-blob-type': 'BlockBlob' },
    });
    expect(storage.createUpload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^reports/${user}/[0-9a-f-]+\\.jpg$`)),
    );
  });
  it('인증되지 않은 업로드 요청을 거부한다', async () => {
    expect(
      (await request(app.getHttpServer()).post('/api/v1/uploads/sas').send(input)).status,
    ).toBe(401);
    expect(storage.createUpload).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, sizeBytes: 0 },
    { ...input, sizeBytes: 20 * 1024 * 1024 + 1 },
    { ...input, fileName: 'photo.png', contentType: 'image/jpeg' },
    { ...input, kind: 'document', fileName: 'x.pdf', contentType: 'application/pdf' },
    { ...input, fileName: 'photo.exe' },
    { ...input, purpose: 'invalid' },
  ])('허용하지 않는 파일과 목적을 거부한다', async (body) => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/uploads/sas')
      .set('Authorization', 'Bearer valid')
      .send(body);
    expect(response.status).toBe(400);
    expect(storage.createUpload).not.toHaveBeenCalled();
  });
});
