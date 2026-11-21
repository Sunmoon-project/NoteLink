// 노트 「다시 만들기」 동기화(MaterialsService.sync → syncRegen)가 regenJobId 를 지울 때
// 그 작업을 processing.lastRegenJobId 에 남기는지 본다(#639). 남겨 두어야 알림(ai-job-notices.service.ts)이
// 노트를 먼저 연 뒤에 끝난 다시 만들기의 실패도 「그 노트의 마지막 다시 만들기」로 알아본다.
// 가짜 모델로 노트에 쓰는 값만 본다(진짜 DB 흐름은 materials-regenerate-real-db.test.ts)
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { MaterialsService } from '../src/modules/content/materials/materials.service.js';
import type { MaterialRow } from '../src/modules/content/materials/material-view.js';

const userId = new Types.ObjectId();

function setup(job: { status: string; result?: Record<string, unknown> | null } | null) {
  const old = new Types.ObjectId();
  // 만든 지 오래된 작업 id(작업이 없을 때 「방금 자리를 잡는 중」으로 보지 않게)
  const regenId = Types.ObjectId.createFromTime(Math.floor(Date.now() / 1000) - 3600);
  const row: MaterialRow = {
    _id: new Types.ObjectId(),
    ownerId: userId,
    folderId: new Types.ObjectId(),
    kind: 'recording',
    source: 'recording',
    title: '영어 녹음',
    processing: { status: 'done', progress: 100, jobId: old, regenJobId: regenId },
    createdAt: new Date(),
  };
  const writes: { filter: Record<string, unknown>; set: Record<string, unknown> }[] = [];
  const materials = {
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: { $set: Record<string, unknown> },
    ) => {
      writes.push({ filter, set: update.$set });
      return { lean: () => Promise.resolve({ ...row }) };
    },
    findOne: () => ({ lean: () => Promise.resolve({ ...row }) }),
  };
  const jobs = {
    findMine: () =>
      Promise.resolve(
        job && {
          id: regenId.toHexString(),
          type: 'recording_summary',
          status: job.status,
          progress: 100,
          result: job.result ?? null,
        },
      ),
  };
  const service = new MaterialsService(
    materials as never,
    {} as never,
    jobs as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, row, writes, old, regenId };
}

describe('다시 만들기 동기화는 지우는 regenJobId 를 lastRegenJobId 에 남긴다(#639)', () => {
  it('다시 만들기가 실패하면 옛 결과를 두고 regenJobId 를 지우며 lastRegenJobId 에 남긴다', async () => {
    const { service, row, writes, old, regenId } = setup({ status: 'failed' });
    await service.sync(userId.toHexString(), row);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.filter).toMatchObject({ 'processing.regenJobId': regenId });
    expect(writes[0]!.set).toEqual({
      'processing.regenJobId': null,
      'processing.lastRegenJobId': regenId,
    });
    expect(writes[0]!.set['processing.jobId']).toBeUndefined();
    expect(row.processing.jobId).toBe(old);
  });

  it('성공했지만 결과를 쓸 수 없어도(옛 결과 유지) lastRegenJobId 에 남긴다', async () => {
    const { service, row, writes, regenId } = setup({
      status: 'succeeded',
      result: { slides: [] },
    });
    await service.sync(userId.toHexString(), row);
    expect(writes[0]!.set).toEqual({
      'processing.regenJobId': null,
      'processing.lastRegenJobId': regenId,
    });
  });

  it('성공해 결과를 바꾸면 jobId 를 새 작업으로 바꾸고 lastRegenJobId 에도 남긴다', async () => {
    const { service, row, writes, regenId } = setup({
      status: 'succeeded',
      result: { slides: [{ title: '도입', summary: '시작', startMs: 0, endMs: 1 }] },
    });
    await service.sync(userId.toHexString(), row);
    expect(writes[0]!.set).toMatchObject({
      'processing.status': 'done',
      'processing.jobId': regenId,
      'processing.regenJobId': null,
      'processing.lastRegenJobId': regenId,
    });
  });

  it('작업이 없어져 자리를 비울 때도 lastRegenJobId 에 남긴다(알릴 작업이 없으니 알림은 없다)', async () => {
    const { service, row, writes, regenId } = setup(null);
    await service.sync(userId.toHexString(), row);
    expect(writes[0]!.set).toEqual({
      'processing.regenJobId': null,
      'processing.lastRegenJobId': regenId,
    });
  });

  it('아직 처리 중이면 아무것도 쓰지 않는다', async () => {
    const { service, row, writes } = setup({ status: 'running' });
    await service.sync(userId.toHexString(), row);
    expect(writes).toHaveLength(0);
  });
});
