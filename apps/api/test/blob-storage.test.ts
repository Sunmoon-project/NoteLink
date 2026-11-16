import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { BlockBlobClient } from '@azure/storage-blob';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlobStorageService } from '../src/modules/upload/blob-storage.service.js';

const account = 'stnotelinkdev01';
const container = 'studyroom-report';
const connectionString = `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${Buffer.alloc(32, 1).toString('base64')};EndpointSuffix=core.windows.net`;
const owner = '507f1f77bcf86cd799439011';
const name = `reports/${owner}/550e8400-e29b-41d4-a716-446655440000.jpg`;
const config = {
  get: (key: string) =>
    ({
      AZURE_BLOB_ACCOUNT_URL: `https://${account}.blob.core.windows.net`,
      AZURE_BLOB_CONTAINER: container,
      AZURE_STORAGE_CONNECTION_STRING: connectionString,
    })[key],
};
const service = () => new BlobStorageService(config as never);
afterEach(() => vi.restoreAllMocks());

describe('Azure Blob 신고 첨부', () => {
  it('파일 하나에 대해서만 생성 권한과 HTTPS를 가진 만료 SAS를 발급한다', async () => {
    const now = Date.now();
    const result = await service().createUpload(name);
    const url = new URL(result.uploadUrl);
    expect(result.blobUrl).toBe(`https://${account}.blob.core.windows.net/${container}/${name}`);
    expect(url.searchParams.get('sp')).toBe('c');
    expect(url.searchParams.get('sr')).toBe('b');
    expect(url.searchParams.get('spr')).toBe('https');
    expect(new Date(result.expiresAt).getTime() - now).toBeLessThanOrEqual(600_100);
    expect(result.headers).toEqual({ 'x-ms-blob-type': 'BlockBlob' });
  });
  it('다른 사용자나 외부 주소는 저장소 접근 없이 거부한다', async () => {
    const get = vi.spyOn(BlockBlobClient.prototype, 'getProperties');
    await expect(
      service().validateReportImages(owner, [
        `https://${account}.blob.core.windows.net/${container}/reports/507f1f77bcf86cd799439012/550e8400-e29b-41d4-a716-446655440000.jpg`,
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service().validateReportImages(owner, ['https://example.com/image.jpg']),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(get).not.toHaveBeenCalled();
  });
  it('같은 사용자가 올린 실재 사진만 허용하고 누락·잘못된 크기·저장소 장애를 구분한다', async () => {
    const url = `https://${account}.blob.core.windows.net/${container}/${name}`;
    const get = vi.spyOn(BlockBlobClient.prototype, 'getProperties');
    get.mockResolvedValueOnce({ contentLength: 123, contentType: 'image/jpeg' } as never);
    get.mockRejectedValueOnce({ statusCode: 404 });
    get.mockResolvedValueOnce({
      contentLength: 21 * 1024 * 1024,
      contentType: 'image/jpeg',
    } as never);
    get.mockRejectedValueOnce(new Error('unavailable'));
    await expect(service().validateReportImages(owner, [url])).resolves.toBeUndefined();
    await expect(service().validateReportImages(owner, [url])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service().validateReportImages(owner, [url])).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(service().validateReportImages(owner, [url])).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
  it('설정이 없어도 첨부 없는 신고는 저장소 접근 없이 통과한다', async () => {
    const missing = new BlobStorageService({ get: () => undefined } as never);
    await expect(missing.validateReportImages(owner, [])).resolves.toBeUndefined();
    await expect(missing.createUpload(name)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('계정이 다른 연결 문자열은 사용하지 않는다', async () => {
    const mismatched = new BlobStorageService({
      get: (key: string) =>
        key === 'AZURE_STORAGE_CONNECTION_STRING'
          ? connectionString.replace(`AccountName=${account}`, 'AccountName=otheraccount')
          : config.get(key),
    } as never);
    await expect(mismatched.createUpload(name)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  describe('올린 파일 지우기 (deleteUpload)', () => {
    const prefix = `uploads/image/${owner}/`;
    const root = `https://${account}.blob.core.windows.net/${container}`;
    const url = `${root}/${prefix}550e8400-e29b-41d4-a716-446655440000.jpg`;

    it('prefix 아래 올린 파일만 지운다', async () => {
      const remove = vi
        .spyOn(BlockBlobClient.prototype, 'deleteIfExists')
        .mockResolvedValue({ succeeded: true } as never);
      await service().deleteUpload(url, prefix);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove.mock.contexts[0]).toMatchObject({ url });
    });

    it('남의 폴더 · 다른 종류 · 하위 경로 · 외부 주소는 저장소를 부르지 않는다', async () => {
      const remove = vi.spyOn(BlockBlobClient.prototype, 'deleteIfExists');
      const file = '550e8400-e29b-41d4-a716-446655440000.jpg';
      for (const other of [
        `${root}/uploads/image/507f1f77bcf86cd799439012/${file}`,
        `${root}/uploads/audio/${owner}/${file}`,
        `${root}/${prefix}sub/${file}`,
        `${root}/${prefix}../${owner}/${file}`,
        `https://example.com/${container}/${prefix}${file}`,
      ])
        await service().deleteUpload(other, prefix);
      expect(remove).not.toHaveBeenCalled();
    });
  });

  describe('읽기 SAS (createReadAccess)', () => {
    const prefix = `uploads/image/${owner}/`;
    const file = `${prefix}550e8400-e29b-41d4-a716-446655440000.jpg`;
    const url = `https://${account}.blob.core.windows.net/${container}/${file}`;

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
      vi.spyOn(BlockBlobClient.prototype, 'getProperties').mockResolvedValue({
        contentLength: 1234,
      } as never);
      const { sizeBytes } = await service().createReadAccess(url, 1000, { prefix });
      expect(sizeBytes).toBe(1234);
    });

    it('컨테이너 밖 · 다른 사용자 · 이름 규칙이 다른 주소는 저장소 접근 없이 거절한다', async () => {
      const get = vi.spyOn(BlockBlobClient.prototype, 'getProperties');
      const bad = [
        'https://example.com/a.jpg',
        `https://${account}.blob.core.windows.net/other/${file}`,
        `${url}?sv=x`,
        url.replace(owner, '507f1f77bcf86cd799439012'),
        url.replace('.jpg', '/../x.jpg'),
        `https://${account}.blob.core.windows.net/${container}/${prefix}not-a-uuid.jpg`,
      ];
      for (const u of bad) {
        await expect(service().createReadAccess(u, 1000, { prefix })).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(get).not.toHaveBeenCalled();
    });

    it('파일이 없으면 400, 저장소 장애면 503, 빈 파일은 400이다', async () => {
      const get = vi.spyOn(BlockBlobClient.prototype, 'getProperties');
      get.mockRejectedValueOnce({ statusCode: 404 });
      get.mockRejectedValueOnce(new Error('unavailable'));
      get.mockResolvedValueOnce({ contentLength: 0 } as never);
      await expect(service().createReadAccess(url, 1000, { prefix })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(service().createReadAccess(url, 1000, { prefix })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(service().createReadAccess(url, 1000, { prefix })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('오류 메시지에 주소를 넣지 않는다', async () => {
      const error = await service()
        .createReadAccess('https://example.com/secret.jpg', 1000)
        .catch((e: Error) => e);
      expect(JSON.stringify((error as BadRequestException).getResponse())).not.toContain('secret');
    });

    it('저장소 설정이 없으면 503이다', async () => {
      const missing = new BlobStorageService({ get: () => undefined } as never);
      await expect(missing.createReadAccess(url, 1000)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  it('빈 연결 문자열은 안전한 오류로 처리한다', async () => {
    const missing = new BlobStorageService({
      get: (key: string) => (key === 'AZURE_STORAGE_CONNECTION_STRING' ? '' : config.get(key)),
    } as never);
    await expect(missing.createUpload(name)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
