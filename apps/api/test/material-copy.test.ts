// 「내 폴더로 가져오기」(POST /materials/:id/copy, FR-26): 공유받아 볼 수 있는 남의 노트만 복사한다
import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { MaterialSharingController } from '../src/modules/content/materials/material-sharing.controller.js';

const me = new Types.ObjectId().toHexString();
const owner = new Types.ObjectId().toHexString();
const note = new Types.ObjectId().toHexString();
const req = { user: { sub: me, userId: me } } as never;

const make = (ownerOfShared: string | null) => {
  const copyNote = vi.fn(async () => ({ _id: 'n2', folderId: 'f1' }));
  const ctrl = new MaterialSharingController(
    { ownerOfShared: vi.fn(async () => ownerOfShared) } as never,
    { copyNote } as never,
  );
  return { ctrl, copyNote };
};

describe('POST /materials/:id/copy', () => {
  it('방 · 친구로 공유받은 남의 노트는 주인 노트를 고른 폴더로 복사한다', async () => {
    const { ctrl, copyNote } = make(owner);
    await expect(ctrl.copyShared(req, note, { folderId: 'f1' })).resolves.toEqual({
      data: { _id: 'n2', folderId: 'f1' },
    });
    const [userId, ownerId, materialId, folderId] = copyNote.mock.calls[0] as unknown as [
      string,
      Types.ObjectId,
      Types.ObjectId,
      string,
    ];
    expect([userId, ownerId.toHexString(), materialId.toHexString(), folderId]).toEqual([
      me,
      owner,
      note,
      'f1',
    ]);
  });

  it('볼 수 없는 노트 · 내 노트는 404', async () => {
    for (const who of [null, me]) {
      const { ctrl, copyNote } = make(who);
      await expect(ctrl.copyShared(req, note, {})).rejects.toBeInstanceOf(NotFoundException);
      expect(copyNote).not.toHaveBeenCalled();
    }
  });
});
