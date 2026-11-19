import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { mongo, Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { DeleteFlashcardsDto, FLASHCARD_DELETE_MAX, SaveFlashcardDto } from '../src/modules/quiz/dto/flashcard.dto.js';
import { autoCardId, AUTO_CARD_MAX, FlashcardsService } from '../src/modules/quiz/flashcards.service.js';
import { FlashcardSchema } from '../src/modules/quiz/schemas/flashcard.schema.js';

type Row = Record<string, unknown> & { _id: Types.ObjectId };
const same = (a: unknown, b: unknown) => String(a) === String(b);

/** 서비스가 쓰는 질의만 흉내 내는 작은 메모리 모델 */
function fakeModels() {
  const cards: Row[] = [];
  const sets: Row[] = [];
  const materials: Row[] = [];
  let clock = 0;
  const bulkCalls: { ops: number; options: unknown }[] = [];
  let bulkError: unknown = null;
  const lean = <T>(value: T) => ({ lean: () => Promise.resolve(value), select: () => ({ lean: () => Promise.resolve(value) }) });

  const cardModel = {
    create: (data: Record<string, unknown>) => {
      const row: Row = { createdAt: new Date(Date.UTC(2026, 10, 8, 0, 0, clock++)), ...data, _id: new Types.ObjectId() };
      cards.push(row);
      return Promise.resolve({ toObject: () => row });
    },
    find: (filter: {
      ownerId: Types.ObjectId;
      deletedAt?: null;
      materialId?: Types.ObjectId;
      _id?: { $nin: Types.ObjectId[] };
    }) => {
      const found = cards
        .filter((c) => same(c['ownerId'], filter.ownerId) && (c['deletedAt'] ?? null) === null)
        .sort((a, b) => (a['createdAt'] as Date).getTime() - (b['createdAt'] as Date).getTime());
      // 자동 카드가 같은 노트의 카드 앞면을 읽는 질의(지운 카드 포함, 그 세트의 카드 id 빼고)
      const ofNote = cards.filter(
        (c) =>
          same(c['ownerId'], filter.ownerId) &&
          same(c['materialId'], filter.materialId) &&
          !(filter._id?.$nin ?? []).some((id) => same(id, c._id)),
      );
      return { sort: () => lean(found), select: () => ({ lean: () => Promise.resolve(ofNote) }) };
    },
    // 자동 카드(saveFromQuizSet): _id 하나로 거르는 upsert($setOnInsert)만 흉내 낸다
    bulkWrite: (
      ops: { updateOne: { filter: { _id: Types.ObjectId }; update: { $setOnInsert: Row }; upsert: boolean } }[],
      options: { ordered: boolean; timestamps?: boolean },
    ) => {
      bulkCalls.push({ ops: ops.length, options });
      if (bulkError) return Promise.reject(bulkError);
      for (const { updateOne: op } of ops) {
        if (!op.upsert || cards.some((c) => same(c._id, op.filter._id))) continue;
        cards.push({ ...op.update.$setOnInsert, _id: op.filter._id });
      }
      return Promise.resolve({});
    },
    updateMany: (filter: { _id: { $in: Types.ObjectId[] }; ownerId: Types.ObjectId }, update: { $set: Row }) => {
      for (const c of cards) {
        if (filter._id.$in.some((i) => same(i, c._id)) && same(c['ownerId'], filter.ownerId) && !c['deletedAt']) {
          Object.assign(c, update.$set);
        }
      }
      return Promise.resolve({});
    },
  };
  const setModel = {
    // 자동 카드 저장 전에 세트가 아직 있는지(saveFromQuizSet)
    exists: (filter: { _id: Types.ObjectId; ownerId: Types.ObjectId; deletedAt: null }) =>
      Promise.resolve(
        sets.find((s) => same(s._id, filter._id) && same(s['ownerId'], filter.ownerId) && !s['deletedAt'])
          ? { _id: filter._id }
          : null,
      ),
    findOne: (filter: { ownerId: Types.ObjectId; 'questions._id': Types.ObjectId }) =>
      lean(
        sets.find(
          (s) =>
            same(s['ownerId'], filter.ownerId) &&
            !s['deletedAt'] &&
            (s['questions'] as Row[]).some((q) => same(q._id, filter['questions._id'])),
        ) ?? null,
      ),
  };
  const materialModel = {
    findOne: (filter: { _id: Types.ObjectId; ownerId: Types.ObjectId; deletedAt?: null }) =>
      lean(
        materials.find(
          (m) =>
            same(m._id, filter._id) &&
            same(m['ownerId'], filter.ownerId) &&
            (!('deletedAt' in filter) || !m['deletedAt']),
        ) ?? null,
      ),
  };
  const service = new FlashcardsService(
    cardModel as unknown as never,
    setModel as unknown as never,
    materialModel as unknown as never,
  );
  return {
    cards,
    sets,
    materials,
    service,
    bulkCalls,
    failBulk: (e: unknown) => {
      bulkError = e;
    },
  };
}

describe('플래시카드 서비스', () => {
  const me = new Types.ObjectId().toString();
  const other = new Types.ObjectId().toString();

  const addSet = (
    f: ReturnType<typeof fakeModels>,
    owner: string,
    extra: Record<string, unknown> = {},
  ): { setId: Types.ObjectId; questionId: Types.ObjectId } => {
    const setId = new Types.ObjectId();
    const questionId = new Types.ObjectId();
    f.sets.push({ _id: setId, ownerId: new Types.ObjectId(owner), deletedAt: null, questions: [{ _id: questionId }], ...extra });
    return { setId, questionId };
  };

  it('문제에서 저장하면 세트 · 자료 · 폴더 id가 세트에서 채워진다', async () => {
    const f = fakeModels();
    const materialId = new Types.ObjectId();
    const folderId = new Types.ObjectId();
    const { setId, questionId } = addSet(f, me, { materialId, folderId });

    const card = await f.service.save(me, { front: '핵에 있는 것은?', back: 'DNA', sourceQuestionId: questionId.toString() });

    expect(card).toMatchObject({
      materialId: materialId.toString(),
      folderId: folderId.toString(),
      sourceQuizSetId: setId.toString(),
      sourceQuestionId: questionId.toString(),
      lastResult: null,
      front: '핵에 있는 것은?',
      back: 'DNA',
    });
    expect(f.cards[0]!['ownerId']).toEqual(new Types.ObjectId(me));
  });

  it('세트에 폴더가 없으면 자료의 폴더를 쓴다', async () => {
    const f = fakeModels();
    const materialId = new Types.ObjectId();
    const folderId = new Types.ObjectId();
    f.materials.push({ _id: materialId, ownerId: new Types.ObjectId(me), folderId });
    const { questionId } = addSet(f, me, { materialId });

    const card = await f.service.save(me, { front: 'a', back: 'b', sourceQuestionId: questionId.toString() });

    expect(card.folderId).toBe(folderId.toString());
  });

  it('세트에 자료도 폴더도 없으면 folderId · materialId는 null', async () => {
    const f = fakeModels();
    const { questionId, setId } = addSet(f, me);
    const card = await f.service.save(me, { front: 'a', back: 'b', sourceQuestionId: questionId.toString() });
    expect(card).toMatchObject({ folderId: null, materialId: null, sourceQuizSetId: setId.toString() });
  });

  it('문제 없이 저장하면 세트 · 자료 · 폴더가 모두 null', async () => {
    const f = fakeModels();
    const card = await f.service.save(me, { front: 'a', back: 'b' });
    expect(card).toMatchObject({ materialId: null, folderId: null, sourceQuizSetId: null, sourceQuestionId: null });
    const again = await f.service.save(me, { front: 'a', back: 'b', sourceQuestionId: null });
    expect(again.sourceQuestionId).toBeNull();
  });

  it('남의 세트 문제 · 없는 문제 · 지운 세트의 문제는 404', async () => {
    const f = fakeModels();
    const { questionId } = addSet(f, other);
    const gone = addSet(f, me, { deletedAt: new Date() });

    for (const q of [questionId, new Types.ObjectId(), gone.questionId]) {
      await expect(f.service.save(me, { front: 'a', back: 'b', sourceQuestionId: q.toString() })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    expect(f.cards).toHaveLength(0);
  });

  it('같은 문제로 두 번 저장하면 두 장이 생긴다(앱도 막지 않는다)', async () => {
    const f = fakeModels();
    const { questionId } = addSet(f, me);
    const a = await f.service.save(me, { front: 'a', back: 'b', sourceQuestionId: questionId.toString() });
    const b = await f.service.save(me, { front: 'a', back: 'b', sourceQuestionId: questionId.toString() });
    expect(a._id).not.toBe(b._id);
    expect(await f.service.list(me)).toHaveLength(2);
  });

  it('목록은 내 카드만, 저장한 순서(오래된 것부터)로, 지운 카드는 빼고 준다', async () => {
    const f = fakeModels();
    const a = await f.service.save(me, { front: '1', back: 'a' });
    await f.service.save(other, { front: '남', back: 'x' });
    const b = await f.service.save(me, { front: '2', back: 'b' });
    const c = await f.service.save(me, { front: '3', back: 'c' });

    await f.service.remove(me, [b._id]);

    const list = await f.service.list(me);
    expect(list.map((x) => x._id)).toEqual([a._id, c._id]);
    expect(typeof list[0]!.createdAt).toBe('string');
  });

  it('여러 장을 지우고, 남의 카드 · 없는 id · 형식이 틀린 id가 섞여도 내 것만 지워진다', async () => {
    const f = fakeModels();
    const a = await f.service.save(me, { front: '1', back: 'a' });
    const b = await f.service.save(me, { front: '2', back: 'b' });
    const theirs = await f.service.save(other, { front: '남', back: 'x' });

    await f.service.remove(me, [a._id, b._id, theirs._id, new Types.ObjectId().toString(), 'fc_not-an-id']);

    expect(await f.service.list(me)).toEqual([]);
    expect(await f.service.list(other)).toHaveLength(1);
    await expect(f.service.remove(me, [])).resolves.toBeUndefined();
  });
});

describe('플래시카드 요청 검사(DTO)', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const save = (body: unknown) => pipe.transform(body, { type: 'body', metatype: SaveFlashcardDto });
  const del = (body: unknown) => pipe.transform(body, { type: 'body', metatype: DeleteFlashcardsDto });

  it('앞뒤 공백은 지우고 저장 요청을 받는다', async () => {
    const dto = (await save({ front: ' 앞 ', back: ' 뒤 ', sourceQuestionId: new Types.ObjectId().toString() })) as SaveFlashcardDto;
    expect(dto.front).toBe('앞');
    expect(dto.back).toBe('뒤');
  });

  it('sourceQuestionId는 없어도 null이어도 된다', async () => {
    await expect(save({ front: 'a', back: 'b' })).resolves.toBeDefined();
    await expect(save({ front: 'a', back: 'b', sourceQuestionId: null })).resolves.toBeDefined();
  });

  it.each([
    ['front가 빈 문자열', { front: '', back: 'b' }],
    ['back이 공백뿐', { front: 'a', back: '   ' }],
    ['front가 없음', { back: 'b' }],
    ['front가 문자열이 아님', { front: 1, back: 'b' }],
    ['front가 너무 김', { front: 'a'.repeat(1001), back: 'b' }],
    ['back이 너무 김', { front: 'a', back: 'b'.repeat(2001) }],
    ['sourceQuestionId 형식이 틀림', { front: 'a', back: 'b', sourceQuestionId: 'abc' }],
    ['모르는 필드', { front: 'a', back: 'b', ownerId: 'x' }],
  ])('저장 요청이 잘못되면 400: %s', async (_name, body) => {
    await expect(save(body)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('삭제 요청은 문자열 배열이어야 한다', async () => {
    await expect(del({ ids: [] })).resolves.toBeDefined();
    await expect(del({ ids: ['a', 'b'] })).resolves.toBeDefined();
    for (const n of [201, FLASHCARD_DELETE_MAX]) { // 앱이 한 번에 많이 골라 보내도 된다
      await expect(del({ ids: Array.from({ length: n }, () => 'a') })).resolves.toBeDefined();
    }
    for (const body of [{}, { ids: 'a' }, { ids: [1] }, { ids: Array.from({ length: FLASHCARD_DELETE_MAX + 1 }, () => 'a') }]) {
      await expect(del(body)).rejects.toBeInstanceOf(BadRequestException);
    }
  });
});

describe('플래시카드 스키마', () => {
  it('sourceQuizSetId · sourceQuestionId · folderId · materialId는 필수가 아니고 기본값이 null이다', () => {
    for (const path of ['sourceQuizSetId', 'sourceQuestionId', 'folderId', 'materialId']) {
      const type = FlashcardSchema.path(path);
      expect(type.isRequired, path).toBeFalsy();
      expect((type.options as { default?: unknown }).default, path).toBeNull();
    }
    expect(FlashcardSchema.indexes().some(([keys]) => 'ownerId' in keys && 'deletedAt' in keys && 'createdAt' in keys)).toBe(true);
  });
});

describe('맞춤 퀴즈 개념 카드 저장(saveFromQuizSet, #558)', () => {
  const me = new Types.ObjectId();
  const materialId = new Types.ObjectId();
  const folderId = new Types.ObjectId();
  /** 세트 한 줄. f를 주면 그 가짜 DB에 넣는다(카드는 지우지 않은 세트에만 쓴다) */
  const set = (extra: Record<string, unknown> = {}, f?: ReturnType<typeof fakeModels>) => {
    const row = { _id: new Types.ObjectId(), ownerId: me, materialId, folderId, ...extra };
    f?.sets.push({ ...row, deletedAt: null, questions: [] });
    // 세트의 노트도 지우지 않은 채로 둔다(이미 있으면 그대로)
    const note = row.materialId as Types.ObjectId | null | undefined;
    if (f && note && !f.materials.some((m) => same(m._id, note))) {
      f.materials.push({ _id: note, ownerId: row.ownerId, folderId: null, deletedAt: null });
    }
    return row;
  };
  /** 처리기 result.flashcards 한 장(apps/ai services/quiz/flashcards.py) */
  const card = (n: number, over: Record<string, unknown> = {}) => ({
    front: `용어 ${n}`,
    back: `뜻 ${n}`,
    pageNo: 1,
    concept: `개념 ${n}`,
    ...over,
  });
  const five = () => [1, 2, 3, 4, 5].map((n) => card(n));

  it('카드마다 세트 · 노트 · 폴더를 적어 저장하고, 내 목록에 차례대로 보인다', async () => {
    const f = fakeModels();
    const row = set({}, f);
    await f.service.saveFromQuizSet(row, five());

    const list = await f.service.list(me.toString());
    expect(list.map((c) => [c.front, c.back])).toEqual([1, 2, 3, 4, 5].map((n) => [`용어 ${n}`, `뜻 ${n}`]));
    expect(list[0]).toMatchObject({
      _id: autoCardId(row._id, 0).toString(),
      materialId: materialId.toString(),
      folderId: folderId.toString(),
      sourceQuizSetId: row._id.toString(),
      sourceQuestionId: null,
      lastResult: null,
    });
    expect(f.cards[0]).toMatchObject({ ownerId: me, deletedAt: null });
    // 한 번에 쓰고, 타임스탬프는 처음 넣을 때만(다시 옮길 때 지운 카드의 updatedAt을 바꾸지 않게)
    expect(f.bulkCalls).toEqual([{ ops: 5, options: { ordered: false, timestamps: false } }]);
  });

  it('같은 세트를 여러 번 옮겨도 한 번만 생기고, 지운 카드는 다시 생기지 않는다', async () => {
    const f = fakeModels();
    const row = set({}, f);
    await f.service.saveFromQuizSet(row, five());
    const [first] = await f.service.list(me.toString());
    await f.service.remove(me.toString(), [first!._id]);

    await Promise.all([f.service.saveFromQuizSet(row, five()), f.service.saveFromQuizSet(row, five())]);

    expect(f.cards).toHaveLength(5);
    const list = await f.service.list(me.toString());
    expect(list.map((c) => c.front)).toEqual(['용어 2', '용어 3', '용어 4', '용어 5']);
  });

  it('id는 세트와 순번으로 정해진다: 세트 안에서는 순번 차례, 다른 세트와는 겹치지 않는다', () => {
    const a = set()._id;
    const b = set()._id;
    expect(autoCardId(a, 0).equals(autoCardId(a, 0))).toBe(true);
    const ids = [0, 1, 2, 3, 4].map((i) => autoCardId(a, i).toHexString());
    expect([...ids].sort()).toEqual(ids);
    expect(new Set([...ids, ...[0, 1, 2, 3, 4].map((i) => autoCardId(b, i).toHexString())]).size).toBe(10);
    // 만든 때(앞 4바이트)는 세트와 같다
    expect(autoCardId(a, 3).getTimestamp()).toEqual(a.getTimestamp());
  });

  it('세트에 폴더가 없으면 노트의 폴더, 노트도 없으면 null', async () => {
    const f = fakeModels();
    const other = new Types.ObjectId();
    f.materials.push({ _id: materialId, ownerId: me, folderId: other });
    await f.service.saveFromQuizSet(set({ folderId: undefined }, f), [card(1)]);
    await f.service.saveFromQuizSet(set({ folderId: null, materialId: null }, f), [card(2)]);
    const list = await f.service.list(me.toString());
    expect(list.map((c) => [c.folderId, c.materialId])).toEqual([
      [other.toString(), materialId.toString()],
      [null, null],
    ]);
  });

  it('모양이 틀린 카드는 빼고 나머지만 저장한다(앞뒤 공백 지움, 순번은 처리기 차례 그대로)', async () => {
    const f = fakeModels();
    const row = set({}, f);
    await f.service.saveFromQuizSet(row, [
      card(1, { front: '  앞  ', back: ' 뒤 ' }),
      null,
      card(3, { front: '   ' }),
      card(4, { back: 7 }),
      card(5, { front: 'a'.repeat(1001) }),
      card(6, { back: 'b'.repeat(2001) }),
      card(7),
    ]);
    expect(f.cards.map((c) => [String(c._id), c['front'], c['back']])).toEqual([
      [autoCardId(row._id, 0).toString(), '앞', '뒤'],
      [autoCardId(row._id, 6).toString(), '용어 7', '뜻 7'],
    ]);
  });

  it(`한 세트에서 ${AUTO_CARD_MAX}장까지만, 배열이 아니거나 비면 쓰지 않는다`, async () => {
    const f = fakeModels();
    await f.service.saveFromQuizSet(set({}, f), Array.from({ length: AUTO_CARD_MAX + 3 }, (_, i) => card(i)));
    expect(f.cards).toHaveLength(AUTO_CARD_MAX);
    for (const raw of [undefined, null, '카드', {}, []]) await f.service.saveFromQuizSet(set({}, f), raw);
    expect(f.bulkCalls).toHaveLength(1);
  });

  it('동시에 옮기다 같은 id가 먼저 들어간 것(중복 키)만 넘어가고, 다른 오류는 올린다', async () => {
    const f = fakeModels();
    const dup = new mongo.MongoBulkWriteError(
      { message: 'E11000', code: 11000, writeErrors: [{ code: 11000 }, { code: 11000 }] } as never,
      {} as never,
    );
    f.failBulk(dup);
    await expect(f.service.saveFromQuizSet(set({}, f), five())).resolves.toBeUndefined();

    const other = new mongo.MongoBulkWriteError(
      { message: 'mixed', code: 11000, writeErrors: [{ code: 11000 }, { code: 121 }] } as never,
      {} as never,
    );
    f.failBulk(other);
    await expect(f.service.saveFromQuizSet(set({}, f), five())).rejects.toBe(other);
    const down = new Error('network');
    f.failBulk(down);
    await expect(f.service.saveFromQuizSet(set({}, f), five())).rejects.toBe(down);
  });

  it('같은 노트의 다른 세트에 앞면이 같은 카드가 있으면(지운 카드 포함) 빼고 쓴다', async () => {
    const f = fakeModels();
    const first = set({}, f);
    await f.service.saveFromQuizSet(first, [card(1), card(2)]);
    const [one] = await f.service.list(me.toString());
    await f.service.remove(me.toString(), [one!._id]); // 지운 카드도 다시 만들지 않는다

    const second = set({}, f);
    await f.service.saveFromQuizSet(second, [card(1, { front: '용어1' }), card(2, { front: ' 용어 2 ' }), card(3)]);

    expect(f.cards.map((c) => [c['front'], String(c['sourceQuizSetId'])])).toEqual([
      ['용어 1', String(first._id)],
      ['용어 2', String(first._id)],
      ['용어 3', String(second._id)],
    ]);
    // 다른 노트의 카드와는 비교하지 않는다
    await f.service.saveFromQuizSet(set({ materialId: new Types.ObjectId() }, f), [card(1)]);
    expect(f.cards).toHaveLength(4);
  });

  it('그 사이 노트를 지웠으면 쓰지 않는다(노트 · 폴더 지우기는 세트를 건드리지 않음)', async () => {
    const f = fakeModels();
    const row = set({}, f);
    f.materials.find((m) => same(m._id, materialId))!['deletedAt'] = new Date();
    await f.service.saveFromQuizSet(row, five());
    expect(f.cards).toHaveLength(0);
  });

  it('그 사이 지운 세트 · 남의 세트에는 쓰지 않는다', async () => {
    const f = fakeModels();
    const gone = set({}, f);
    f.sets[f.sets.length - 1]!['deletedAt'] = new Date();
    await f.service.saveFromQuizSet(gone, five());
    await f.service.saveFromQuizSet(set(), five()); // DB에 없는 세트
    await f.service.saveFromQuizSet({ ...set({}, f), ownerId: new Types.ObjectId() }, five());
    expect(f.cards).toHaveLength(0);
    expect(f.bulkCalls).toHaveLength(0);
  });
});
