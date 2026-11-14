import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ERROR_CODES, PATHS, UPLOAD_RULES, UploadTarget } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { UploadQuota } from '../src/modules/upload/schemas/upload-quota.schema.js';
import {
  UPLOAD_ISSUE_LIMIT,
  UPLOAD_ISSUE_WINDOW_MS,
} from '../src/modules/upload/upload-quota.service.js';
import { UPLOAD_PREFIX } from '../src/modules/upload/blob-storage.service.js';
import { UPLOAD_SAS_MINUTES } from '../src/modules/upload/uploads.service.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';
import { createFakeUploadQuotas } from './support/fake-upload-quotas.js';

const api = (path: string) => `/api/v1${path}`;
const KEY = 'ZmFrZS1zdG9yYWdlLWtleS1mb3ItdGVzdHM=';
const CONNECTION = `DefaultEndpointsProtocol=https;AccountName=notelinktest;AccountKey=${KEY};EndpointSuffix=core.windows.net`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

async function startApp(env: Record<string, string>) {
  stubAppEnv(env);
  const quotas = createFakeUploadQuotas();
  const ref = await createAppModuleBuilder()
    .overrideProvider(getModelToken(RefreshToken.name))
    .useValue(createFakeRefreshTokens().model)
    .overrideProvider(getModelToken(UploadQuota.name))
    .useValue(quotas.model)
    .compile();
  const app = ref.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, tokens: ref.get(TokenService), quotas };
}

const image = { kind: 'image', fileName: 'note.jpg', contentType: 'image/jpeg', sizeBytes: 1024 };

describe('파일 올리기 주소 발급 (POST /api/v1/uploads/sas)', () => {
  let app: INestApplication;
  let started: Awaited<ReturnType<typeof startApp>>;
  const me = new Types.ObjectId().toHexString();
  let token: string;

  beforeAll(async () => {
    started = await startApp({ AZURE_STORAGE_CONNECTION_STRING: CONNECTION });
    app = started.app;
    token = (await started.tokens.issue(me)).accessToken;
  });

  beforeEach(() => {
    started.quotas.rows.length = 0;
    started.quotas.raceOnce(false);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  const sas = (body: unknown) =>
    request(app.getHttpServer())
      .post(api(PATHS.uploadSas))
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  it('로그인하지 않으면 401', async () => {
    await request(app.getHttpServer()).post(api(PATHS.uploadSas)).send(image).expect(401);
  });

  it('공용 UploadTarget 모양으로 돌려주고, 경로는 임시 경로의 내 폴더 아래 새 이름이다', async () => {
    const res = await sas(image).expect(200);
    const target = UploadTarget.parse(res.body.data);
    expect(target.blobUrl).toMatch(
      new RegExp(
        `^https://notelinktest\\.blob\\.core\\.windows\\.net/raw/${UPLOAD_PREFIX}/${me}/${UUID}\\.jpg$`,
      ),
    );
    expect(target.uploadUrl.startsWith(`${target.blobUrl}?`)).toBe(true);
    expect(target.headers).toEqual({ 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'image/jpeg' });
  });

  it('주소는 만들기 전용(덮어쓰기 · lease 불가) · https 전용 · 15분짜리 Blob 하나의 SAS다', async () => {
    const before = Date.now();
    const res = await sas(image).expect(200);
    const target = UploadTarget.parse(res.body.data);
    const query = new URL(target.uploadUrl).searchParams;
    expect(query.get('sp')).toBe('c');
    expect(query.get('spr')).toBe('https');
    expect(query.get('sr')).toBe('b');
    expect(query.get('sig')).toBeTruthy();
    expect(query.get('st')).toBeNull();
    const expires = new Date(target.expiresAt).getTime();
    const limit = UPLOAD_SAS_MINUTES * 60_000;
    expect(expires).toBeGreaterThanOrEqual(before + limit);
    expect(expires).toBeLessThanOrEqual(Date.now() + limit);
    // SAS의 만료(초 단위)와 응답의 만료가 같은 시각이다
    expect(Math.abs(new Date(query.get('se')!).getTime() - expires)).toBeLessThan(1000);
  });

  it('부를 때마다 다른 이름을 준다', async () => {
    const a = (await sas(image).expect(200)).body.data.blobUrl;
    const b = (await sas(image).expect(200)).body.data.blobUrl;
    expect(a).not.toBe(b);
  });

  it('확장자는 대소문자를 가리지 않고, 마지막 점 뒤만 본다', async () => {
    const res = await sas({ ...image, fileName: '필기 1.final.PNG', contentType: 'image/png' });
    expect(res.status).toBe(200);
    expect(res.body.data.blobUrl).toMatch(/\.png$/);
  });

  it.each([
    ['image', 'a.heic', 'image/heif', 'image/heic'],
    ['audio', 'a.wav', 'audio/x-wav', 'audio/wav'],
    ['audio', 'a.m4a', '', 'audio/mp4'],
    ['document', 'a.pdf', 'application/octet-stream', 'application/pdf'],
    ['document', 'a.jpg', 'IMAGE/JPEG', 'image/jpeg'],
  ])(
    '%s %s: 형식 %j 가 허용 목록에 없으면 거절하지 않고 확장자의 표준 형식을 쓴다',
    async (kind, fileName, contentType, expected) => {
      const res = await sas({ kind, fileName, contentType, sizeBytes: 10 }).expect(200);
      expect(res.body.data.headers['Content-Type']).toBe(expected);
    },
  );

  it.each([
    ['image', 'a.pdf'],
    ['image', 'a.gif'],
    ['document', 'a.heic'],
    ['audio', 'a.mp4'],
    ['image', 'noext'],
    ['image', 'a.jpg.exe'],
    ['image', 'jpg'],
  ])('%s 에 %s 는 FILE_NOT_ALLOWED', async (kind, fileName) => {
    const res = await sas({ kind, fileName, contentType: 'image/jpeg', sizeBytes: 10 }).expect(400);
    expect(res.body.code).toBe(ERROR_CODES.FILE_NOT_ALLOWED);
  });

  it('크기는 종류별 상한까지 받고, 넘으면 FILE_NOT_ALLOWED', async () => {
    const max = UPLOAD_RULES.image.maxBytes;
    await sas({ ...image, sizeBytes: max }).expect(200);
    const res = await sas({ ...image, sizeBytes: max + 1 }).expect(400);
    expect(res.body.code).toBe(ERROR_CODES.FILE_NOT_ALLOWED);
    expect(res.body.message).toContain('20MB');
  });

  it.each([
    ['본문 없음', undefined],
    ['모르는 종류', { ...image, kind: 'video' }],
    ['이름 없음', { ...image, fileName: '  ' }],
    ['이름이 너무 김', { ...image, fileName: `${'a'.repeat(252)}.jpg` }],
    ['형식 빠짐', { kind: 'image', fileName: 'a.jpg', sizeBytes: 10 }],
    ['크기 0', { ...image, sizeBytes: 0 }],
    ['크기 음수', { ...image, sizeBytes: -1 }],
    ['크기 소수', { ...image, sizeBytes: 1.5 }],
    ['크기 글자', { ...image, sizeBytes: '10' }],
  ])('%s 이면 VALIDATION_FAILED', async (_name, body) => {
    const res = await sas(body).expect(400);
    expect(res.body.code).toBe(ERROR_CODES.VALIDATION);
  });

  describe('발급 횟수 제한', () => {
    /** 이번 구간에 이미 n개를 받은 것으로 둔다 */
    const used = (n: number, userId = me) => {
      const start = Math.floor(Date.now() / UPLOAD_ISSUE_WINDOW_MS) * UPLOAD_ISSUE_WINDOW_MS;
      started.quotas.rows.push({
        ownerId: new Types.ObjectId(userId),
        windowStart: new Date(start),
        count: n,
        expiresAt: new Date(start + UPLOAD_ISSUE_WINDOW_MS),
      });
    };

    it(`한 구간에 ${UPLOAD_ISSUE_LIMIT}개까지 받고, 넘으면 429 RATE_LIMITED와 남은 시간을 준다`, async () => {
      used(UPLOAD_ISSUE_LIMIT - 1);
      await sas(image).expect(200);
      const res = await sas(image).expect(429);
      expect(res.body.code).toBe(ERROR_CODES.RATE_LIMITED);
      expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
      expect(res.body.retryAfterSeconds).toBeLessThanOrEqual(UPLOAD_ISSUE_WINDOW_MS / 1000);
      expect(started.quotas.rows[0]!.count).toBe(UPLOAD_ISSUE_LIMIT);
    });

    it('동시에 요청해도 한도를 넘겨 내주지 않는다', async () => {
      used(UPLOAD_ISSUE_LIMIT - 5);
      const codes = await Promise.all(
        Array.from({ length: 20 }, () => sas(image).then((r) => r.status)),
      );
      expect(codes.filter((c) => c === 200)).toHaveLength(5);
      expect(codes.filter((c) => c === 429)).toHaveLength(15);
      expect(started.quotas.rows[0]!.count).toBe(UPLOAD_ISSUE_LIMIT);
    });

    it('구간의 첫 요청이 겹쳐 만들기가 부딪혀도 받는다', async () => {
      started.quotas.raceOnce(true);
      await sas(image).expect(200);
      expect(started.quotas.rows).toHaveLength(1);
      expect(started.quotas.rows[0]!.count).toBe(1);
    });

    it('다른 사용자 · 지난 구간의 횟수는 세지 않는다', async () => {
      used(UPLOAD_ISSUE_LIMIT, new Types.ObjectId().toHexString());
      started.quotas.rows.push({
        ownerId: new Types.ObjectId(me),
        windowStart: new Date(Date.now() - 2 * UPLOAD_ISSUE_WINDOW_MS),
        count: UPLOAD_ISSUE_LIMIT,
        expiresAt: new Date(Date.now() - UPLOAD_ISSUE_WINDOW_MS),
      });
      await sas(image).expect(200);
    });

    it('거절한 요청은 횟수를 쓰지 않는다', async () => {
      await sas({ ...image, fileName: 'a.gif' }).expect(400);
      await sas({ ...image, sizeBytes: 0 }).expect(400);
      expect(started.quotas.rows).toHaveLength(0);
    });
  });

  it('응답 · 오류 어디에도 스토리지 키가 없다', async () => {
    const ok = await sas(image).expect(200);
    const bad = await sas({ ...image, fileName: 'a.gif' }).expect(400);
    expect(JSON.stringify(ok.body)).not.toContain(KEY);
    expect(JSON.stringify(bad.body)).not.toContain(KEY);
  });

  describe('신고 사진 (purpose: report)', () => {
    const report = { ...image, purpose: 'report' };

    it('다른 파일처럼 임시 경로의 내 폴더에 올린다(접수 때 보관 경로로 복사)', async () => {
      const res = await sas(report).expect(200);
      expect(UploadTarget.parse(res.body.data).blobUrl).toMatch(
        new RegExp(`/raw/${UPLOAD_PREFIX}/${me}/${UUID}\\.jpg$`),
      );
    });

    it.each([
      ['문서', { kind: 'document', fileName: 'a.pdf', contentType: 'application/pdf' }],
      ['녹음', { kind: 'audio', fileName: 'a.m4a', contentType: 'audio/mp4' }],
      ['확장자와 다른 형식', { fileName: 'a.png', contentType: 'image/jpeg' }],
      ['알 수 없는 형식', { contentType: 'application/octet-stream' }],
    ])('%s은 FILE_NOT_ALLOWED', async (_, over) => {
      const res = await sas({ ...report, ...over }).expect(400);
      expect(res.body.code).toBe(ERROR_CODES.FILE_NOT_ALLOWED);
      expect(started.quotas.rows).toHaveLength(0);
    });

    it('모르는 purpose는 VALIDATION_FAILED', async () => {
      const res = await sas({ ...image, purpose: 'avatar' }).expect(400);
      expect(res.body.code).toBe(ERROR_CODES.VALIDATION);
    });

    it('발급 횟수 제한을 다른 파일과 함께 쓴다', async () => {
      await sas(report).expect(200);
      await sas(image).expect(200);
      expect(started.quotas.rows[0]?.count).toBe(2);
    });
  });
});

describe('파일 저장소가 설정되지 않은 서버', () => {
  let app: INestApplication;
  let token: string;

  beforeAll(async () => {
    const off = await startApp({ AZURE_STORAGE_CONNECTION_STRING: '' });
    app = off.app;
    token = (await off.tokens.issue(new Types.ObjectId().toHexString())).accessToken;
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  const sas = (body: unknown) =>
    request(app.getHttpServer())
      .post(api(PATHS.uploadSas))
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);

  it('서버는 뜨고 올리기 주소만 503 UPLOAD_UNAVAILABLE', async () => {
    await request(app.getHttpServer()).get(api('/health')).expect(200);
    const res = await sas(image).expect(503);
    expect(res.body.code).toBe(ERROR_CODES.UPLOAD_UNAVAILABLE);
  });

  it('올릴 수 없는 파일은 설정이 없어도 400으로 먼저 알린다', async () => {
    const res = await sas({ ...image, fileName: 'a.gif' }).expect(400);
    expect(res.body.code).toBe(ERROR_CODES.FILE_NOT_ALLOWED);
  });
});
