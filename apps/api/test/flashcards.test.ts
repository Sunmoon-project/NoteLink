import { BadRequestException, NotFoundException, ValidationPipe } from '@nestjs/common';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { DeleteFlashcardsDto, SaveFlashcardDto } from '../src/modules/quiz/dto/flashcard.dto.js';
import { FlashcardsService } from '../src/modules/quiz/flashcards.service.js';
import { FlashcardSchema } from '../src/modules/quiz/schemas/flashcard.schema.js';

type Row = Record<string, unknown> & { _id: Types.ObjectId };
const same = (a: unknown, b: unknown) => String(a) === String(b);

/** 서비스가 쓰는 질의만 흉내 내는 작은 메모리 모델 */
function fakeModels() {
  const cards: Row[] = [];
  const sets: Row[] = [];
  const materials: Row[] = [];
  let clock = 0;
  const lean = <T>(value: T) => ({ lean: () => Promise.resolve(value), select: () => ({ lean: () => Promise.resolve(value) }) });

  const cardModel = {
    create: (data: Record<string, unknown>) => {
      const row: Row = { createdAt: new Date(Date.UTC(2026, 10, 8, 0, 0, clock++)), ...data, _id: new Types.ObjectId() };
      cards.push(row);
      return Promise.resolve({ toObject: () => row });
    },
    find: (filter: { ownerId: Types.ObjectId; deletedAt: null }) => {
      const found = cards
        .filter((c) => same(c['ownerId'], filter.ownerId) && (c['deletedAt'] ?? null) === null)
        .sort((a, b) => (a['createdAt'] as Date).getTime() - (b['createdAt'] as Date).getTime());
      return { sort: () => lean(found) };
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
    findOne: (filter: { _id: Types.ObjectId; ownerId: Types.ObjectId }) =>
      lean(materials.find((m) => same(m._id, filter._id) && same(m['ownerId'], filter.ownerId)) ?? null),
  };
  const service = new FlashcardsService(
    cardModel as unknown as never,
    setModel as unknown as never,
    materialModel as unknown as never,
  );
  return { cards, sets, materials, service };
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
    for (const body of [{}, { ids: 'a' }, { ids: [1] }, { ids: Array.from({ length: 201 }, () => 'a') }]) {
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
