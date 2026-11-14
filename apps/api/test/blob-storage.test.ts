import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BlockBlobClient } from '@azure/storage-blob';
import { ERROR_CODES } from '@notelink/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StorageConfig } from '../src/config/storage.config.js';
import { BlobStorageService } from '../src/modules/upload/blob-storage.service.js';

const config: StorageConfig = {
  accountName: 'stnotelinkdev01',
  accountKey: Buffer.alloc(32, 1).toString('base64'),
  blobEndpoint: 'https://stnotelinkdev01.blob.core.windows.net',
  container: 'raw',
};
const base = `${config.blobEndpoint}/${config.container}`;
const owner = '507f1f77bcf86cd799439011';
const file = '550e8400-e29b-41d4-a716-446655440000.jpg';
const incoming = `${base}/incoming/${owner}/${file}`;
const service = () => new BlobStorageService(config);
afterEach(() => vi.restoreAllMocks());

function stubBlob(properties: object | Error = { contentLength: 123, contentType: 'image/jpeg' }) {
  const get = vi.spyOn(BlockBlobClient.prototype, 'getProperties');
  if (properties instanceof Error) get.mockRejectedValue(properties);
  else get.mockResolvedValue(properties as never);
  const copy = vi
    .spyOn(BlockBlobClient.prototype, 'syncCopyFromURL')
    .mockResolvedValue({} as never);
  return { get, copy };
}

describe('신고 사진 확인 · 보관 (BlobStorageService.keepReportImages)', () => {
  it('내 임시 경로의 사진을 확인하고 reports/로 복사한 주소를 돌려준다', async () => {
    const { copy } = stubBlob();
    await expect(service().keepReportImages(owner, [incoming])).resolves.toEqual([
      `${base}/reports/${owner}/${file}`,
    ]);
    // 원본은 짧은 읽기 전용 SAS로 읽는다
    const source = new URL(copy.mock.calls[0]![0]);
    expect(`${source.origin}${source.pathname}`).toBe(incoming);
    expect(source.searchParams.get('sp')).toBe('r');
    expect(source.searchParams.get('sr')).toBe('b');
  });

  it('사진이 없으면 저장소 설정이 없어도 통과한다', async () => {
    await expect(new BlobStorageService(null).keepReportImages(owner, [])).resolves.toEqual([]);
  });

  it('사진이 있는데 저장소 설정이 없으면 503 UPLOAD_UNAVAILABLE', async () => {
    await expect(
      new BlobStorageService(null).keepReportImages(owner, [incoming]),
    ).rejects.toMatchObject({ response: { code: ERROR_CODES.UPLOAD_UNAVAILABLE } });
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
    await expect(service().keepReportImages(owner, [url])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(get).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });

  it('같은 사진을 두 번 붙이면 거부한다', async () => {
    stubBlob();
    await expect(service().keepReportImages(owner, [incoming, incoming])).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it.each([
    ['빈 파일', { contentLength: 0, contentType: 'image/jpeg' }],
    ['20MB 초과', { contentLength: 20 * 1024 * 1024 + 1, contentType: 'image/jpeg' }],
    ['확장자와 다른 형식', { contentLength: 123, contentType: 'image/png' }],
  ])('실제 파일이 %s이면 복사하지 않고 거부한다', async (_, properties) => {
    const { copy } = stubBlob(properties);
    await expect(service().keepReportImages(owner, [incoming])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(copy).not.toHaveBeenCalled();
  });

  it('올리지 않은 사진은 400, 저장소 장애는 503', async () => {
    stubBlob(Object.assign(new Error('없음'), { statusCode: 404 }));
    await expect(service().keepReportImages(owner, [incoming])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    vi.restoreAllMocks();
    stubBlob(new Error('장애'));
    await expect(service().keepReportImages(owner, [incoming])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('복사에 실패하면 503', async () => {
    const { copy } = stubBlob();
    copy.mockRejectedValue(new Error('복사 실패'));
    await expect(service().keepReportImages(owner, [incoming])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
