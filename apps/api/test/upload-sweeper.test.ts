import type { Model } from 'mongoose';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it } from 'vitest';

import type { BlobStore } from '../src/modules/upload/blob-store.js';
import type { UploadTicket } from '../src/modules/upload/schemas/upload-ticket.schema.js';
import {
  KEEP_UNUSED_MS,
  SETTLE_MS,
  UploadSweeper,
} from '../src/modules/upload/upload-sweeper.service.js';
import { createFakeUploadTickets } from './support/fake-upload-tickets.js';

const MB = 1024 * 1024;
const MAX = 20 * MB;
const T0 = new Date('2026-11-12T00:00:00.000Z');
const after = (ms: number) => new Date(T0.getTime() + ms);

/** 이름 → 크기만 가진 저장소. failOn에 든 이름은 오류를 낸다 */
function fakeBlobs() {
  const sizes = new Map<string, number>();
  const failOn = new Set<string>();
  const store: BlobStore = {
    size: (name) =>
      failOn.has(name)
        ? Promise.reject(new Error('저장소 오류'))
        : Promise.resolve(sizes.get(name) ?? null),
    remove: (name) => {
      if (failOn.has(name)) return Promise.reject(new Error('저장소 오류'));
      sizes.delete(name);
      return Promise.resolve();
    },
  };
  return { store, sizes, failOn };
}

describe('올린 파일 확인 · 정리 (UploadSweeper)', () => {
  let tickets: ReturnType<typeof createFakeUploadTickets>;
  let blobs: ReturnType<typeof fakeBlobs>;
  let sweeper: UploadSweeper;
  const owner = new Types.ObjectId();

  /** T0에 만료되는 주소를 내준 기록 */
  const issue = (name: string, over: { status?: string; expiresAt?: Date } = {}) => {
    tickets.rows.push({
      _id: new Types.ObjectId(),
      ownerId: owner,
      blobName: name,
      maxBytes: MAX,
      status: 'issued',
      expiresAt: T0,
      checkedAt: null,
      createdAt: T0,
      ...over,
    });
  };
  const names = () => tickets.rows.map((r) => r.blobName);

  beforeEach(() => {
    tickets = createFakeUploadTickets();
    blobs = fakeBlobs();
    sweeper = new UploadSweeper(tickets.model as unknown as Model<UploadTicket>, blobs.store);
  });

  it('작게 알리고 상한을 넘겨 올린 파일은 지우고 기록도 지운다', async () => {
    issue('a/big.jpg');
    blobs.sizes.set('a/big.jpg', MAX + 1);

    const result = await sweeper.sweep(after(SETTLE_MS));

    expect(result).toMatchObject({ oversize: 1, failed: 0 });
    expect(blobs.sizes.has('a/big.jpg')).toBe(false);
    expect(names()).toEqual([]);
  });

  it('상한까지인 파일은 두고, 확인한 시각을 남겨 다시 확인하지 않는다', async () => {
    issue('a/ok.jpg');
    blobs.sizes.set('a/ok.jpg', MAX);

    await sweeper.sweep(after(SETTLE_MS));
    expect(blobs.sizes.get('a/ok.jpg')).toBe(MAX);
    expect(tickets.rows[0]!.checkedAt).toEqual(after(SETTLE_MS));

    // 확인이 끝난 기록은 저장소를 다시 읽지 않는다
    blobs.failOn.add('a/ok.jpg');
    const again = await sweeper.sweep(after(SETTLE_MS + 60_000));
    expect(again.failed).toBe(0);
  });

  it('올리기가 끝날 시간이 지나기 전에는 건드리지 않는다', async () => {
    issue('a/big.jpg');
    blobs.sizes.set('a/big.jpg', MAX + 1);

    const result = await sweeper.sweep(after(SETTLE_MS - 1));

    expect(result).toEqual({ oversize: 0, missing: 0, unused: 0, failed: 0 });
    expect(blobs.sizes.has('a/big.jpg')).toBe(true);
    expect(names()).toEqual(['a/big.jpg']);
  });

  it('주소만 받고 올리지 않았으면 기록만 지운다', async () => {
    issue('a/none.jpg');

    const result = await sweeper.sweep(after(SETTLE_MS));

    expect(result.missing).toBe(1);
    expect(names()).toEqual([]);
  });

  it('등록하지 않은 채 하루가 지난 파일은 크기가 맞아도 지운다', async () => {
    issue('a/ok.jpg');
    blobs.sizes.set('a/ok.jpg', 10);
    await sweeper.sweep(after(SETTLE_MS));
    expect(blobs.sizes.has('a/ok.jpg')).toBe(true);

    await sweeper.sweep(after(KEEP_UNUSED_MS - 1));
    expect(blobs.sizes.has('a/ok.jpg')).toBe(true);

    const result = await sweeper.sweep(after(KEEP_UNUSED_MS));
    expect(result.unused).toBe(1);
    expect(blobs.sizes.has('a/ok.jpg')).toBe(false);
    expect(names()).toEqual([]);
  });

  it('자료로 등록된(used) 파일은 크기 확인 · 정리에서 뺀다', async () => {
    issue('a/used.jpg', { status: 'used' });
    blobs.sizes.set('a/used.jpg', MAX + 1);

    const result = await sweeper.sweep(after(KEEP_UNUSED_MS * 2));

    expect(result).toEqual({ oversize: 0, missing: 0, unused: 0, failed: 0 });
    expect(blobs.sizes.has('a/used.jpg')).toBe(true);
    expect(names()).toEqual(['a/used.jpg']);
  });

  it('하나가 실패해도 나머지는 처리하고, 실패한 기록은 남겨 다음에 다시 한다', async () => {
    issue('a/fail.jpg');
    issue('a/big.jpg');
    blobs.sizes.set('a/fail.jpg', MAX + 1);
    blobs.sizes.set('a/big.jpg', MAX + 1);
    blobs.failOn.add('a/fail.jpg');

    const result = await sweeper.sweep(after(SETTLE_MS));
    expect(result).toMatchObject({ oversize: 1, failed: 1 });
    expect(names()).toEqual(['a/fail.jpg']);

    blobs.failOn.clear();
    const retry = await sweeper.sweep(after(SETTLE_MS + 60_000));
    expect(retry).toMatchObject({ oversize: 1, failed: 0 });
    expect(blobs.sizes.size).toBe(0);
    expect(names()).toEqual([]);
  });

  it('저장소가 설정되지 않았으면 아무것도 하지 않는다', async () => {
    issue('a/big.jpg');
    const off = new UploadSweeper(tickets.model as unknown as Model<UploadTicket>, null);

    expect(await off.sweep(after(KEEP_UNUSED_MS))).toEqual({
      oversize: 0,
      missing: 0,
      unused: 0,
      failed: 0,
    });
    expect(names()).toEqual(['a/big.jpg']);
  });
});
