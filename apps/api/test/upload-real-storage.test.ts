// 진짜 Azure Blob에서 발급한 주소의 권한을 보는 테스트.
// AZURE_STORAGE_VERIFY_CONNECTION_STRING이 있을 때만 돈다(없으면 건너뜀).
// 이번 실행에서만 쓰는 컨테이너를 만들어 그 안에서만 올리고 지우며, 끝나면 컨테이너째 지운다(다른 파일은 건드리지 않음).
// 실행: $env:AZURE_STORAGE_VERIFY_CONNECTION_STRING = "<개발 스토리지 연결 문자열>"; npm run test -w @notelink/api -- test/upload-real-storage.test.ts
import { randomUUID } from 'node:crypto';

import {
  BlobServiceClient,
  type ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import type { UploadTarget } from '@notelink/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStorageConfig, type StorageConfig } from '../src/config/storage.config.js';
import type { UploadQuotaService } from '../src/modules/upload/upload-quota.service.js';
import {
  BlobStorageService,
  REPORT_PENDING_GRACE_MS,
  REPORT_PENDING_TAG,
  REPORT_SCOPE_TAG,
  UPLOAD_PREFIX,
} from '../src/modules/upload/blob-storage.service.js';
import { UploadsService } from '../src/modules/upload/uploads.service.js';

const connection = process.env.AZURE_STORAGE_VERIFY_CONNECTION_STRING;
const CONTAINER = `verify-${randomUUID()}`;
const USER = '000000000000000000000000';
const OTHER = '111111111111111111111111';
const REPORT = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_REPORT = '64b7f0c2a1b2c3d4e5f60719';
const SCOPE = randomUUID();
const OTHER_SCOPE = randomUUID();

describe.skipIf(!connection)('진짜 저장소 확인(실행마다 전용 컨테이너)', () => {
  let storage: StorageConfig;
  let container: ContainerClient;
  const quota = { reserve: () => Promise.resolve({ ok: true }) } as unknown as UploadQuotaService;

  beforeAll(async () => {
    storage = createStorageConfig({
      get: (key) =>
        key === 'AZURE_STORAGE_CONNECTION_STRING'
          ? connection
          : key === 'AZURE_BLOB_CONTAINER'
            ? CONTAINER
            : undefined,
    })!;
    expect(storage.container).toBe(CONTAINER);
    container = new BlobServiceClient(
      storage.blobEndpoint,
      new StorageSharedKeyCredential(storage.accountName, storage.accountKey),
    ).getContainerClient(CONTAINER);
    await container.create();
  });

  afterAll(async () => {
    await container?.deleteIfExists();
  });

  describe('올리기 주소 권한', () => {
    let target: UploadTarget;
    const body = new Uint8Array(300);
    const status = (p: Promise<Response>) => p.then((r) => r.status);
    const put = (url: string) =>
      status(fetch(url, { method: 'PUT', headers: target.headers, body }));
    const blob = () => container.getBlobClient(target.blobUrl.split(`/${CONTAINER}/`)[1]!);

    beforeAll(async () => {
      target = await new UploadsService(new BlobStorageService(storage), quota).createTarget(USER, {
        kind: 'image',
        fileName: 'verify.png',
        contentType: 'image/png',
        sizeBytes: body.length,
      });
    });

    it('받은 주소 · 헤더로 처음 올리면 저장된다', async () => {
      expect(await put(target.uploadUrl)).toBe(201);
      const props = await blob().getProperties();
      expect(props.contentLength).toBe(body.length);
      expect(props.contentType).toBe('image/png');
    });

    it('같은 주소로 덮어쓰지 못한다', async () => {
      expect(await put(target.uploadUrl)).toBe(403);
    });

    it('lease(지우지 못하게 잠그기)를 걸지 못한다', async () => {
      const res = fetch(`${target.uploadUrl}&comp=lease`, {
        method: 'PUT',
        headers: {
          'x-ms-lease-action': 'acquire',
          'x-ms-lease-duration': '-1',
          'x-ms-version': '2021-08-06',
        },
      });
      expect(await status(res)).toBe(403);
    });

    it('읽거나 지우지 못한다', async () => {
      expect(await status(fetch(target.uploadUrl))).toBe(403);
      expect(await status(fetch(target.uploadUrl, { method: 'DELETE' }))).toBe(403);
    });

    it('다른 사용자 경로 · 임시 경로 밖에는 올리지 못한다', async () => {
      expect(await put(target.uploadUrl.replace(USER, OTHER))).toBe(403);
      expect(target.blobUrl).toContain(`/${CONTAINER}/${UPLOAD_PREFIX}/image/${USER}/`);
      expect(await put(target.uploadUrl.replace(`/${UPLOAD_PREFIX}/`, '/materials/'))).toBe(403);
    });

    it('서버는 올라간 파일을 지울 수 있다', async () => {
      await blob().deleteIfExists();
      expect(await blob().exists()).toBe(false);
    });
  });

  describe('신고 사진 확인 · 보관 · 정리', () => {
    let blobs: BlobStorageService;
    let target: UploadTarget;
    let kept: string[] = [];
    const body = new Uint8Array(500);
    const nameOf = (url: string) =>
      decodeURIComponent(new URL(url).pathname).split('/').slice(2).join('/');
    const tagsOf = async (url: string) =>
      (await container.getBlockBlobClient(nameOf(url)).getTags()).tags;
    const existsBlob = (url: string) => container.getBlobClient(nameOf(url)).exists();

    beforeAll(async () => {
      blobs = new BlobStorageService(storage);
      target = await new UploadsService(blobs, quota).createTarget(USER, {
        kind: 'image',
        purpose: 'report',
        fileName: 'report.jpg',
        contentType: 'image/jpeg',
        sizeBytes: body.length,
      });
      const res = await fetch(target.uploadUrl, { method: 'PUT', headers: target.headers, body });
      expect(res.status).toBe(201);
    });

    it('올린 사진을 확인해 그 신고 아래로 대기 · DB 구분 태그를 달아 복사하고, 크기 · 형식이 그대로다', async () => {
      kept = await blobs.keepReportImages(USER, [target.blobUrl], REPORT, SCOPE);
      expect(kept).toHaveLength(1);
      expect(nameOf(kept[0]!)).toMatch(
        new RegExp(`^reports/${USER}/${REPORT}/[0-9a-f-]{36}\\.jpg$`),
      );
      const props = await container.getBlobClient(nameOf(kept[0]!)).getProperties();
      expect(props.contentLength).toBe(body.length);
      expect(props.contentType).toBe('image/jpeg');
      const tags = await tagsOf(kept[0]!);
      expect(Object.keys(tags).sort()).toEqual([REPORT_PENDING_TAG, REPORT_SCOPE_TAG].sort());
      expect(tags[REPORT_SCOPE_TAG]).toBe(SCOPE);
    });

    it('신고를 저장한 뒤 대기 표시를 뗀다', async () => {
      await blobs.confirmReportImages(kept);
      expect(await tagsOf(kept[0]!)).toEqual({});
    });

    it('오래된 대기 복사본: 이 DB 것만 신고가 있으면 태그를 떼고 없으면 지우며, 다른 DB 것은 그대로 둔다', async () => {
      const saved = (await blobs.keepReportImages(USER, [target.blobUrl], REPORT, SCOPE))[0]!;
      const lost = (await blobs.keepReportImages(USER, [target.blobUrl], OTHER_REPORT, SCOPE))[0]!;
      // 다른 DB가 만든 복사본(이 DB에는 그 신고가 없음)
      const foreign = (
        await blobs.keepReportImages(USER, [target.blobUrl], OTHER_REPORT, OTHER_SCOPE)
      )[0]!;
      // 대기 시간이 지난 것처럼 만든 시각을 앞당김
      const old = String(Date.now() - 2 * REPORT_PENDING_GRACE_MS).padStart(15, '0');
      const backdate = (url: string, scope: string) =>
        container
          .getBlockBlobClient(nameOf(url))
          .setTags({ [REPORT_PENDING_TAG]: old, [REPORT_SCOPE_TAG]: scope });
      await backdate(saved, SCOPE);
      await backdate(lost, SCOPE);
      await backdate(foreign, OTHER_SCOPE);

      // 태그 색인은 몇 초 늦게 반영될 수 있어 둘 다 처리될 때까지 다시 부름
      const exists = async (id: string) => id === REPORT;
      let done = { kept: 0, deleted: 0 };
      for (let i = 0; i < 30 && (done.kept < 1 || done.deleted < 1); i += 1) {
        const c = await blobs.sweepReportImages(new Date(), SCOPE, exists);
        done = { kept: done.kept + c.kept, deleted: done.deleted + c.deleted };
        if (done.kept < 1 || done.deleted < 1) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(done).toEqual({ kept: 1, deleted: 1 });
      expect(await tagsOf(saved)).toEqual({});
      expect(await existsBlob(lost)).toBe(false);
      // 다른 DB 것도 색인에 잡히는지 본 다음(그 DB 구분값으로는 찾아짐), 이 DB의 정리로는 남았는지 확인
      const foreignQuery = `"${REPORT_SCOPE_TAG}" = '${OTHER_SCOPE}'`;
      let indexed = false;
      for (let i = 0; i < 30 && !indexed; i += 1) {
        for await (const found of container.findBlobsByTags(foreignQuery))
          indexed ||= found.name === nameOf(foreign);
        if (!indexed) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(indexed).toBe(true);
      expect(await blobs.sweepReportImages(new Date(), SCOPE, exists)).toEqual({
        kept: 0,
        deleted: 0,
        failed: 0,
      });
      expect(await existsBlob(foreign)).toBe(true);
      expect((await tagsOf(foreign))[REPORT_SCOPE_TAG]).toBe(OTHER_SCOPE);
    }, 90_000);

    it('찾은 뒤 태그가 바뀐 복사본은 조건에 걸려 지워지지 않는다', async () => {
      const url = (await blobs.keepReportImages(USER, [target.blobUrl], OTHER_REPORT, SCOPE))[0]!;
      const client = container.getBlockBlobClient(nameOf(url));
      const old = String(Date.now() - 2 * REPORT_PENDING_GRACE_MS).padStart(15, '0');
      const stale = `"${REPORT_SCOPE_TAG}" = '${SCOPE}' AND "${REPORT_PENDING_TAG}" < '${old}'`;
      await expect(
        client.deleteIfExists({ conditions: { tagConditions: stale } }),
      ).rejects.toMatchObject({ statusCode: 412 });
      expect(await client.exists()).toBe(true);
    });

    it('남이 올린 사진은 받지 않는다', async () => {
      await expect(
        blobs.keepReportImages(OTHER, [target.blobUrl], REPORT, SCOPE),
      ).rejects.toThrow();
    });
  });
});
