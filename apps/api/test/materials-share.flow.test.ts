import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { PATHS } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { FriendShareService } from '../src/modules/content/materials/friend-share.service.js';
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
  const listRoomItems = vi.fn();
  const ownerOfShared = vi.fn();
  const findMine = vi.fn();
  const downloadUrl = vi.fn();
  const friendShares = { open: vi.fn(), revoke: vi.fn(), copy: vi.fn() };

  beforeAll(async () => {
    stubAppEnv();
    const ref = await createAppModuleBuilder()
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(createFakeRefreshTokens().model)
      .overrideProvider(MaterialsService)
      .useValue({ findMine, downloadUrl })
      .overrideProvider(MaterialSharingService)
      .useValue({ share, listRoomItems, ownerOfShared })
      .overrideProvider(FriendShareService)
      .useValue(friendShares)
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
    listRoomItems.mockReset();
    ownerOfShared.mockReset();
    findMine.mockReset();
    downloadUrl.mockReset();
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

  it('노트 20개까지, 친구 대상은 친구 50명까지(ids) 서비스로 넘긴다(#554)', async () => {
    const twenty = Array.from({ length: 20 }, () => new Types.ObjectId().toHexString());
    const fifty = Array.from({ length: 50 }, () => new Types.ObjectId().toHexString());
    await post({ ...ok, materialIds: twenty }).expect(204);
    await post({ ...ok, target: { type: 'friend', ids: fifty } }).expect(204);
    expect(share).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenLastCalledWith(
      me.toHexString(),
      expect.objectContaining({ target: { type: 'friend', ids: fifty } }),
    );
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
    ['친구 대상에 ids 없음', { ...ok, target: { type: 'friend', id: roomId } }],
    ['친구 빈 배열', { ...ok, target: { type: 'friend', ids: [] } }],
    [
      '친구 51명',
      {
        ...ok,
        target: {
          type: 'friend',
          ids: Array.from({ length: 51 }, () => new Types.ObjectId().toHexString()),
        },
      },
    ],
    ['친구 id 형식', { ...ok, target: { type: 'friend', ids: ['abc'] } }],
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
        code: 'NOT_FRIEND',
        message: '친구가 아닌 사용자에게는 노트를 보낼 수 없어요',
      }),
    );
    expect((await post(ok).expect(400)).body).toMatchObject({
      code: 'NOT_FRIEND',
      message: '친구가 아닌 사용자에게는 노트를 보낼 수 없어요',
    });
  });
  describe('공유 자료 조회 (GET /api/v1/study-rooms/:id/shared-items)', () => {
    const get = () => request(app.getHttpServer()).get(api(PATHS.roomShared(roomId)));

    it('로그인하지 않으면 401', async () => {
      await get().expect(401);
      expect(listRoomItems).not.toHaveBeenCalled();
    });

    it('{ data: { items, flashcards } } 로 200', async () => {
      const body = { items: [{ _id: 'i1', title: '노트' }], flashcards: [] };
      listRoomItems.mockResolvedValue(body);
      const res = await get().set('Authorization', `Bearer ${token}`).expect(200);
      expect(res.body).toEqual({ data: body });
      expect(listRoomItems).toHaveBeenCalledWith(me.toHexString(), roomId);
    });

    it('멤버가 아니면(서비스가 낸 404) { code, message } 로 404', async () => {
      const { NotFoundException } = await import('@nestjs/common');
      listRoomItems.mockRejectedValueOnce(
        new NotFoundException({ code: 'NOT_FOUND', message: '스터디룸 정보를 찾을 수 없어요' }),
      );
      const res = await get().set('Authorization', `Bearer ${token}`).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
    });

    it('스터디룸 컨트롤러의 study-rooms/:id 와 겹치지 않는다(두 컨트롤러가 같은 접두어를 쓴다)', async () => {
      listRoomItems.mockResolvedValue({ items: [], flashcards: [] });
      await get().set('Authorization', `Bearer ${token}`).expect(200);
      expect(listRoomItems).toHaveBeenCalledTimes(1);
    });
  });
  describe('공유받은 멤버의 노트 읽기 (GET /materials/:id · download-url)', () => {
    const owner = new Types.ObjectId().toHexString();
    const auth = () => ({ Authorization: `Bearer ${token}` });
    const get = (path: string) => request(app.getHttpServer()).get(api(path)).set(auth());
    const notFound = async () => {
      const { NotFoundException } = await import('@nestjs/common');
      return new NotFoundException({ code: 'NOT_FOUND', message: '노트 정보를 찾을 수 없어요' });
    };

    it('내 노트는 공유 여부를 묻지 않고 그대로 읽는다', async () => {
      findMine.mockResolvedValue({ _id: 'n1' });
      await get(PATHS.material('n1')).expect(200);
      expect(findMine).toHaveBeenCalledTimes(1);
      expect(findMine).toHaveBeenCalledWith(me.toHexString(), 'n1');
      expect(ownerOfShared).not.toHaveBeenCalled();
    });

    it('내 노트가 아니고 공유받은 노트면 주인 id 로 읽는다', async () => {
      findMine.mockRejectedValueOnce(await notFound());
      findMine.mockResolvedValueOnce({ _id: 'n1', title: '남의 노트' });
      ownerOfShared.mockResolvedValue(owner);
      const res = await get(PATHS.material('n1')).expect(200);
      expect(res.body).toEqual({ data: { _id: 'n1', title: '남의 노트' } });
      expect(ownerOfShared).toHaveBeenCalledWith(me.toHexString(), 'n1');
      expect(findMine).toHaveBeenLastCalledWith(owner, 'n1');
    });

    it('공유받지 않은 남의 노트는 처음 404 그대로', async () => {
      findMine.mockRejectedValue(await notFound());
      ownerOfShared.mockResolvedValue(null);
      const res = await get(PATHS.material('n1')).expect(404);
      expect(res.body).toMatchObject({ code: 'NOT_FOUND' });
      expect(findMine).toHaveBeenCalledTimes(1);
    });

    it('원본 주소(download-url)도 같은 방식', async () => {
      downloadUrl.mockRejectedValueOnce(await notFound());
      downloadUrl.mockResolvedValueOnce({ url: 'https://x/y?sp=r', fileName: '노트.jpg' });
      ownerOfShared.mockResolvedValue(owner);
      const res = await get(PATHS.materialDownloadUrl('n1')).expect(200);
      expect(res.body).toEqual({ data: { url: 'https://x/y?sp=r', fileName: '노트.jpg' } });
      expect(downloadUrl).toHaveBeenLastCalledWith(owner, 'n1');
    });

    it('404 가 아닌 오류는 공유를 묻지 않고 그대로 올린다', async () => {
      findMine.mockRejectedValue(new Error('db down'));
      await get(PATHS.material('n1')).expect(500);
      expect(ownerOfShared).not.toHaveBeenCalled();
    });
  });

  describe('친구 공유 주소(#554)', () => {
    const auth = (r: request.Test) => r.set('Authorization', `Bearer ${token}`);
    const shareId = new Types.ObjectId().toHexString();

    it('열기 · 철회 · 복사가 서비스로 간다', async () => {
      friendShares.open.mockResolvedValueOnce({ _id: shareId, active: true });
      const opened = await auth(request(app.getHttpServer()).get(api(PATHS.friendShare(shareId))));
      expect(opened.status).toBe(200);
      expect(opened.body).toEqual({ data: { _id: shareId, active: true } });
      expect(friendShares.open).toHaveBeenCalledWith(me.toHexString(), shareId);

      friendShares.revoke.mockResolvedValueOnce(undefined);
      await auth(request(app.getHttpServer()).delete(api(PATHS.friendShare(shareId)))).expect(204);
      expect(friendShares.revoke).toHaveBeenCalledWith(me.toHexString(), shareId);

      friendShares.copy.mockResolvedValueOnce({ _id: 'n', folderId: 'f' });
      const folderId = new Types.ObjectId().toHexString();
      const copied = await auth(
        request(app.getHttpServer()).post(api(PATHS.friendShareCopy(shareId))),
      ).send({ folderId });
      expect(copied.status).toBe(201);
      expect(copied.body).toEqual({ data: { _id: 'n', folderId: 'f' } });
      expect(friendShares.copy).toHaveBeenCalledWith(me.toHexString(), shareId, folderId);
    });

    it('복사 본문의 폴더 id 형식이 틀리거나 다른 필드면 400', async () => {
      friendShares.copy.mockReset();
      for (const body of [{ folderId: 'abc' }, { extra: 1 }])
        await auth(request(app.getHttpServer()).post(api(PATHS.friendShareCopy(shareId))))
          .send(body)
          .expect(400);
      expect(friendShares.copy).not.toHaveBeenCalled();
    });

    it('로그인하지 않으면 401', async () => {
      await request(app.getHttpServer())
        .get(api(PATHS.friendShare(shareId)))
        .expect(401);
    });
  });
});
