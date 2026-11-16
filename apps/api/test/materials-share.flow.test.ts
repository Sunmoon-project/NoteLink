import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { PATHS } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { MaterialSharingService } from '../src/modules/content/materials/material-sharing.service.js';
import { MaterialsService } from '../src/modules/content/materials/materials.service.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

const api = (path: string) => `/api/v1${path}`;
const me = new Types.ObjectId();
const noteId = new Types.ObjectId().toHexString();
const roomId = new Types.ObjectId().toHexString();

describe('노트 공유 요청 검사 (POST /api/v1/materials/share)', () => {
  let app: INestApplication;
  let token: string;
  const share = vi.fn();

  beforeAll(async () => {
    stubAppEnv();
    const ref = await createAppModuleBuilder()
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(createFakeRefreshTokens().model)
      .overrideProvider(MaterialsService)
      .useValue({})
      .overrideProvider(MaterialSharingService)
      .useValue({ share })
      .compile();
    app = ref.createNestApplication();
    configureApp(app);
    await app.init();
    token = (await ref.get(TokenService).issue(me.toHexString())).accessToken;
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    share.mockReset();
    share.mockResolvedValue(undefined);
  });

  const post = (payload: unknown) =>
    request(app.getHttpServer())
      .post(api(PATHS.materialShare))
      .set('Authorization', `Bearer ${token}`)
      .send(payload as object);
  const ok = { materialIds: [noteId], target: { type: 'room', id: roomId } };

  it('로그인하지 않으면 401', async () => {
    await request(app.getHttpServer()).post(api(PATHS.materialShare)).send(ok).expect(401);
    expect(share).not.toHaveBeenCalled();
  });

  it('올바른 본문이면 204, 본문 없음', async () => {
    const res = await post(ok).expect(204);
    expect(res.text).toBe('');
    expect(share).toHaveBeenCalledWith(
      me.toHexString(),
      expect.objectContaining({ materialIds: [noteId], target: { type: 'room', id: roomId } }),
    );
  });

  it('노트 20개까지, 친구 대상도 형식이 맞으면 서비스로 넘긴다(거절은 서비스가 400 으로)', async () => {
    const twenty = Array.from({ length: 20 }, () => new Types.ObjectId().toHexString());
    await post({ ...ok, materialIds: twenty }).expect(204);
    await post({ ...ok, target: { type: 'friend', id: roomId } }).expect(204);
    expect(share).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['빈 배열', { ...ok, materialIds: [] }],
    [
      '21개',
      { ...ok, materialIds: Array.from({ length: 21 }, () => new Types.ObjectId().toHexString()) },
    ],
    ['노트 id 형식', { ...ok, materialIds: ['abc'] }],
    ['배열이 아님', { ...ok, materialIds: noteId }],
    ['대상 없음', { materialIds: [noteId] }],
    ['알 수 없는 대상 종류', { ...ok, target: { type: 'group', id: roomId } }],
    ['대상 id 형식', { ...ok, target: { type: 'room', id: 'abc' } }],
    ['다른 필드', { ...ok, extra: 1 }],
  ])('%s는 400이고 서비스를 부르지 않는다', async (_name, payload) => {
    await post(payload).expect(400);
    expect(share).not.toHaveBeenCalled();
  });

  it('서비스가 낸 404 · 400 은 { code, message } 로 나간다', async () => {
    const { NotFoundException, BadRequestException } = await import('@nestjs/common');
    share.mockRejectedValueOnce(
      new NotFoundException({ code: 'NOT_FOUND', message: '노트 정보를 찾을 수 없어요' }),
    );
    expect((await post(ok).expect(404)).body).toMatchObject({ code: 'NOT_FOUND' });
    share.mockRejectedValueOnce(
      new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: '친구에게 공유는 아직 지원하지 않아요',
      }),
    );
    expect((await post(ok).expect(400)).body).toMatchObject({
      code: 'VALIDATION_FAILED',
      message: '친구에게 공유는 아직 지원하지 않아요',
    });
  });
});
