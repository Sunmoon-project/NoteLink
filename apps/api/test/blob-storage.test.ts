import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BlockBlobClient, ContainerClient } from '@azure/storage-blob';
import { ERROR_CODES } from '@notelink/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StorageConfig } from '../src/config/storage.config.js';
import {
  BlobStorageService,
  REPORT_PENDING_GRACE_MS,
  REPORT_PENDING_TAG,
  REPORT_SCOPE_TAG,
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
const scope = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const file = '550e8400-e29b-41d4-a716-446655440000.jpg';
const incoming = `${base}/incoming/${owner}/${file}`;
const service = () => new BlobStorageService(config);
const keep = (urls: string[], svc = service()) =>
  svc.keepReportImages(owner, urls, reportId, scope);
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
    .mockResolvedValue({ succeeded: true } as never);
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
    expect(copy.mock.calls[0]![1]?.tags?.[REPORT_SCOPE_TAG]).toBe(scope);
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

  it('ObjectId가 아닌 신고 ID · 형식이 다른 DB 구분값은 받지 않는다', async () => {
    const { copy } = stubBlob();
    await expect(service().keepReportImages(owner, [incoming], '../x', scope)).rejects.toThrow();
    await expect(
      service().keepReportImages(owner, [incoming], reportId, "x' OR 'a' = 'a"),
    ).rejects.toThrow();
    expect(copy).not.toHaveBeenCalled();
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

  it('이 DB의 대기 시간이 지난 것만 찾고, 신고가 있으면 태그를 떼고 없으면 지운다', async () => {
    const queries = stubFind([name(reportId), name(otherReport)]);
    const { remove, tag } = stubBlob();

    const counts = await service().sweepReportImages(now, scope, async (id) => id === reportId);

    expect(counts).toEqual({ kept: 1, deleted: 1, failed: 0 });
    const cutoff = String(now.getTime() - REPORT_PENDING_GRACE_MS).padStart(15, '0');
    const query = `"${REPORT_SCOPE_TAG}" = '${scope}' AND "${REPORT_PENDING_TAG}" < '${cutoff}'`;
    expect(queries).toEqual([query]);
    expect((tag.mock.contexts[0] as BlockBlobClient).name).toBe(name(reportId));
    expect((remove.mock.contexts[0] as BlockBlobClient).name).toBe(name(otherReport));
    // 지우거나 뗄 때도 같은 태그 조건을 건다(다른 DB 것 · 그 사이 바뀐 것은 저장소가 거절)
    const conditions = { tagConditions: query };
    expect(tag).toHaveBeenCalledWith({}, { conditions });
    expect(remove).toHaveBeenCalledWith({ conditions });
  });

  it('찾은 뒤 태그가 바뀐 것(412)은 실패로 세지 않고 건너뛴다', async () => {
    stubFind([name(reportId), name(otherReport)]);
    const { remove, tag } = stubBlob();
    const changed = Object.assign(new Error('조건 불일치'), { statusCode: 412 });
    remove.mockRejectedValue(changed);
    tag.mockRejectedValue(changed);

    const counts = await service().sweepReportImages(now, scope, async (id) => id === reportId);
    expect(counts).toEqual(none);
  });

  it('이미 지워진 것이 색인에 남아 다시 잡혀도 지운 수로 세지 않는다', async () => {
    stubFind([name(otherReport)]);
    const { remove } = stubBlob();
    remove.mockResolvedValue({ succeeded: false } as never);
    expect(await service().sweepReportImages(now, scope, async () => false)).toEqual(none);
  });

  it('형식이 다른 DB 구분값으로는 찾지 않는다', async () => {
    const queries = stubFind([name(otherReport)]);
    await expect(
      service().sweepReportImages(now, "x' OR 'a' = 'a", async () => false),
    ).rejects.toThrow();
    expect(queries).toEqual([]);
  });

  it('신고를 확인하지 못한 것은 건드리지 않고 나머지는 계속한다', async () => {
    stubFind([name(reportId), name(otherReport)]);
    const { remove, tag } = stubBlob();
    const exists = vi.fn().mockRejectedValueOnce(new Error('DB 장애')).mockResolvedValueOnce(false);

    expect(await service().sweepReportImages(now, scope, exists)).toEqual({
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
    const counts = await service().sweepReportImages(now, scope, async () => false);
    expect(counts.deleted).toBe(REPORT_SWEEP_MAX);
  });

  it('우리가 만든 이름이 아니면 건드리지 않고, 저장소 설정이 없으면 아무것도 안 한다', async () => {
    stubFind(['reports/x/y.jpg', `incoming/${owner}/${file}`]);
    const { remove, tag } = stubBlob();
    const exists = vi.fn();

    expect(await service().sweepReportImages(now, scope, exists)).toEqual(none);
    expect(await new BlobStorageService(null).sweepReportImages(now, scope, exists)).toEqual(none);
    expect(exists).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(tag).not.toHaveBeenCalled();
  });
});

describe('읽기 SAS (createReadAccess)', () => {
  const prefix = `uploads/image/${owner}/`;
  const url = `${base}/${prefix}${file}`;

  it('읽기 권한만 가진 HTTPS SAS를 요청한 시간만큼만 만든다', async () => {
    const now = Date.now();
    const { readUrl, sizeBytes } = await service().createReadAccess(url, 3_600_000);
    const sas = new URL(readUrl);
    expect(`${sas.origin}${sas.pathname}`).toBe(url);
    expect(sas.searchParams.get('sp')).toBe('r');
    expect(sas.searchParams.get('sr')).toBe('b');
    expect(sas.searchParams.get('spr')).toBe('https');
    const expires = new Date(sas.searchParams.get('se')!).getTime();
    expect(expires - now).toBeGreaterThan(3_590_000);
    expect(expires - now).toBeLessThanOrEqual(3_600_100);
    expect(sizeBytes).toBeUndefined();
  });

  it('verify를 주면 파일이 있는지 보고 크기를 돌려준다', async () => {
    stubBlob({ contentLength: 1234 });
    const { sizeBytes } = await service().createReadAccess(url, 1000, { prefix });
    expect(sizeBytes).toBe(1234);
  });

  it('컨테이너 밖 · 다른 사용자 · 이름 규칙이 다른 주소는 저장소 접근 없이 거절한다', async () => {
    const { get } = stubBlob();
    const bad = [
      'https://example.com/a.jpg',
      `${config.blobEndpoint}/other/${prefix}${file}`,
      `${url}?sv=x`,
      url.replace(owner, '507f1f77bcf86cd799439012'),
      url.replace('.jpg', '/../x.jpg'),
      `${base}/${prefix}not-a-uuid.jpg`,
      // 신고 사진 임시 경로의 파일은 노트로 쓸 수 없다
      incoming,
    ];
    for (const u of bad)
      await expect(service().createReadAccess(u, 1000, { prefix })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    expect(get).not.toHaveBeenCalled();
  });

  it('파일이 없으면 400, 저장소 장애면 503, 빈 파일은 400이다', async () => {
    const { get } = stubBlob();
    get.mockRejectedValueOnce({ statusCode: 404 });
    get.mockRejectedValueOnce(new Error('unavailable'));
    get.mockResolvedValueOnce({ contentLength: 0 } as never);
    const read = () => service().createReadAccess(url, 1000, { prefix });
    await expect(read()).rejects.toBeInstanceOf(BadRequestException);
    await expect(read()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(read()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('오류 메시지에 주소를 넣지 않고, 저장소 설정이 없으면 503이다', async () => {
    const error = await service()
      .createReadAccess('https://example.com/secret.jpg', 1000)
      .catch((e: Error) => e);
    expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain('secret');
    await expect(new BlobStorageService(null).createReadAccess(url, 1000)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('올린 파일 확인 (inspectUploads)', () => {
  const prefix = `uploads/image/${owner}/`;
  const url = `${base}/${prefix}${file}`;

  it('내 폴더의 파일은 크기 · 형식을 돌려주고, 폴더 밖 · 없는 파일은 null이다', async () => {
    const { get } = stubBlob({ contentLength: 10, contentType: 'image/jpeg' });
    get.mockResolvedValueOnce({ contentLength: 10, contentType: 'image/jpeg' } as never);
    get.mockRejectedValueOnce({ statusCode: 404 });
    const other = url.replace('550e8400', '660e8400');

    expect(await service().inspectUploads([url, incoming, other], prefix)).toEqual([
      { sizeBytes: 10, contentType: 'image/jpeg' },
      null,
      null,
    ]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('저장소 장애 · 설정 없음은 503이다', async () => {
    stubBlob(new Error('장애'));
    await expect(service().inspectUploads([url], prefix)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(new BlobStorageService(null).inspectUploads([url], prefix)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('사진 검사 SAS (createImageCheckReadUrl)', () => {
  const url = `${base}/uploads/image/${owner}/${file}`;
  const read = (target = url) => service().createImageCheckReadUrl(owner, target);

  it('같은 사용자가 올린 이미지에 15분짜리 읽기 전용 HTTPS SAS를 만든다', async () => {
    const now = Date.now();
    stubBlob({ contentLength: 1234, contentType: 'image/jpeg' });

    const sas = new URL(await read());

    expect(`${sas.origin}${sas.pathname}`).toBe(url);
    expect(sas.searchParams.get('sp')).toBe('r');
    expect(sas.searchParams.get('spr')).toBe('https');
    const expires = new Date(sas.searchParams.get('se')!).getTime();
    expect(expires - now).toBeGreaterThan(14 * 60_000);
    expect(expires - now).toBeLessThanOrEqual(15 * 60_000 + 100);
  });

  it('다른 사용자·외부 주소·쿼리 포함·비 UUID 경로·신고 사진 임시 경로를 Blob 조회 전에 거부한다', async () => {
    const { get } = stubBlob();
    const invalidUrls = [
      url.replace(owner, '507f1f77bcf86cd799439012'),
      'https://example.com/image.jpg',
      `${url}?already=signed`,
      url.replace(file, 'not-a-uuid.jpg'),
      incoming,
    ];

    for (const invalidUrl of invalidUrls)
      await expect(read(invalidUrl)).rejects.toBeInstanceOf(BadRequestException);
    expect(get).not.toHaveBeenCalled();
  });

  it('누락·크기 초과·MIME 불일치 이미지를 거부하고 저장소 장애를 구분한다', async () => {
    const { get } = stubBlob();
    get.mockRejectedValueOnce({ statusCode: 404 });
    get.mockResolvedValueOnce({
      contentLength: 21 * 1024 * 1024,
      contentType: 'image/jpeg',
    } as never);
    get.mockResolvedValueOnce({ contentLength: 1234, contentType: 'image/png' } as never);
    get.mockRejectedValueOnce(new Error('unavailable'));

    await expect(read()).rejects.toBeInstanceOf(BadRequestException);
    await expect(read()).rejects.toBeInstanceOf(BadRequestException);
    await expect(read()).rejects.toBeInstanceOf(BadRequestException);
    await expect(read()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('저장소 설정이 없으면 503이다', async () => {
    await expect(
      new BlobStorageService(null).createImageCheckReadUrl(owner, url),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
