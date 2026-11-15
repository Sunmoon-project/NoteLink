import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BlockBlobClient, ContainerClient } from '@azure/storage-blob';
import { ERROR_CODES } from '@notelink/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StorageConfig } from '../src/config/storage.config.js';
import {
  BlobStorageService,
  REPORT_PENDING_GRACE_MS,
  REPORT_PENDING_TAG,
  REPORT_SWEEP_MAX,
} from '../src/modules/upload/blob-storage.service.js';

const config: StorageConfig = {
  accountName: 'stnotelinkdev01',
  accountKey: Buffer.alloc(32, 1).toString('base64'),
  blobEndpoint: 'https://stnotelinkdev01.blob.core.windows.net',
  container: 'raw',
};
const base = `${config.blobEndpoint}/${config.container}`;
const owner = '507f1f77bcf86cd799439011';
const reportId = '64b7f0c2a1b2c3d4e5f60718';
const otherReport = '64b7f0c2a1b2c3d4e5f60719';
const file = '550e8400-e29b-41d4-a716-446655440000.jpg';
const incoming = `${base}/incoming/${owner}/${file}`;
const service = () => new BlobStorageService(config);
const keep = (urls: string[], svc = service()) => svc.keepReportImages(owner, urls, reportId);
afterEach(() => vi.restoreAllMocks());

function stubBlob(properties: object | Error = { contentLength: 123, contentType: 'image/jpeg' }) {
  const get = vi.spyOn(BlockBlobClient.prototype, 'getProperties');
  if (properties instanceof Error) get.mockRejectedValue(properties);
  else get.mockResolvedValue(properties as never);
  const copy = vi
    .spyOn(BlockBlobClient.prototype, 'syncCopyFromURL')
    .mockResolvedValue({} as never);
  const remove = vi
    .spyOn(BlockBlobClient.prototype, 'deleteIfExists')
    .mockResolvedValue({} as never);
  const tag = vi.spyOn(BlockBlobClient.prototype, 'setTags').mockResolvedValue({} as never);
  return { get, copy, remove, tag };
}
const kept = (url: string) =>
  expect(url).toMatch(new RegExp(`^${base}/reports/${owner}/${reportId}/[0-9a-f-]{36}\\.jpg$`));

describe('신고 사진 확인 · 보관 (BlobStorageService.keepReportImages)', () => {
  it('내 임시 경로의 사진을 확인해 그 신고의 보관 경로로 대기 태그를 달아 복사한다', async () => {
    const { copy } = stubBlob();
    const before = Date.now();
    const [url] = await keep([incoming]);
    kept(url!);
    const stamp = Number(copy.mock.calls[0]![1]?.tags?.[REPORT_PENDING_TAG]);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(Date.now());
    // 원본은 짧은 읽기 전용 SAS로 읽는다
    const source = new URL(copy.mock.calls[0]![0]);
    expect(`${source.origin}${source.pathname}`).toBe(incoming);
    expect(source.searchParams.get('sp')).toBe('r');
    expect(source.searchParams.get('sr')).toBe('b');
  });

  it('사진이 없으면 저장소 설정이 없어도 통과한다', async () => {
    await expect(keep([], new BlobStorageService(null))).resolves.toEqual([]);
  });

  it('사진이 있는데 저장소 설정이 없으면 503 UPLOAD_UNAVAILABLE', async () => {
    await expect(keep([incoming], new BlobStorageService(null))).rejects.toMatchObject({
      response: { code: ERROR_CODES.UPLOAD_UNAVAILABLE },
    });
  });

  it.each([
    ['남의 임시 경로', `${base}/incoming/507f1f77bcf86cd799439012/${file}`],
    ['보관 경로로 바로 올린 사진', `${base}/reports/${owner}/${file}`],
    ['다른 저장소', `https://example.com/raw/incoming/${owner}/${file}`],
    ['다른 이름', `${base}/incoming/${owner}/photo.jpg`],
    ['사진이 아닌 파일', `${base}/incoming/${owner}/${file.replace('.jpg', '.pdf')}`],
    ['더 깊은 경로', `${base}/incoming/${owner}/x/${file}`],
  ])('%s은 저장소를 보기 전에 거부한다', async (_, url) => {
    const { get, copy } = stubBlob();
    await expect(keep([url])).rejects.toBeInstanceOf(BadRequestException);
    expect(get).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it('같은 사진을 두 번 붙이면 거부한다', async () => {
    stubBlob();
    await expect(keep([incoming, incoming])).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['빈 파일', { contentLength: 0, contentType: 'image/jpeg' }],
    ['20MB 초과', { contentLength: 20 * 1024 * 1024 + 1, contentType: 'image/jpeg' }],
    ['확장자와 다른 형식', { contentLength: 123, contentType: 'image/png' }],
  ])('실제 파일이 %s이면 복사하지 않고 거부한다', async (_, properties) => {
    const { copy } = stubBlob(properties);
    await expect(keep([incoming])).rejects.toBeInstanceOf(BadRequestException);
    expect(copy).not.toHaveBeenCalled();
  });

  it('올리지 않은 사진은 400, 저장소 장애는 503', async () => {
    stubBlob(Object.assign(new Error('없음'), { statusCode: 404 }));
    await expect(keep([incoming])).rejects.toBeInstanceOf(BadRequestException);
    vi.restoreAllMocks();
    stubBlob(new Error('장애'));
    await expect(keep([incoming])).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('복사본은 부를 때마다 새 이름이라 다른 신고와 공유하지 않는다', async () => {
    stubBlob();
    const [first] = await keep([incoming]);
    const [second] = await keep([incoming]);
    expect(first).not.toBe(second);
  });

  it('두 번째 사진에서 실패하면 이번에 만든 첫 복사본을 지운다(신고를 저장하기 전)', async () => {
    const { get, remove } = stubBlob();
    get.mockResolvedValueOnce({ contentLength: 123, contentType: 'image/jpeg' } as never);
    get.mockResolvedValueOnce({ contentLength: 0, contentType: 'image/jpeg' } as never);
    const other = incoming.replace('550e8400', '660e8400');
    await expect(keep([incoming, other])).rejects.toBeInstanceOf(BadRequestException);
    expect(remove).toHaveBeenCalledTimes(1);
    kept((remove.mock.contexts[0] as BlockBlobClient).url);
  });

  it('복사에 실패하면 503', async () => {
    const { copy } = stubBlob();
    copy.mockRejectedValue(new Error('복사 실패'));
    await expect(keep([incoming])).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('ObjectId가 아닌 신고 ID는 경로에 넣지 않는다', async () => {
    stubBlob();
    await expect(service().keepReportImages(owner, [incoming], '../x')).rejects.toThrow();
  });
});

describe('신고를 저장한 뒤 대기 표시 떼기 (confirmReportImages)', () => {
  it('복사본마다 태그를 비우고, 실패해도 던지지 않는다(정리 작업이 다시 확인)', async () => {
    const { tag } = stubBlob();
    tag.mockRejectedValueOnce(new Error('장애'));
    const urls = [
      `${base}/reports/${owner}/${reportId}/${file}`,
      `${base}/reports/${owner}/${reportId}/b.jpg`,
    ];
    await expect(service().confirmReportImages(urls)).resolves.toBeUndefined();
    expect(tag).toHaveBeenCalledTimes(2);
    expect(tag).toHaveBeenCalledWith({});
  });
});

describe('대기 복사본 정리 (sweepReportImages)', () => {
  const now = new Date('2026-11-15T00:00:00Z');
  const name = (id: string) => `reports/${owner}/${id}/${file}`;
  const none = { kept: 0, deleted: 0, failed: 0 };

  function stubFind(names: string[]) {
    const queries: string[] = [];
    vi.spyOn(ContainerClient.prototype, 'findBlobsByTags').mockImplementation(((query: string) => {
      queries.push(query);
      const blobs = names.map((n) => ({ name: n }));
      // 쪽 두 개로 나눠 줌(여러 쪽을 다 읽는지)
      const pages = [{ blobs: blobs.slice(0, 1) }, { blobs: blobs.slice(1) }];
      return {
        byPage: () =>
          (async function* () {
            yield* pages;
          })(),
      };
    }) as never);
    return queries;
  }

  it('대기 시간이 지난 것만 찾고, 신고가 있으면 태그를 떼고 없으면 지운다', async () => {
    const queries = stubFind([name(reportId), name(otherReport)]);
    const { remove, tag } = stubBlob();

    const counts = await service().sweepReportImages(now, async (id) => id === reportId);

    expect(counts).toEqual({ kept: 1, deleted: 1, failed: 0 });
    const cutoff = String(now.getTime() - REPORT_PENDING_GRACE_MS).padStart(15, '0');
    expect(queries).toEqual([`"${REPORT_PENDING_TAG}" < '${cutoff}'`]);
    expect((tag.mock.contexts[0] as BlockBlobClient).name).toBe(name(reportId));
    expect((remove.mock.contexts[0] as BlockBlobClient).name).toBe(name(otherReport));
  });

  it('신고를 확인하지 못한 것은 건드리지 않고 나머지는 계속한다', async () => {
    stubFind([name(reportId), name(otherReport)]);
    const { remove, tag } = stubBlob();
    const exists = vi.fn().mockRejectedValueOnce(new Error('DB 장애')).mockResolvedValueOnce(false);

    expect(await service().sweepReportImages(now, exists)).toEqual({
      kept: 0,
      deleted: 1,
      failed: 1,
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect((remove.mock.contexts[0] as BlockBlobClient).name).toBe(name(otherReport));
    expect(tag).not.toHaveBeenCalled();
  });

  it('한 번에 REPORT_SWEEP_MAX개까지만 보고 나머지는 다음 주기에 맡긴다', async () => {
    stubFind(Array.from({ length: REPORT_SWEEP_MAX + 5 }, () => name(otherReport)));
    stubBlob();
    const counts = await service().sweepReportImages(now, async () => false);
    expect(counts.deleted).toBe(REPORT_SWEEP_MAX);
  });

  it('우리가 만든 이름이 아니면 건드리지 않고, 저장소 설정이 없으면 아무것도 안 한다', async () => {
    stubFind(['reports/x/y.jpg', `incoming/${owner}/${file}`]);
    const { remove, tag } = stubBlob();
    const exists = vi.fn();

    expect(await service().sweepReportImages(now, exists)).toEqual(none);
    expect(await new BlobStorageService(null).sweepReportImages(now, exists)).toEqual(none);
    expect(exists).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(tag).not.toHaveBeenCalled();
  });
});
