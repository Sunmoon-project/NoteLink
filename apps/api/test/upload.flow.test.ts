import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ERROR_CODES, PATHS, UPLOAD_RULES, UploadTarget } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { BLOB_STORE, type BlobStore } from '../src/modules/upload/blob-store.js';
import { UploadTicket } from '../src/modules/upload/schemas/upload-ticket.schema.js';
import { SETTLE_MS, UploadSweeper } from '../src/modules/upload/upload-sweeper.service.js';
import {
  ISSUE_LIMIT,
  ISSUE_WINDOW_MS,
  UPLOAD_SAS_MINUTES,
} from '../src/modules/upload/upload.service.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';
import { createFakeUploadTickets } from './support/fake-upload-tickets.js';

const api = (path: string) => `/api/v1${path}`;
const KEY = 'ZmFrZS1zdG9yYWdlLWtleS1mb3ItdGVzdHM=';
const CONNECTION = `DefaultEndpointsProtocol=https;AccountName=notelinktest;AccountKey=${KEY};EndpointSuffix=core.windows.net`;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** 이름 → 크기만 가진 저장소(실제 Azure를 부르지 않는다) */
function fakeBlobs() {
  const sizes = new Map<string, number>();
  const store: BlobStore = {
    size: (name) => Promise.resolve(sizes.get(name) ?? null),
    remove: (name) => {
      sizes.delete(name);
      return Promise.resolve();
    },
  };
  return { store, sizes };
}

async function startApp(env: Record<string, string>) {
  stubAppEnv(env);
  const tickets = createFakeUploadTickets();
  const blobs = fakeBlobs();
  const ref = await createAppModuleBuilder()
    .overrideProvider(getModelToken(RefreshToken.name))
    .useValue(createFakeRefreshTokens().model)
    .overrideProvider(getModelToken(UploadTicket.name))
    .useValue(tickets.model)
    .overrideProvider(BLOB_STORE)
    .useValue(env.AZURE_STORAGE_CONNECTION_STRING ? blobs.store : null)
    .compile();
  const app = ref.createNestApplication();
  configureApp(app);
  await app.init();
  return { app, tokens: ref.get(TokenService), tickets, blobs, sweeper: ref.get(UploadSweeper) };
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
    started.tickets.rows.length = 0;
    started.tickets.failNextCreates(false);
    started.blobs.sizes.clear();
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

  it('공용 UploadTarget 모양으로 돌려주고, 경로는 내 폴더 아래 새 이름이다', async () => {
    const res = await sas(image).expect(200);
    const target = UploadTarget.parse(res.body.data);
    expect(target.blobUrl).toMatch(
      new RegExp(`^https://notelinktest\\.blob\\.core\\.windows\\.net/raw/${me}/${UUID}\\.jpg$`),
    );
    expect(target.uploadUrl.startsWith(`${target.blobUrl}?`)).toBe(true);
    expect(target.headers).toEqual({ 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'image/jpeg' });
  });

  it('주소는 쓰기 전용 · https 전용 · 15분짜리 Blob 하나의 SAS다', async () => {
    const before = Date.now();
    const res = await sas(image).expect(200);
    const target = UploadTarget.parse(res.body.data);
    const query = new URL(target.uploadUrl).searchParams;
    expect(query.get('sp')).toBe('cw');
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

  it('내준 주소를 기록한다 (주인 · Blob 이름 · 종류의 크기 상한 · 만료)', async () => {
    const res = await sas({ ...image, sizeBytes: 1 }).expect(200);
    const target = UploadTarget.parse(res.body.data);
    expect(started.tickets.rows).toHaveLength(1);
    const row = started.tickets.rows[0]!;
    expect(String(row.ownerId)).toBe(me);
    expect(target.blobUrl.endsWith(`/raw/${row.blobName}`)).toBe(true);
    // 앱이 알린 크기가 아니라 종류의 상한을 기준으로 둔다
    expect(row.maxBytes).toBe(UPLOAD_RULES.image.maxBytes);
    expect(row.expiresAt.toISOString()).toBe(target.expiresAt);
    expect(row.status).toBe('issued');
  });

  it('거절한 요청은 기록하지 않는다', async () => {
    await sas({ ...image, fileName: 'a.gif' }).expect(400);
    await sas({ ...image, sizeBytes: 0 }).expect(400);
    expect(started.tickets.rows).toHaveLength(0);
  });

  it('기록을 남기지 못하면 주소를 내주지 않는다', async () => {
    started.tickets.failNextCreates(true);
    const res = await sas(image).expect(500);
    expect(JSON.stringify(res.body)).not.toContain('sig=');
  });

  it('1로 알리고 상한을 넘겨 올린 파일은 주소가 만료된 뒤 확인해 지운다', async () => {
    await sas({ ...image, sizeBytes: 1 }).expect(200);
    const row = started.tickets.rows[0]!;
    started.blobs.sizes.set(row.blobName, UPLOAD_RULES.image.maxBytes + 1);

    const result = await started.sweeper.sweep(new Date(row.expiresAt.getTime() + SETTLE_MS));

    expect(result.oversize).toBe(1);
    expect(started.blobs.sizes.size).toBe(0);
    expect(started.tickets.rows).toHaveLength(0);
  });

  it(`한 사용자가 ${ISSUE_LIMIT}개를 넘게 받으면 429 RATE_LIMITED, 다른 사용자 · 시간이 지난 뒤는 받는다`, async () => {
    const mine = new Types.ObjectId(me);
    const recent = new Date(Date.now() - ISSUE_WINDOW_MS + 60_000);
    const fill = (createdAt: Date) => {
      for (let i = 0; i < ISSUE_LIMIT - 1; i += 1)
        started.tickets.rows.push({
          _id: new Types.ObjectId(),
          ownerId: mine,
          blobName: `${me}/${i}.jpg`,
          maxBytes: 1,
          status: 'issued',
          expiresAt: createdAt,
          checkedAt: null,
          createdAt,
        });
    };
    fill(recent);
    await sas(image).expect(200); // 100번째
    const res = await sas(image).expect(429);
    expect(res.body.code).toBe(ERROR_CODES.RATE_LIMITED);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(started.tickets.rows).toHaveLength(ISSUE_LIMIT);

    const other = (await started.tokens.issue(new Types.ObjectId().toHexString())).accessToken;
    await request(app.getHttpServer())
      .post(api(PATHS.uploadSas))
      .set('Authorization', `Bearer ${other}`)
      .send(image)
      .expect(200);

    // 구간이 지난 기록은 세지 않는다
    started.tickets.rows.length = 0;
    fill(new Date(Date.now() - ISSUE_WINDOW_MS - 60_000));
    started.tickets.rows.push({ ...started.tickets.rows[0]!, _id: new Types.ObjectId() });
    await sas(image).expect(200);
  });

  it('응답 · 오류 어디에도 스토리지 키가 없다', async () => {
    const ok = await sas(image).expect(200);
    const bad = await sas({ ...image, fileName: 'a.gif' }).expect(400);
    expect(JSON.stringify(ok.body)).not.toContain(KEY);
    expect(JSON.stringify(bad.body)).not.toContain(KEY);
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
