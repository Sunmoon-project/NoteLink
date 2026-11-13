// 진짜 MongoDB에서 플래시카드 저장 · 조회 · 삭제를 확인하는 테스트(스키마 변경 포함).
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 파일·실행마다 고유한 전용 DB(notelink_verify_flashcards_<pid>_<시각>)만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/flashcards-real-db.test.ts
import { NotFoundException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test, type TestingModule } from '@nestjs/testing';
import { Flashcard as SharedFlashcard } from '@notelink/shared';
import { Types, type Connection } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { FlashcardsService } from '../src/modules/quiz/flashcards.service.js';
import { Flashcard, FlashcardSchema } from '../src/modules/quiz/schemas/flashcard.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_flashcards_${process.pid}_${Date.now()}`;

describe.skipIf(!uri)('진짜 DB 플래시카드 확인', () => {
  let moduleRef: TestingModule;
  let conn: Connection;
  let service: FlashcardsService;
  const col = (name: string) => conn.collection(name);
  let nicknameSeq = 0;

  // users는 nickname 유일 인덱스가 있어서 사람마다 다른 닉네임을 넣는다
  const newUser = async (): Promise<string> => {
    const userId = new Types.ObjectId();
    await col('users').insertOne({ _id: userId, nickname: `flashcard-user-${nicknameSeq++}` });
    return userId.toString();
  };

  beforeAll(async () => {
    if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
    moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
        MongooseModule.forFeature([
          { name: Flashcard.name, schema: FlashcardSchema },
          { name: QuizSet.name, schema: QuizSetSchema },
          { name: Material.name, schema: MaterialSchema },
          { name: User.name, schema: UserSchema },
        ]),
      ],
      providers: [FlashcardsService],
    }).compile();
    await moduleRef.init();
    conn = moduleRef.get<Connection>(getConnectionToken());
    await conn.dropDatabase();
    await Promise.all([
      conn.model(Flashcard.name).init(),
      conn.model(QuizSet.name).init(),
      conn.model(Material.name).init(),
      conn.model(User.name).init(),
    ]);
    service = moduleRef.get(FlashcardsService);
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.dropDatabase();
    await moduleRef?.close();
  });

  const addSet = async (owner: string, extra: Record<string, unknown> = {}) => {
    const questionId = new Types.ObjectId();
    const set = await col('quiz_sets').insertOne({
      ownerId: new Types.ObjectId(owner),
      source: 'ai_generated',
      title: '세포',
      status: 'ready',
      deletedAt: null,
      questions: [{ _id: questionId, order: 0, type: 'short_answer', prompt: '핵에 있는 것은?', answer: 'DNA' }],
      ...extra,
    });
    return { setId: set.insertedId, questionId };
  };

  it('문제에서 저장하면 세트 · 자료 · 폴더 id가 채워진다(세트에 폴더가 있을 때)', async () => {
    const me = await newUser();
    const materialId = new Types.ObjectId();
    const folderId = new Types.ObjectId();
    const { setId, questionId } = await addSet(me, { materialId, folderId });

    const card = await service.save(me, { front: '핵에 있는 것은?', back: 'DNA', sourceQuestionId: questionId.toString() });

    expect(card).toMatchObject({
      materialId: materialId.toString(),
      folderId: folderId.toString(),
      sourceQuizSetId: setId.toString(),
      sourceQuestionId: questionId.toString(),
    });
    const row = await col('flashcards').findOne({ _id: new Types.ObjectId(card._id) });
    expect(row).toMatchObject({ ownerId: new Types.ObjectId(me), deletedAt: null, lastResult: null });
    expect(SharedFlashcard.safeParse(card).success).toBe(true);
  });

  it('세트에 폴더가 없으면 자료(materials)의 폴더를 쓴다', async () => {
    const me = await newUser();
    const folderId = new Types.ObjectId();
    const material = await col('materials').insertOne({ ownerId: new Types.ObjectId(me), folderId, title: '노트', deletedAt: null });
    const { questionId } = await addSet(me, { materialId: material.insertedId });

    const card = await service.save(me, { front: 'a', back: 'b', sourceQuestionId: questionId.toString() });

    expect(card.folderId).toBe(folderId.toString());
    expect(card.materialId).toBe(material.insertedId.toString());
  });

  it('앱이 보내는 null 값들(문제 · 세트 · 자료 · 폴더 없음)로 실제로 저장된다', async () => {
    const me = await newUser();
    const card = await service.save(me, { front: '앞', back: '뒤', sourceQuestionId: null });

    expect(card).toMatchObject({ materialId: null, folderId: null, sourceQuizSetId: null, sourceQuestionId: null, lastResult: null });
    const row = await col('flashcards').findOne({ _id: new Types.ObjectId(card._id) });
    expect(row).toMatchObject({ materialId: null, folderId: null, sourceQuizSetId: null, sourceQuestionId: null });
    // 문제 없이 만든 카드는 아직 shared Flashcard.folderId(null 불가)와 맞지 않는다: 폴더 API 이후 shared 쪽을 정한다
    expect(await service.list(me)).toHaveLength(1);
  });

  it('남의 세트 문제 · 없는 문제는 404이고 카드가 생기지 않는다', async () => {
    const me = await newUser();
    const other = await newUser();
    const theirs = await addSet(other);

    for (const q of [theirs.questionId, new Types.ObjectId()]) {
      await expect(service.save(me, { front: 'a', back: 'b', sourceQuestionId: q.toString() })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    }
    expect(await col('flashcards').countDocuments({ ownerId: new Types.ObjectId(me) })).toBe(0);
  });

  it('같은 문제로 두 번 저장하면 두 장이 생긴다', async () => {
    const me = await newUser();
    const { questionId } = await addSet(me);
    await service.save(me, { front: 'a', back: 'b', sourceQuestionId: questionId.toString() });
    await service.save(me, { front: 'a', back: 'b', sourceQuestionId: questionId.toString() });
    expect(await service.list(me)).toHaveLength(2);
  });

  it('목록은 내 카드만, 저장한 순서로, 지운 카드는 빼고 준다', async () => {
    const me = await newUser();
    const other = await newUser();
    const a = await service.save(me, { front: '1', back: 'a' });
    await service.save(other, { front: '남', back: 'x' });
    const b = await service.save(me, { front: '2', back: 'b' });
    const c = await service.save(me, { front: '3', back: 'c' });
    expect((await service.list(me)).map((x) => x._id)).toEqual([a._id, b._id, c._id]);

    await service.remove(me, [b._id]);

    expect((await service.list(me)).map((x) => x._id)).toEqual([a._id, c._id]);
    const row = await col('flashcards').findOne({ _id: new Types.ObjectId(b._id) });
    expect(row?.['deletedAt']).toBeInstanceOf(Date); // 소프트 삭제: 문서는 남는다
  });

  it('여러 장을 지우고, 남의 카드 id가 섞여도 내 것만 지워진다', async () => {
    const me = await newUser();
    const other = await newUser();
    const mine = [await service.save(me, { front: '1', back: 'a' }), await service.save(me, { front: '2', back: 'b' })];
    const theirs = await service.save(other, { front: '남', back: 'x' });

    await service.remove(me, [...mine.map((m) => m._id), theirs._id, new Types.ObjectId().toString()]);

    expect(await service.list(me)).toEqual([]);
    expect(await service.list(other)).toHaveLength(1);
    expect((await col('flashcards').findOne({ _id: new Types.ObjectId(theirs._id) }))?.['deletedAt']).toBeNull();
  });
});
