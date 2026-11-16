import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { ImagesController } from '../src/modules/content/images/images.controller.js';
import { ImagesService } from '../src/modules/content/images/images.service.js';
import { UPLOAD_RULES } from '@notelink/shared';

const userId = new Types.ObjectId().toHexString();
const file = {
  name: '0-notes.jpg',
  sizeBytes: 1234,
  uri: 'https://stnotelinkdev01.blob.core.windows.net/notelink/uploads/image/file.jpg',
};

function setup(configValues: Record<string, string | undefined> = {}) {
  const config = { get: (key: string) => configValues[key] };
  const blobs = {
    createImageCheckReadUrl: vi.fn(async (_userId: string, uri: string) => `${uri}?sig=read`),
  };
  const service = new ImagesService(config as never, blobs as never);
  return { service, blobs };
}

describe('ImagesService.check', () => {
  const fetchMock = vi.fn();
  let blobs: ReturnType<typeof setup>['blobs'];
  let service: ImagesService;

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    ({ service, blobs } = setup({
      AI_INTERNAL_URL: 'https://ai.example.test/',
      AI_INTERNAL_TOKEN: 'internal-token',
    }));
  });
  afterAll(() => vi.unstubAllGlobals());

  it('파일 소유자를 SAS 발급에 사용하고 AI 인증·판정 응답을 검증한다', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ name: file.name, verdict: 'ok' }] }), { status: 200 }),
    );

    await expect(service.check(userId, { files: [file] })).resolves.toEqual([
      { name: file.name, verdict: 'ok' },
    ]);
    expect(blobs.createImageCheckReadUrl).toHaveBeenCalledWith(userId, file.uri);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://ai.example.test/internal/v1/images/check',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer internal-token' }),
        body: JSON.stringify({ files: [{ name: file.name, uri: `${file.uri}?sig=read` }] }),
      }),
    );
  });

  it('잘못된 입력·중복 이름·최대 크기 초과는 Blob이나 AI를 호출하기 전에 거부한다', async () => {
    await expect(service.check(userId, { files: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.check(userId, { files: [file, file] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.check(userId, {
        files: [{ ...file, sizeBytes: UPLOAD_RULES.image.maxBytes + 1 }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(blobs.createImageCheckReadUrl).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Blob 소유권 확인이 거부되면 AI 호출을 하지 않는다', async () => {
    blobs.createImageCheckReadUrl.mockRejectedValueOnce(new BadRequestException());
    await expect(service.check(userId, { files: [file] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AI 설정 누락·서버 오류·누락 또는 변조된 결과를 서비스 오류로 처리한다', async () => {
    const unconfigured = new ImagesService({ get: () => undefined } as never, blobs as never);
    await expect(unconfigured.check(userId, { files: [file] })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(service.check(userId, { files: [file] })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ name: file.name, verdict: 'accepted' }] }), {
        status: 200,
      }),
    );
    await expect(service.check(userId, { files: [file] })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ name: 'another.jpg', verdict: 'ok' }] }), {
        status: 200,
      }),
    );
    await expect(service.check(userId, { files: [file] })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('POST /api/v1/images/check 인증', () => {
  const images = { check: vi.fn() };
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [ImagesController],
      providers: [
        { provide: ImagesService, useValue: images },
        {
          provide: TokenService,
          useValue: {
            verifyAccess: (token: string) =>
              token === 'valid'
                ? Promise.resolve({ userId })
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
    images.check.mockResolvedValue([{ name: file.name, verdict: 'ok' }]);
  });

  it('인증된 사용자 ID를 검사 서비스에 전달한다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/images/check')
      .set('Authorization', 'Bearer valid')
      .send({ files: [file] });
    expect(response.status).toBe(201);
    expect(response.body.data).toEqual([{ name: file.name, verdict: 'ok' }]);
    expect(images.check).toHaveBeenCalledWith(userId, { files: [file] });
  });

  it('인증되지 않은 요청은 검사 서비스에 도달하지 않는다', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/images/check')
      .send({ files: [file] });
    expect(response.status).toBe(401);
    expect(images.check).not.toHaveBeenCalled();
  });
});
