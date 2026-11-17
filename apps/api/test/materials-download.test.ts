import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  APP_READ_SAS_MS,
  downloadFileName,
  MaterialsService,
} from '../src/modules/content/materials/materials.service.js';
import { createStorageConfig } from '../src/config/storage.config.js';
import { BlobStorageService } from '../src/modules/upload/blob-storage.service.js';

const account = 'stnotelinkdev01';
const container = 'notelink';
const connectionString = `DefaultEndpointsProtocol=https;AccountName=${account};AccountKey=${Buffer.alloc(32, 1).toString('base64')};EndpointSuffix=core.windows.net`;
const config = {
  get: (key: string) =>
    ({
      AZURE_BLOB_ACCOUNT_URL: `https://${account}.blob.core.windows.net`,
      AZURE_BLOB_CONTAINER: container,
      AZURE_STORAGE_CONNECTION_STRING: connectionString,
    })[key],
};

const me = new Types.ObjectId();
const other = new Types.ObjectId();
const uuid = (n: number) => `550e8400-e29b-41d4-a716-44665544000${n}`;
const blobUrl = (kind: string, n: number, ext: string) =>
  `https://${account}.blob.core.windows.net/${container}/uploads/${kind}/${me.toHexString()}/${uuid(n)}.${ext}`;

interface Row {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  deletedAt: Date | null;
  title: string;
  blobUrls?: string[];
}

/** 모델만 가짜이고 저장소 서비스는 진짜다(SAS 를 실제로 만든다) */
function setup(rows: Row[], storage = new BlobStorageService(createStorageConfig(config))) {
  const find = vi.fn((filter: Record<string, unknown>) => ({
    lean: () =>
      Promise.resolve(
        rows.find(
          (r) =>
            String(r._id) === String(filter['_id']) &&
            String(r.ownerId) === String(filter['ownerId']) &&
            r.deletedAt === (filter['deletedAt'] as null),
        ) ?? null,
      ),
  }));
  const service = new MaterialsService(
    { findOne: find } as never,
    {} as never,
    {} as never,
    storage,
    {} as never,
    {} as never,
  );
  return { service, find };
}

const note = (over: Partial<Row> = {}): Row => ({
  _id: new Types.ObjectId(),
  ownerId: me,
  deletedAt: null,
  title: '자료구조 필기',
  blobUrls: [blobUrl('image', 1, 'jpg')],
  ...over,
});

describe('원본 다운로드 주소 (MaterialsService.downloadUrl)', () => {
  it('{ url, fileName }: 첫 파일의 읽기 전용 SAS(1시간)와 "제목.확장자"', async () => {
    const row = note();
    const { service } = setup([row]);
    const now = Date.now();

    const res = await service.downloadUrl(me.toHexString(), String(row._id));

    expect(Object.keys(res).sort()).toEqual(['fileName', 'url']);
    expect(res.fileName).toBe('자료구조 필기.jpg');
    const sas = new URL(res.url);
    expect(`${sas.origin}${sas.pathname}`).toBe(row.blobUrls![0]);
    expect(sas.searchParams.get('sp')).toBe('r');
    expect(sas.searchParams.get('sr')).toBe('b');
    expect(sas.searchParams.get('spr')).toBe('https');
    const expires = new Date(sas.searchParams.get('se')!).getTime();
    expect(expires - now).toBeGreaterThan(APP_READ_SAS_MS - 10_000);
    expect(expires - now).toBeLessThanOrEqual(APP_READ_SAS_MS + 100);
  });

  it('PDF · 녹음은 그 파일, 이미지가 여러 장이면 첫 파일만', async () => {
    const pdf = note({ blobUrls: [blobUrl('document', 2, 'pdf')], title: '강의자료' });
    const rec = note({ blobUrls: [blobUrl('audio', 3, 'm4a')], title: '녹음 1' });
    const many = note({
      blobUrls: [
        blobUrl('image', 4, 'png'),
        blobUrl('image', 5, 'jpg'),
        blobUrl('image', 6, 'jpg'),
      ],
    });
    const { service } = setup([pdf, rec, many]);

    const a = await service.downloadUrl(me.toHexString(), String(pdf._id));
    const b = await service.downloadUrl(me.toHexString(), String(rec._id));
    const c = await service.downloadUrl(me.toHexString(), String(many._id));

    expect(a.fileName).toBe('강의자료.pdf');
    expect(new URL(a.url).pathname).toContain(`${uuid(2)}.pdf`);
    expect(b.fileName).toBe('녹음 1.m4a');
    expect(c.fileName).toBe('자료구조 필기.png');
    expect(new URL(c.url).pathname).toContain(`${uuid(4)}.png`);
    expect(c.url).not.toContain(uuid(5));
  });

  it('남의 노트 · 지운 노트 · 없는 노트 · 잘못된 id · 원본이 없는 노트는 404', async () => {
    const theirs = note({ ownerId: other });
    const deleted = note({ deletedAt: new Date() });
    const empty = note({ blobUrls: [] });
    const legacy = note({ blobUrls: undefined });
    const { service } = setup([theirs, deleted, empty, legacy]);

    for (const id of [
      String(theirs._id),
      String(deleted._id),
      String(new Types.ObjectId()),
      'nope',
      '../x',
      String(empty._id),
      String(legacy._id),
    ]) {
      await expect(service.downloadUrl(me.toHexString(), id), id).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
  });

  it('저장소 설정이 없으면 503이고, 오류에 주소 · SAS 를 넣지 않는다', async () => {
    const row = note();
    const { service } = setup([row], new BlobStorageService(null));

    const error = await service.downloadUrl(me.toHexString(), String(row._id)).catch((e) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const text = JSON.stringify(error.getResponse());
    expect(text).not.toContain('blob.core.windows.net');
    expect(text).not.toContain('sig=');
  });
});

describe('다운로드 파일 이름 (downloadFileName)', () => {
  const url = blobUrl('image', 1, 'jpg');

  it('파일 이름에 쓸 수 없는 문자는 _ 로 바꾼다', () => {
    expect(downloadFileName('a/b\\c:d*e?f"g<h>i|j', url)).toBe('a_b_c_d_e_f_g_h_i_j.jpg');
    expect(downloadFileName('줄\n바꿈\t탭', url)).toBe('줄_바꿈_탭.jpg');
    expect(downloadFileName('../../etc/passwd', url)).toBe('_.._etc_passwd.jpg');
  });

  it('앞뒤 공백 · 점을 정리하고, 비면 "노트"', () => {
    expect(downloadFileName('  운영체제  ', url)).toBe('운영체제.jpg');
    expect(downloadFileName('끝에 점...', url)).toBe('끝에 점.jpg');
    expect(downloadFileName('   ', url)).toBe('노트.jpg');
    expect(downloadFileName('...', url)).toBe('노트.jpg');
  });

  it('확장자는 소문자로 붙이고, 이상한 확장자는 붙이지 않는다', () => {
    expect(downloadFileName('a', blobUrl('document', 2, 'PDF'))).toBe('a.pdf');
    expect(downloadFileName('a', 'https://x/y/noext')).toBe('a');
  });
});
