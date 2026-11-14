// 진짜 Azure Blob에서 발급한 주소의 권한을 보는 테스트.
// AZURE_STORAGE_VERIFY_CONNECTION_STRING이 있을 때만 돌고(없으면 건너뜀), 올린 시험 파일은 끝나면 지운다.
// 실행: $env:AZURE_STORAGE_VERIFY_CONNECTION_STRING = "<개발 스토리지 연결 문자열>"; npm run test -w @notelink/api -- test/upload-real-storage.test.ts
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import type { UploadTarget } from '@notelink/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStorageConfig, type StorageConfig } from '../src/config/storage.config.js';
import type { UploadQuotaService } from '../src/modules/upload/upload-quota.service.js';
import { BlobStorageService, UPLOAD_PREFIX } from '../src/modules/upload/blob-storage.service.js';
import { UploadsService } from '../src/modules/upload/uploads.service.js';

const connection = process.env.AZURE_STORAGE_VERIFY_CONNECTION_STRING;
const USER = '000000000000000000000000';
const OTHER = '111111111111111111111111';

describe.skipIf(!connection)('진짜 저장소에서 올리기 주소 권한 확인', () => {
  let storage: StorageConfig;
  let target: UploadTarget;
  const body = new Uint8Array(300);
  const status = (p: Promise<Response>) => p.then((r) => r.status);
  const put = (url: string) => status(fetch(url, { method: 'PUT', headers: target.headers, body }));
  const blobName = () => target.blobUrl.split(`/${storage.container}/`)[1]!;
  const blob = () =>
    new BlobServiceClient(
      storage.blobEndpoint,
      new StorageSharedKeyCredential(storage.accountName, storage.accountKey),
    )
      .getContainerClient(storage.container)
      .getBlobClient(blobName());

  beforeAll(async () => {
    storage = createStorageConfig({
      get: (key) => (key === 'AZURE_STORAGE_CONNECTION_STRING' ? connection : undefined),
    })!;
    const quota = { reserve: () => Promise.resolve({ ok: true }) } as unknown as UploadQuotaService;
    target = await new UploadsService(new BlobStorageService(storage), quota).createTarget(USER, {
      kind: 'image',
      fileName: 'verify.png',
      contentType: 'image/png',
      sizeBytes: body.length,
    });
  });

  afterAll(async () => {
    await blob().deleteIfExists();
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
    expect(await put(target.uploadUrl.replace(`/${UPLOAD_PREFIX}/`, '/materials/'))).toBe(403);
  });

  it('서버는 올라간 파일을 지울 수 있다', async () => {
    await blob().deleteIfExists();
    expect(await blob().exists()).toBe(false);
  });
});

describe.skipIf(!connection)('진짜 저장소에서 신고 사진 확인 · 보관', () => {
  let blobs: BlobStorageService;
  let container: ReturnType<BlobServiceClient['getContainerClient']>;
  let target: UploadTarget;
  let kept: string[] = [];
  const body = new Uint8Array(500);
  const nameOf = (url: string) =>
    decodeURIComponent(new URL(url).pathname).split('/').slice(2).join('/');

  beforeAll(async () => {
    const storage = createStorageConfig({
      get: (key) => (key === 'AZURE_STORAGE_CONNECTION_STRING' ? connection : undefined),
    })!;
    blobs = new BlobStorageService(storage);
    container = new BlobServiceClient(
      storage.blobEndpoint,
      new StorageSharedKeyCredential(storage.accountName, storage.accountKey),
    ).getContainerClient(storage.container);
    const quota = { reserve: () => Promise.resolve({ ok: true }) } as unknown as UploadQuotaService;
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

  afterAll(async () => {
    for (const url of [target.blobUrl, ...kept])
      await container.getBlobClient(nameOf(url)).deleteIfExists();
  });

  it('올린 사진을 확인해 reports/로 복사하고, 크기 · 형식이 그대로다', async () => {
    kept = await blobs.keepReportImages(USER, [target.blobUrl]);
    expect(kept).toHaveLength(1);
    expect(nameOf(kept[0]!)).toMatch(new RegExp(`^reports/${USER}/[0-9a-f-]{36}\\.jpg$`));
    const props = await container.getBlobClient(nameOf(kept[0]!)).getProperties();
    expect(props.contentLength).toBe(body.length);
    expect(props.contentType).toBe('image/jpeg');
  });

  it('저장하지 못한 신고의 복사본은 지운다', async () => {
    const [copy] = await blobs.keepReportImages(USER, [target.blobUrl]);
    await blobs.discardReportImages([copy!]);
    expect(await container.getBlobClient(nameOf(copy!)).exists()).toBe(false);
  });

  it('남이 올린 사진은 받지 않는다', async () => {
    await expect(blobs.keepReportImages(OTHER, [target.blobUrl])).rejects.toThrow();
  });
});
