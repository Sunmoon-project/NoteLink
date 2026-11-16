import { BlockBlobClient } from '@azure/storage-blob';
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PATHS, UPLOAD_RULES } from '@notelink/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { BlobStorageService } from '../src/modules/upload/blob-storage.service.js';
import { ImageCheckService } from '../src/modules/upload/image-check/image-check.service.js';
import { ImagesController } from '../src/modules/upload/image-check/images.controller.js';

const account = 'stnotelinkdev01';
const container = 'notelink';
const connectionString = `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${Buffer.alloc(32, 1).toString('base64')};EndpointSuffix=core.windows.net`;
const me = '507f1f77bcf86cd799439011';
const other = '507f1f77bcf86cd799439012';
const base = `https://${account}.blob.core.windows.net/${container}`;
const uuid = (n: number) => `550e8400-e29b-41d4-a716-${String(n).padStart(12, '0')}`;
const photo = (n: number, ext = 'jpg', owner = me) =>
  `${base}/uploads/image/${owner}/${uuid(n)}.${ext}`;
const env: Record<string, string> = {
  AZURE_BLOB_ACCOUNT_URL: `https://${account}.blob.core.windows.net`,
  AZURE_BLOB_CONTAINER: container,
  AZURE_STORAGE_CONNECTION_STRING: connectionString,
};

describe('필기 사진 검사 (POST /api/v1/images/check)', () => {
  let app: INestApplication;
  let configured = true;
  const getProperties = vi.spyOn(BlockBlobClient.prototype, 'getProperties');

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      controllers: [ImagesController],
      providers: [
        ImageCheckService,
        BlobStorageService,
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (configured ? env[key] : undefined) },
        },
        {
          provide: TokenService,
          useValue: {
            verifyAccess: (token: string) =>
              token === 'valid'
                ? Promise.resolve({ userId: me })
                : Promise.reject(new UnauthorizedException()),
          },
        },
      ],
    }).compile();
    app = ref.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    getProperties.mockRestore();
    await app.close();
  });

  beforeEach(() => {
    configured = true;
    getProperties.mockReset();
    getProperties.mockResolvedValue({ contentLength: 1024, contentType: 'image/jpeg' } as never);
  });

  const post = (body: unknown, token = 'valid') =>
    request(app.getHttpServer())
      .post(`/api/v1${PATHS.imageCheck}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);
  const file = (name: string, uri: string) => ({ name, sizeBytes: 0, uri });

  it('로그인하지 않으면 401, 저장소를 부르지 않는다', async () => {
    await post({ files: [file('a', photo(1))] }, 'nope').expect(401);
    expect(getProperties).not.toHaveBeenCalled();
  });

  it('내 사진 폴더에 실제로 있는 사진은 ok, 보낸 순서와 이름 그대로 200 으로 돌려준다', async () => {
    const res = await post({
      files: [
        file('0-a.jpg', photo(1)),
        file('1-b.PNG', photo(2, 'png')),
        file('2-c', photo(3, 'heic')),
      ],
    }).expect(200);
    expect(res.body).toEqual({
      data: [
        { name: '0-a.jpg', verdict: 'ok' },
        { name: '1-b.PNG', verdict: 'ok' },
        { name: '2-c', verdict: 'ok' },
      ],
    });
    expect(getProperties).toHaveBeenCalledTimes(3);
  });

  it('앱이 보낸 크기가 아니라 저장소의 실제 크기로 한도를 본다', async () => {
    getProperties
      .mockResolvedValueOnce({
        contentLength: UPLOAD_RULES.image.maxBytes,
        contentType: 'image/png',
      } as never)
      .mockResolvedValueOnce({
        contentLength: UPLOAD_RULES.image.maxBytes + 1,
        contentType: 'image/png',
      } as never);
    const res = await post({
      files: [
        { name: 'a', sizeBytes: 1, uri: photo(1) },
        { name: 'b', sizeBytes: 1, uri: photo(2) },
      ],
    }).expect(200);
    expect(res.body.data).toEqual([
      { name: 'a', verdict: 'ok' },
      { name: 'b', verdict: 'not_allowed' },
    ]);
  });

  it('남의 사진 · 사진 폴더 밖 · 다른 저장소 · 이름 규칙이 다른 주소는 저장소를 부르지 않고 not_allowed', async () => {
    const bad = [
      photo(1, 'jpg', other),
      `${base}/uploads/document/${me}/${uuid(1)}.jpg`,
      `${base}/reports/${me}/${uuid(1)}.jpg`,
      `https://evil.example/${container}/uploads/image/${me}/${uuid(1)}.jpg`,
      `${base}/uploads/image/${me}/not-a-uuid.jpg`,
      `${photo(1)}?sv=x&sig=y`,
    ];
    const res = await post({ files: bad.map((u, i) => file(`f${i}`, u)) }).expect(200);
    expect(res.body.data.map((v: { verdict: string }) => v.verdict)).toEqual(
      bad.map(() => 'not_allowed'),
    );
    expect(getProperties).not.toHaveBeenCalled();
  });

  it('사진이 아닌 확장자는 저장소를 부르지 않고 not_allowed', async () => {
    const res = await post({
      files: [file('a', photo(1, 'pdf')), file('b', photo(2, 'gif')), file('c', photo(3))],
    }).expect(200);
    expect(res.body.data.map((v: { verdict: string }) => v.verdict)).toEqual([
      'not_allowed',
      'not_allowed',
      'ok',
    ]);
    expect(getProperties).toHaveBeenCalledTimes(1);
  });

  it('올리지 않은(없는) 파일 · 빈 파일은 not_allowed', async () => {
    getProperties
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValueOnce({ contentLength: 0, contentType: 'image/jpeg' } as never);
    const res = await post({ files: [file('a', photo(1)), file('b', photo(2))] }).expect(200);
    expect(res.body.data.map((v: { verdict: string }) => v.verdict)).toEqual([
      'not_allowed',
      'not_allowed',
    ]);
  });

  it('저장소 장애 · 설정 없음은 503 (앱이 다시 시도를 보인다), 주소는 응답에 넣지 않는다', async () => {
    getProperties.mockRejectedValue(new Error('down'));
    const down = await post({ files: [file('a', photo(1))] }).expect(503);
    expect(JSON.stringify(down.body)).not.toContain(account);
    configured = false;
    const res = await post({ files: [file('a', photo(1))] }).expect(503);
    expect(res.body.code).toBe('UPLOAD_UNAVAILABLE');
  });

  it('저장된 형식이 사진이 아니면(확장자만 사진) not_allowed, 형식 매개변수 · 대소문자는 무시한다', async () => {
    getProperties
      .mockResolvedValueOnce({ contentLength: 10, contentType: 'text/html' } as never)
      .mockResolvedValueOnce({ contentLength: 10, contentType: 'application/pdf' } as never)
      .mockResolvedValueOnce({ contentLength: 10 } as never)
      .mockResolvedValueOnce({ contentLength: 10, contentType: 'Image/HEIC; x=1' } as never);
    const res = await post({
      files: [1, 2, 3, 4].map((n) => file(`f${n}`, photo(n))),
    }).expect(200);
    expect(res.body.data.map((v: { verdict: string }) => v.verdict)).toEqual([
      'not_allowed',
      'not_allowed',
      'not_allowed',
      'ok',
    ]);
  });

  it.each([
    ['이름', [file('a', photo(1)), file('a', photo(2))]],
    ['주소', [file('a', photo(1)), file('b', photo(1))]],
  ])('같은 %s이 두 번이면 400 (노트 등록도 같은 파일을 받지 않는다)', async (_name, files) => {
    const res = await post({ files }).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(getProperties).not.toHaveBeenCalled();
  });

  it('긴 기기 파일 이름 · 크기 생략 · 소수 크기도 받는다(크기는 쓰지 않는다)', async () => {
    const res = await post({
      files: [
        { name: `0-${'가'.repeat(300)}.jpg`, uri: photo(1) },
        { name: 'b', sizeBytes: 12.5, uri: photo(2) },
      ],
    }).expect(200);
    expect(res.body.data.map((v: { verdict: string }) => v.verdict)).toEqual(['ok', 'ok']);
  });

  it.each([
    ['본문 없음', {}],
    ['51장', { files: Array.from({ length: 51 }, (_, i) => file(`f${i}`, photo(i))) }],
    ['이름 없음', { files: [{ sizeBytes: 0, uri: photo(1) }] }],
    ['빈 이름', { files: [file('', photo(1))] }],
    ['1025자 이름', { files: [file('a'.repeat(1025), photo(1))] }],
    ['주소가 글자가 아님', { files: [{ name: 'a', sizeBytes: 0, uri: 1 }] }],
    ['음수 크기', { files: [{ name: 'a', sizeBytes: -1, uri: photo(1) }] }],
    ['모르는 필드', { files: [{ ...file('a', photo(1)), extra: 1 }] }],
    ['목록이 아님', { files: file('a', photo(1)) }],
    ['원소가 배열', { files: [[]] }],
    ['원소가 숫자', { files: [1] }],
    ['원소가 null', { files: [null] }],
  ])('400: %s', async (_name, body) => {
    await post(body).expect(400);
    expect(getProperties).not.toHaveBeenCalled();
  });

  it('빈 목록(앱이 기기 검사에서 모두 걸렀을 때)은 빈 결과, 저장소를 부르지 않는다', async () => {
    const res = await post({ files: [] }).expect(200);
    expect(res.body).toEqual({ data: [] });
    expect(getProperties).not.toHaveBeenCalled();
  });

  it('모두 사진이 아닌 확장자면 저장소 설정이 없어도 not_allowed 로 답한다(503 아님)', async () => {
    configured = false;
    const res = await post({ files: [file('a', photo(1, 'pdf'))] }).expect(200);
    expect(res.body.data).toEqual([{ name: 'a', verdict: 'not_allowed' }]);
  });

  it('50장까지는 받는다', async () => {
    const res = await post({
      files: Array.from({ length: 50 }, (_, i) => file(`f${i}`, photo(i))),
    }).expect(200);
    expect(res.body.data).toHaveLength(50);
  });
});
