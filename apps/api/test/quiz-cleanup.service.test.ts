// 학습 폴더 삭제 때 오늘의 복습에서 이어 만든 세트를 남기는 판단(#602)을 메모리 가짜 모델로 본다. 실제 DB 동작 · 트랜잭션은
// folders-real-db.test.ts 가 본다. 여기서는 이어 만든 단계가 아주 깊거나(Codex 1차: 50단계에서 끊으면 지웠음) 고리가 있을 때다.
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { QuizCleanupService } from '../src/quiz-sets/quiz-cleanup.service.js';
import { QuizSetsService } from '../src/quiz-sets/quiz-sets.service.js';
import { createFakeCollection, matches, type Row } from './support/fake-collection.js';

/** 가짜 모델에 updateMany · deleteMany(조건은 matches 와 같음)를 더한다 */
function writable(c: ReturnType<typeof createFakeCollection>) {
  return Object.assign(c.model, {
    updateMany: (filter: Record<string, unknown>, update: { $set: Row }) => {
      for (const r of c.rows) if (matches(r, filter)) Object.assign(r, update.$set);
      return Promise.resolve({});
    },
    deleteMany: (filter: Record<string, unknown>) => {
      for (let i = c.rows.length - 1; i >= 0; i--)
        if (matches(c.rows[i]!, filter)) c.rows.splice(i, 1);
      return Promise.resolve({});
    },
    updateOne: (filter: Record<string, unknown>, update: { $set: Row }) => {
      const r = c.rows.find((x) => matches(x, filter));
      if (r) Object.assign(r, update.$set);
      return Promise.resolve({});
    },
  });
}

describe('폴더 삭제 정리: 오늘의 복습에서 이어 만든 세트는 깊이와 상관없이 남긴다(#602, Codex 1차)', () => {
  const me = new Types.ObjectId();
  const folderId = new Types.ObjectId();
  const note = new Types.ObjectId();

  function setup() {
    const sets = createFakeCollection();
    const cards = createFakeCollection();
    const boxItems = createFakeCollection();
    const cleanup = new QuizCleanupService(
      writable(sets) as never,
      writable(cards) as never,
      writable(boxItems) as never,
      {} as never,
    );
    const set = (over: Record<string, unknown>) => {
      const row: Row = {
        _id: new Types.ObjectId(),
        ownerId: me,
        materialId: note,
        folderId,
        reviewDay: null,
        sourceSetId: null,
        deletedAt: null,
        ...over,
      };
      sets.rows.push(row);
      return row;
    };
    /** 오늘의 복습 하나에서 n번 이어 만든 사슬. 마지막 세트를 돌려준다 */
    const chain = (n: number, root: Row) => {
      let prev = root;
      for (let i = 0; i < n; i++) prev = set({ sourceSetId: prev._id });
      return prev;
    };
    return { sets, cleanup, set, chain };
  }

  it.each([49, 50, 51, 60])(
    '%i번 이어 만든 오답 복습도 남기고, 오늘의 복습과 상관없는 세트만 지운다',
    async (n) => {
      const { sets, cleanup, set, chain } = setup();
      const today = set({ reviewDay: '2026-11-20' });
      const last = chain(n, today);
      const plain = set({});

      const removed = await cleanup.removeFor(me, { folderId, materialIds: [note] }, new Date());

      expect(removed.map(String)).toEqual([String(plain._id)]);
      expect(sets.rows.find((r) => String(r._id) === String(last._id))?.['deletedAt']).toBeNull();
    },
  );

  it('원본이 범위 밖(이미 지운 오늘의 복습)이어도 깊게 이어진 세트를 남긴다', async () => {
    const { cleanup, set, chain } = setup();
    // 범위 밖: 다른 폴더 · 이미 지움
    const today = set({
      reviewDay: '2026-11-19',
      folderId: new Types.ObjectId(),
      materialId: new Types.ObjectId(),
      deletedAt: new Date('2026-11-19T00:00:00.000Z'),
    });
    chain(55, today);

    expect(await cleanup.removeFor(me, { folderId, materialIds: [note] }, new Date())).toEqual([]);
  });

  it('오늘의 복습이 없는 고리(서로 원본)는 끝나고 지운다', async () => {
    const { sets, cleanup, set } = setup();
    const a = set({});
    const b = set({ sourceSetId: a._id });
    a['sourceSetId'] = b._id;

    const removed = await cleanup.removeFor(me, { folderId, materialIds: [note] }, new Date());

    expect(removed.map(String).sort()).toEqual([String(a._id), String(b._id)].sort());
    expect(sets.rows.every((r) => r['deletedAt'] instanceof Date)).toBe(true);
  });

  it('세트를 넣은 쪽의 재확인(QuizSetsService.dropIfFolderGone)도 60번 이어 만든 세트를 남긴다', async () => {
    const { sets, set, chain } = setup();
    const materials = createFakeCollection();
    const folders = createFakeCollection();
    folders.rows.push({ _id: folderId, ownerId: me, deletedAt: new Date() });
    materials.rows.push({ _id: note, ownerId: me, folderId, deletedAt: new Date() });
    const quizSets = new QuizSetsService(
      writable(sets) as never,
      materials.model as never,
      {} as never,
      {} as never,
      {} as never,
      folders.model as never,
    );
    const last = chain(60, set({ reviewDay: '2026-11-20' }));

    expect(await quizSets.dropIfFolderGone(me.toHexString(), last as never)).toBe(false);
    expect(sets.rows.find((r) => String(r._id) === String(last._id))?.['deletedAt']).toBeNull();
  });
});
