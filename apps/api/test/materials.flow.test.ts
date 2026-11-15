import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { PATHS } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { MaterialsService } from '../src/modules/content/materials/materials.service.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

const api = (path: string) => `/api/v1${path}`;
const me = new Types.ObjectId();
const folderId = new Types.ObjectId().toHexString();
const body = {
  folderId,
  kind: 'handwriting',
  source: 'camera',
  title: '  필기  ',
  blobUrls: ['https://x.blob.core.windows.net/c/uploads/image/u/a.jpg'],
};

describe('노트 등록 요청 검사 (POST /api/v1/materials)', () => {
  let app: INestApplication;
  let token: string;
  const register = vi.fn();
  const findMine = vi.fn();
  const listInFolder = vi.fn();
  const update = vi.fn();
  const remove = vi.fn();
  const downloadUrl = vi.fn();

  beforeAll(async () => {
    stubAppEnv();
    const ref = await createAppModuleBuilder()
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(createFakeRefreshTokens().model)
      .overrideProvider(MaterialsService)
      .useValue({ register, findMine, listInFolder, update, remove, downloadUrl })
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
    register.mockReset();
    findMine.mockReset();
    register.mockResolvedValue({ material: { _id: 'm' }, job: { _id: 'j' } });
  });

  const post = (payload: unknown, key?: string) => {
    const r = request(app.getHttpServer())
      .post(api(PATHS.materials))
      .set('Authorization', `Bearer ${token}`);
    if (key !== undefined) r.set('Idempotency-Key', key);
    return r.send(payload as object);
  };

  it('로그인하지 않으면 401', async () => {
    await request(app.getHttpServer()).post(api(PATHS.materials)).send(body).expect(401);
    expect(register).not.toHaveBeenCalled();
  });

  it('올바른 본문이면 { data: { material, job } } 로 201, 제목은 앞뒤 공백을 지워 넘긴다', async () => {
    const res = await post(body, 'key-1').expect(201);
    expect(res.body).toEqual({ data: { material: { _id: 'm' }, job: { _id: 'j' } } });
    expect(register).toHaveBeenCalledWith(
      me.toHexString(),
      expect.objectContaining({ title: '필기', kind: 'handwriting', source: 'camera' }),
      'key-1',
    );
  });

  it('Idempotency-Key 는 선택, 128자까지', async () => {
    await post(body).expect(201);
    expect(register.mock.calls[0]![2]).toBeUndefined();
    await post(body, 'k'.repeat(128)).expect(201);
    const res = await post(body, 'k'.repeat(129)).expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(register).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['폴더 id 형식', { ...body, folderId: 'abc' }],
    ['알 수 없는 종류', { ...body, kind: 'video' }],
    ['알 수 없는 출처', { ...body, source: 'drone' }],
    ['빈 제목', { ...body, title: '   ' }],
    ['101자 제목', { ...body, title: 'a'.repeat(101) }],
    ['501자 설명', { ...body, description: 'a'.repeat(501) }],
    ['파일 없음', { ...body, blobUrls: [] }],
    [
      '파일 51개',
      { ...body, blobUrls: Array.from({ length: 51 }, (_, i) => `https://x/${i}.jpg`) },
    ],
    ['주소가 글자가 아님', { ...body, blobUrls: [1] }],
    ['모르는 필드', { ...body, requestId: 'x' }],
    ['아바타 id 형식', { ...body, avatarItemId: 'nope' }],
  ])('400: %s', async (_name, payload) => {
    const res = await post(payload).expect(400);
    expect(res.body).toEqual({ code: 'BAD_REQUEST', message: expect.any(String) });
    expect(register).not.toHaveBeenCalled();
  });

  it('100자 제목 · 500자 설명 · 50개 파일 · 설명 생략은 통과', async () => {
    await post({
      ...body,
      title: 'a'.repeat(100),
      description: 'b'.repeat(500),
      blobUrls: Array.from({ length: 50 }, (_, i) => `https://x/${i}.jpg`),
    }).expect(201);
    await post({ ...body, avatarItemId: null }).expect(201);
  });
  it('GET /materials/:id: 로그인이 필요하고, { data } 로 노트를 돌려준다', async () => {
    findMine.mockResolvedValue({ _id: 'm1' });
    await request(app.getHttpServer())
      .get(api(PATHS.material('m1')))
      .expect(401);
    const res = await request(app.getHttpServer())
      .get(api(PATHS.material('m1')))
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({ data: { _id: 'm1' } });
    expect(findMine).toHaveBeenCalledWith(me.toHexString(), 'm1');
  });
  describe('목록 · 수정 · 삭제 요청', () => {
    const auth = () => ({ Authorization: `Bearer ${token}` });
    const patch = (id: string, payload: unknown) =>
      request(app.getHttpServer())
        .patch(api(PATHS.material(id)))
        .set(auth())
        .send(payload as object);

    it('GET /folders/:id/materials: { data: [...] } 로 돌려준다', async () => {
      listInFolder.mockResolvedValue([{ _id: 'm1' }]);
      await request(app.getHttpServer())
        .get(api(PATHS.folderMaterials('f1')))
        .expect(401);
      const res = await request(app.getHttpServer())
        .get(api(PATHS.folderMaterials('f1')))
        .set(auth())
        .expect(200);
      expect(res.body).toEqual({ data: [{ _id: 'm1' }] });
      expect(listInFolder).toHaveBeenCalledWith(me.toHexString(), 'f1');
    });

    it('PATCH: { saved: true } 와 { summary: { sections } } 를 받는다', async () => {
      update.mockResolvedValue({ _id: 'm1' });
      await patch('m1', { saved: true }).expect(200);
      expect(update).toHaveBeenLastCalledWith(
        me.toHexString(),
        'm1',
        expect.objectContaining({ saved: true }),
      );
      const res = await patch('m1', {
        summary: { sections: [{ heading: '  제목  ', body: '본문' }] },
      }).expect(200);
      expect(res.body).toEqual({ data: { _id: 'm1' } });
      expect(update.mock.lastCall![2].summary.sections).toEqual([
        { heading: '제목', body: '본문' },
      ]);
      await request(app.getHttpServer())
        .patch(api(PATHS.material('m1')))
        .send({ saved: true })
        .expect(401);
    });

    it('PATCH 상한: 섹션 50개 · 제목 100자 · 본문 10000자', async () => {
      update.mockResolvedValue({ _id: 'm1' });
      const section = { heading: 'h', body: 'b' };
      await patch('m1', { summary: { sections: Array(50).fill(section) } }).expect(200);
      await patch('m1', {
        summary: { sections: [{ heading: 'h'.repeat(100), body: 'b'.repeat(10000) }] },
      }).expect(200);
      update.mockClear();
      for (const bad of [
        { summary: { sections: Array(51).fill(section) } },
        { summary: { sections: [{ heading: 'h'.repeat(101), body: 'b' }] } },
        { summary: { sections: [{ heading: 'h', body: 'b'.repeat(10001) }] } },
        { summary: { sections: [{ heading: '   ', body: 'b' }] } },
        { summary: { sections: [{ heading: 'h' }] } },
        { summary: { sections: 'x' } },
        { saved: false },
        { saved: 'yes' },
        { title: '못 바꿈' },
        // summary 가 객체가 아닌 값 · sections 항목이 객체가 아닌 값
        { summary: [] },
        { summary: null },
        { summary: 'x' },
        { summary: 1 },
        { summary: { sections: [1] } },
        { summary: { sections: [null] } },
        { summary: { sections: ['x'] } },
        { summary: { sections: [[]] } },
        { summary: { sections: [{ heading: 'h', body: 'b' }, 1] } },
        { summary: {} },
      ]) {
        const res = await patch('m1', bad).expect(400);
        expect(res.body).toEqual({ code: 'BAD_REQUEST', message: expect.any(String) });
      }
      expect(update).not.toHaveBeenCalled();
    });

    it('GET /materials/:id/download-url: 로그인이 필요하고 { data: { url, fileName } } 로 돌려준다', async () => {
      downloadUrl.mockResolvedValue({ url: 'https://x/y?sp=r', fileName: '필기.jpg' });
      await request(app.getHttpServer())
        .get(api(PATHS.materialDownloadUrl('m1')))
        .expect(401);
      const res = await request(app.getHttpServer())
        .get(api(PATHS.materialDownloadUrl('m1')))
        .set(auth())
        .expect(200);
      expect(res.body).toEqual({ data: { url: 'https://x/y?sp=r', fileName: '필기.jpg' } });
      expect(downloadUrl).toHaveBeenCalledWith(me.toHexString(), 'm1');
      // 상세 조회 경로와 겹치지 않는다
      expect(findMine).not.toHaveBeenCalled();
    });

    it('DELETE /materials/:id: 204, 본문 없음', async () => {
      remove.mockResolvedValue(undefined);
      await request(app.getHttpServer())
        .delete(api(PATHS.material('m1')))
        .expect(401);
      const res = await request(app.getHttpServer())
        .delete(api(PATHS.material('m1')))
        .set(auth())
        .expect(204);
      expect(res.text).toBe('');
      expect(remove).toHaveBeenCalledWith(me.toHexString(), 'm1');
    });
  });
});
