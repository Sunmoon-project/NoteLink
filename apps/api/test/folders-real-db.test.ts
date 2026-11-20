// 진짜 MongoDB에서 폴더 목록의 자료 수 집계 · 색인, 폴더 삭제 트랜잭션을 보는 테스트(삭제는 replica set 필요).
// 폴더 삭제가 그 폴더의 퀴즈 세트 · 플래시카드 · 보관함 항목을 같이 지우고 퀴즈 AI 작업을 취소하는지도 본다(#602).
// MONGODB_VERIFY_URI가 있을 때만 돌고(없으면 건너뜀), localhost가 아니면 거부한다. 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/folders-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import { FoldersService } from '../src/modules/content/folders/folders.service.js';
import { Folder, FolderSchema } from '../src/modules/content/schemas/folder.schema.js';
import { Material, MaterialSchema } from '../src/modules/content/schemas/material.schema.js';
import { FlashcardsService } from '../src/modules/quiz/flashcards.service.js';
import { QuizBoxService } from '../src/modules/quiz/quiz-box.service.js';
import { AiJob, AiJobSchema } from '../src/modules/quiz/schemas/ai-job.schema.js';
import { Flashcard, FlashcardSchema } from '../src/modules/quiz/schemas/flashcard.schema.js';
import { QuizAttempt, QuizAttemptSchema } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import {
  QuizBoxCounter,
  QuizBoxCounterSchema,
} from '../src/modules/quiz/schemas/quiz-box-counter.schema.js';
import {
  QuizBoxItem,
  QuizBoxItemSchema,
} from '../src/modules/quiz/schemas/quiz-box-item.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';
import { QuizCleanupService } from '../src/quiz-sets/quiz-cleanup.service.js';
import { QuizSetsService } from '../src/quiz-sets/quiz-sets.service.js';
import { RecordingNotePagesService } from '../src/quiz-sets/recording-note-pages.service.js';
import { SimilarQuizService } from '../src/quiz-sets/similar-quiz.service.js';
import { TodayReviewService } from '../src/quiz-sets/today-review.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_folders_${process.pid}_${Date.now()}`;

/** 실행 계획에서 쓰인 단계 이름을 모두 모은다 */
function stages(plan: unknown, found: string[] = []): string[] {
  if (plan && typeof plan === 'object') {
    for (const [key, value] of Object.entries(plan)) {
      if (key === 'stage' && typeof value === 'string') found.push(value);
      else stages(value, found);
    }
  }
  return found;
}

describe.skipIf(!uri)('진짜 DB 학습 폴더 확인', () => {
  let conn: Connection;
  let service: FoldersService;
  let materials: Model<Material>;
  let cards: Model<Flashcard>;
  let setsModel: Model<QuizSet>;
  let cleanup: QuizCleanupService;
  let quizSets: QuizSetsService;
  let recordingPages: RecordingNotePagesService;
  let flashcards: FlashcardsService;
  let quizBox: QuizBoxService;
  let today: TodayReviewService;
  let similar: SimilarQuizService;
  let aiJobs: AiJobsService;
  const me = new Types.ObjectId();
  const other = new Types.ObjectId();

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    const folders = conn.model(Folder.name, FolderSchema) as unknown as Model<Folder>;
    materials = conn.model(Material.name, MaterialSchema) as unknown as Model<Material>;
    const subjects = conn.model(Subject.name, SubjectSchema) as unknown as Model<Subject>;
    const sets = conn.model(QuizSet.name, QuizSetSchema) as unknown as Model<QuizSet>;
    setsModel = sets;
    cards = conn.model(Flashcard.name, FlashcardSchema) as unknown as Model<Flashcard>;
    const items = conn.model(QuizBoxItem.name, QuizBoxItemSchema) as unknown as Model<QuizBoxItem>;
    const counters = conn.model(
      QuizBoxCounter.name,
      QuizBoxCounterSchema,
    ) as unknown as Model<QuizBoxCounter>;
    const jobs = conn.model(AiJob.name, AiJobSchema) as unknown as Model<AiJob>;
    const attempts = conn.model(
      QuizAttempt.name,
      QuizAttemptSchema,
    ) as unknown as Model<QuizAttempt>;
    await Promise.all(
      [folders, materials, sets, cards, items, counters, jobs, attempts].map((m) =>
        (m as unknown as Model<unknown>).syncIndexes(),
      ),
    );
    await conn.collection('subjects').insertOne({ name: '수학', color: '#000000', isActive: true });
    aiJobs = new AiJobsService(jobs as never);
    cleanup = new QuizCleanupService(sets as never, cards as never, items, aiJobs);
    service = new FoldersService(folders, materials, subjects, conn, cleanup);
    recordingPages = new RecordingNotePagesService(jobs as never);
    quizSets = new QuizSetsService(
      sets as never,
      materials as never,
      attempts as never,
      aiJobs,
      recordingPages,
      folders as never,
    );
    flashcards = new FlashcardsService(
      cards as never,
      sets as never,
      materials as never,
      jobs as never,
    );
    quizBox = new QuizBoxService(items, counters, sets, conn);
    today = new TodayReviewService(
      sets as never,
      attempts as never,
      materials as never,
      aiJobs,
      quizSets,
      recordingPages,
    );
    similar = new SimilarQuizService(
      sets as never,
      attempts as never,
      materials as never,
      aiJobs,
      quizSets,
      recordingPages,
    );
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  const material = (folderId: string, over: Record<string, unknown> = {}) => ({
    ownerId: me,
    folderId: new Types.ObjectId(folderId),
    deletedAt: null,
    ...over,
  });

  it('만들고 목록을 읽는다: 과목 ID · 최근에 바뀐 순 · 지우지 않은 내 자료 수', async () => {
    const math = await service.create(me.toHexString(), { title: ' 미적분 ', subjectName: '수학' });
    const etc = await service.create(me.toHexString(), { title: '운영체제', subjectName: '기타' });
    await service.create(other.toHexString(), { title: '남의 폴더', subjectName: '수학' });
    expect(math.subjectId).toMatch(/^[0-9a-f]{24}$/);
    expect(etc).toMatchObject({ subjectId: null, subjectName: '기타' });

    await conn
      .collection('materials')
      .insertMany([
        material(math._id),
        material(math._id),
        material(math._id, { deletedAt: new Date() }),
        material(math._id, { ownerId: other }),
      ]);

    const list = await service.list(me.toHexString());

    expect(list.map((f) => [f.title, f.materialCount])).toEqual([
      ['운영체제', 0],
      ['미적분', 2],
    ]);
    expect(list[1]).toMatchObject({
      _id: math._id,
      subjectId: math.subjectId,
      subjectName: '수학',
    });
  });

  it('자료 수 집계는 컬렉션 전체를 훑지 않고 색인을 쓴다', async () => {
    const ids = [new Types.ObjectId(), new Types.ObjectId()];
    const plan = await materials
      .aggregate([
        { $match: { ownerId: me, folderId: { $in: ids }, deletedAt: null } },
        { $group: { _id: '$folderId', count: { $sum: 1 } } },
      ])
      .explain('queryPlanner');

    const used = stages(plan);
    expect(used).toContain('IXSCAN');
    expect(used).not.toContain('COLLSCAN');
  });
  describe('폴더 삭제 (트랜잭션)', () => {
    const folderRow = async (id: string) =>
      conn.collection('folders').findOne({ _id: new Types.ObjectId(id) });
    const materialRow = (id: unknown) =>
      conn.collection('materials').findOne({ _id: id as Types.ObjectId });

    it('폴더와 안의 지우지 않은 노트를 함께 지운다. 이미 지운 노트의 시각 · 다른 폴더 · 남의 노트는 그대로', async () => {
      const target = await service.create(me.toHexString(), {
        title: '지울 폴더',
        subjectName: '수학',
      });
      const keep = await service.create(me.toHexString(), {
        title: '남길 폴더',
        subjectName: '수학',
      });
      const longAgo = new Date('2026-01-01T00:00:00.000Z');
      const inserted = await conn
        .collection('materials')
        .insertMany([
          material(target._id),
          material(target._id),
          material(target._id, { deletedAt: longAgo }),
          material(keep._id),
          material(target._id, { ownerId: other }),
        ]);
      const ids = Object.values(inserted.insertedIds);

      await service.remove(me.toHexString(), target._id);

      expect((await folderRow(target._id))?.deletedAt).toBeInstanceOf(Date);
      expect((await materialRow(ids[0]))?.deletedAt).toBeInstanceOf(Date);
      expect((await materialRow(ids[1]))?.deletedAt).toBeInstanceOf(Date);
      expect((await materialRow(ids[2]))?.deletedAt).toEqual(longAgo);
      expect((await materialRow(ids[3]))?.deletedAt).toBeNull();
      expect((await materialRow(ids[4]))?.deletedAt).toBeNull();
      expect((await folderRow(keep._id))?.deletedAt).toBeNull();
      // 목록에서도 사라진다
      const titles = (await service.list(me.toHexString())).map((f) => f.title);
      expect(titles).toContain('남길 폴더');
      expect(titles).not.toContain('지울 폴더');
    });

    it('노트를 지우다 실패하면 폴더도 지워지지 않는다(롤백)', async () => {
      const f = await service.create(me.toHexString(), { title: '롤백 폴더', subjectName: '수학' });
      const inserted = await conn.collection('materials').insertOne(material(f._id));
      const spy = vi.spyOn(materials, 'updateMany').mockRejectedValueOnce(new Error('boom'));

      await expect(service.remove(me.toHexString(), f._id)).rejects.toThrow('boom');

      spy.mockRestore();
      expect((await folderRow(f._id))?.deletedAt).toBeNull();
      expect((await materialRow(inserted.insertedId))?.deletedAt).toBeNull();
    });

    it('남의 폴더 · 지운 폴더 · 없는 폴더 · 잘못된 id 는 404이고 아무것도 바꾸지 않는다', async () => {
      const theirs = await service.create(other.toHexString(), {
        title: '남의 폴더',
        subjectName: '수학',
      });
      const inserted = await conn
        .collection('materials')
        .insertOne(material(theirs._id, { ownerId: other }));
      const mine = await service.create(me.toHexString(), {
        title: '이미 지움',
        subjectName: '수학',
      });
      await service.remove(me.toHexString(), mine._id);

      for (const id of [theirs._id, mine._id, new Types.ObjectId().toHexString(), 'nope', '../x']) {
        await expect(service.remove(me.toHexString(), id)).rejects.toMatchObject({
          status: 404,
          response: { code: 'NOT_FOUND' },
        });
      }
      expect((await folderRow(theirs._id))?.deletedAt).toBeNull();
      expect((await materialRow(inserted.insertedId))?.deletedAt).toBeNull();
    });
  });
  describe('폴더 삭제 — 그 폴더의 퀴즈 · 플래시카드 · 보관함 항목도 같이 지우기 (#602)', () => {
    const col = (name: string) => conn.collection(name);
    const row = (name: string, id: Types.ObjectId) => col(name).findOne({ _id: id });
    const question = (prompt: string) => ({
      _id: new Types.ObjectId(),
      order: 1,
      type: 'multiple_choice',
      prompt,
      choices: ['가', '나', '다', '라', '마'],
      answer: '가',
      explanation: null,
      conceptTags: [],
      srs: { state: 'active', dueAt: new Date('2026-01-01T00:00:00.000Z') },
    });
    const quizSet = (over: Record<string, unknown>) => ({
      _id: new Types.ObjectId(),
      ownerId: me,
      source: 'ai_generated',
      sourceSetId: null,
      title: '세트',
      status: 'ready',
      progress: 100,
      questionCount: 1,
      questions: [question('문제')],
      jobId: null,
      deletedAt: null,
      createdAt: new Date('2026-11-19T00:00:00.000Z'),
      ...over,
    });
    const card = (over: Record<string, unknown>) => ({
      _id: new Types.ObjectId(),
      ownerId: me,
      front: '앞',
      back: '뒤',
      materialId: null,
      folderId: null,
      sourceQuizSetId: null,
      sourceQuestionId: null,
      lastResult: null,
      deletedAt: null,
      createdAt: new Date('2026-11-19T00:00:00.000Z'),
      ...over,
    });
    const job = (over: Record<string, unknown>) => ({
      _id: new Types.ObjectId(),
      userId: me,
      status: 'queued',
      progress: 0,
      input: {},
      createdAt: new Date('2026-11-19T00:00:00.000Z'),
      ...over,
    });
    const boxItem = (userId: Types.ObjectId, set: ReturnType<typeof quizSet>, order: number) => ({
      _id: new Types.ObjectId(),
      userId,
      questionId: set.questions[0]!._id,
      quizSetId: set._id,
      savedAt: new Date('2026-11-19T00:00:00.000Z'),
      order,
    });

    /** 지울 폴더 · 남길 폴더와 그 안의 노트 · 세트 · 카드 · 보관함 · 풀이 · 작업(남의 것 포함) */
    let days = 0;
    async function seed() {
      const target = await service.create(me.toHexString(), {
        title: '지울 폴더',
        subjectName: '수학',
      });
      const keep = await service.create(me.toHexString(), {
        title: '남길 폴더',
        subjectName: '수학',
      });
      const targetId = new Types.ObjectId(target._id);
      const keepId = new Types.ObjectId(keep._id);
      const note = new Types.ObjectId();
      const oldNote = new Types.ObjectId(); // 전에 지운 노트(세트는 아직 살아 있음)
      const keepNote = new Types.ObjectId();
      await col('materials').insertMany([
        { _id: note, ownerId: me, folderId: targetId, deletedAt: null },
        {
          _id: oldNote,
          ownerId: me,
          folderId: targetId,
          deletedAt: new Date('2026-11-01T00:00:00.000Z'),
        },
        { _id: keepNote, ownerId: me, folderId: keepId, deletedAt: null },
      ]);
      const sets = {
        ready: quizSet({ materialId: note, folderId: targetId }),
        // 오답 복습 세트(만드는 중)
        similar: quizSet({
          materialId: note,
          folderId: targetId,
          status: 'generating',
          questions: [question('만드는 중')],
        }),
        // 폴더 id 가 없는 옛 세트: 노트 id 로 찾는다
        noFolder: quizSet({ materialId: oldNote }),
        keep: quizSet({ materialId: keepNote, folderId: keepId }),
        // 오늘의 복습: 여러 폴더 문제를 섞어 지우지 않는다(첫 문제가 지울 폴더여도)
        // (오늘의 복습은 사용자 · 날짜마다 하나라 시험마다 날짜를 달리 한다)
        today: quizSet({
          materialId: note,
          folderId: targetId,
          reviewDay: `2026-10-${String(++days).padStart(2, '0')}`,
        }),
        // 남의 세트(같은 폴더 id 를 가리켜도 주인이 다르면 그대로)
        theirs: quizSet({ ownerId: other, materialId: note, folderId: targetId }),
      };
      // 오늘의 복습에서 이어 만든 오답 복습(첫 문제의 폴더 값을 물려받음)도 남긴다(code-review 2차)
      const fromToday = quizSet({
        materialId: note,
        folderId: targetId,
        sourceSetId: sets.today._id,
      });
      await col('quiz_sets').insertMany([...Object.values(sets), fromToday]);
      const cardRows = {
        byFolder: card({ folderId: targetId, materialId: note, sourceQuizSetId: sets.ready._id }),
        byNote: card({ materialId: oldNote }),
        manual: card({}), // 출처 없이 만든 카드
        // 오늘의 복습 문제로 저장한 카드(다른 폴더 문제일 수 있음, code-review 2차)
        fromToday: card({ folderId: targetId, materialId: note, sourceQuizSetId: sets.today._id }),
        keep: card({ folderId: keepId, materialId: keepNote }),
        theirs: card({ ownerId: other, folderId: targetId, materialId: note }),
      };
      await col('flashcards').insertMany(Object.values(cardRows));
      const box = {
        ready: boxItem(me, sets.ready, 1),
        noFolder: boxItem(me, sets.noFolder, 2),
        keep: boxItem(me, sets.keep, 3),
        today: boxItem(me, sets.today, 4),
        theirs: boxItem(other, sets.theirs, 1),
      };
      await col('quiz_box_items').insertMany(Object.values(box));
      const attempt = {
        _id: new Types.ObjectId(),
        userId: me,
        quizSetId: sets.ready._id,
        answers: [{ questionId: sets.ready.questions[0]!._id, answer: '가', correct: true }],
        finishedAt: new Date('2026-11-19T01:00:00.000Z'),
      };
      await col('quiz_attempts').insertOne(attempt);
      const jobs = {
        similar: job({
          type: 'similar_quiz',
          targetType: 'quiz_set',
          targetId: sets.similar._id,
          status: 'running',
        }),
        cards: job({
          type: 'quiz_flashcards',
          targetType: 'quiz_set',
          targetId: sets.ready._id,
          status: 'held',
          heldAt: new Date(),
        }),
        pregen: job({
          type: 'quiz_pregen',
          targetType: 'material',
          targetId: note,
          awaited: false,
        }),
        done: job({
          type: 'quiz_generate',
          targetType: 'quiz_set',
          targetId: sets.ready._id,
          status: 'succeeded',
        }),
        // 노트 정리(요약) 작업은 이번 범위 밖
        summary: job({ type: 'material_summary', targetType: 'material', targetId: note }),
        keep: job({ type: 'quiz_generate', targetType: 'quiz_set', targetId: sets.keep._id }),
        today: job({
          type: 'today_review',
          targetType: 'quiz_set',
          targetId: sets.today._id,
          status: 'running',
        }),
        theirs: job({ userId: other, type: 'quiz_pregen', targetType: 'material', targetId: note }),
      };
      await col('ai_jobs').insertMany(Object.values(jobs));
      return {
        target,
        targetId,
        keepId,
        note,
        sets,
        fromToday,
        cards: cardRows,
        box,
        attempt,
        jobs,
      };
    }

    it('그 폴더의 세트 · 카드는 폴더와 같은 시각으로 지우고, 보관함 항목은 없애고, 진행 중인 퀴즈 작업은 취소한다. 풀이 기록은 남는다', async () => {
      const s = await seed();

      await service.remove(me.toHexString(), s.target._id);

      const deletedAt = (await row('folders', s.targetId))?.deletedAt as Date;
      expect(deletedAt).toBeInstanceOf(Date);
      for (const set of [s.sets.ready, s.sets.similar, s.sets.noFolder]) {
        expect((await row('quiz_sets', set._id))?.deletedAt).toEqual(deletedAt);
      }
      for (const c of [s.cards.byFolder, s.cards.byNote]) {
        expect((await row('flashcards', c._id))?.deletedAt).toEqual(deletedAt);
      }
      expect(await row('quiz_box_items', s.box.ready._id)).toBeNull();
      expect(await row('quiz_box_items', s.box.noFolder._id)).toBeNull();
      expect(await row('quiz_attempts', s.attempt._id)).toMatchObject({
        quizSetId: s.sets.ready._id,
      });
      // 진행 중인 퀴즈 작업은 취소(미리 만들기 · held 포함), 끝난 작업 · 요약 작업은 그대로
      expect((await row('ai_jobs', s.jobs.similar._id))?.status).toBe('canceled');
      const held = await row('ai_jobs', s.jobs.cards._id);
      expect(held?.status).toBe('canceled');
      expect(held?.heldAt).toBeUndefined();
      expect((await row('ai_jobs', s.jobs.pregen._id))?.status).toBe('canceled');
      expect((await row('ai_jobs', s.jobs.done._id))?.status).toBe('succeeded');
      expect((await row('ai_jobs', s.jobs.summary._id))?.status).toBe('queued');
    });

    it('퀴즈 목록 · 플래시카드 · 보관함 · 오늘의 복습 입력에서 그 폴더의 퀴즈가 빠진다', async () => {
      const s = await seed();

      await service.remove(me.toHexString(), s.target._id);

      const listed = (await quizSets.list(me.toHexString())).map((x) => x._id);
      expect(listed).not.toContain(String(s.sets.ready._id));
      expect(listed).not.toContain(String(s.sets.similar._id));
      expect(listed).not.toContain(String(s.sets.noFolder._id));
      expect(listed).toContain(String(s.sets.keep._id));

      const cardIds = (await flashcards.list(me.toHexString())).map((c) => c._id);
      expect(cardIds).not.toContain(String(s.cards.byFolder._id));
      expect(cardIds).not.toContain(String(s.cards.byNote._id));
      expect(cardIds).toEqual(
        expect.arrayContaining([String(s.cards.manual._id), String(s.cards.keep._id)]),
      );

      const boxed = (await quizBox.box(me.toHexString())).map((x) => x._id);
      expect(boxed).not.toContain(String(s.sets.ready.questions[0]!._id));
      expect(boxed).not.toContain(String(s.sets.noFolder.questions[0]!._id));
      expect(boxed).toContain(String(s.sets.keep.questions[0]!._id));

      // 오늘의 복습 처리기는 지운 세트(deletedAt)의 문제를 내지 않는다(apps/ai today.py)
      const input = await (
        today as unknown as {
          input: (
            o: Types.ObjectId,
            d: string,
          ) => Promise<{ sets: { id: string; deletedAt?: string }[] }>;
        }
      ).input(me, '2026-11-20');
      const byId = new Map(input.sets.map((x) => [x.id, x]));
      expect(byId.get(String(s.sets.ready._id))?.deletedAt).toEqual(expect.any(String));
      expect(byId.get(String(s.sets.keep._id))).toBeDefined();
      expect(byId.get(String(s.sets.keep._id))?.deletedAt).toBeUndefined();
    });

    it('다른 폴더 · 남의 데이터 · 오늘의 복습 세트는 그대로다', async () => {
      const s = await seed();

      await service.remove(me.toHexString(), s.target._id);

      for (const set of [s.sets.keep, s.sets.today, s.fromToday, s.sets.theirs]) {
        expect((await row('quiz_sets', set._id))?.deletedAt).toBeNull();
      }
      for (const c of [s.cards.manual, s.cards.keep, s.cards.fromToday, s.cards.theirs]) {
        expect((await row('flashcards', c._id))?.deletedAt).toBeNull();
      }
      for (const b of [s.box.keep, s.box.today, s.box.theirs]) {
        expect(await row('quiz_box_items', b._id)).not.toBeNull();
      }
      for (const j of [s.jobs.keep, s.jobs.theirs]) {
        expect((await row('ai_jobs', j._id))?.status).toBe('queued');
      }
      expect((await row('ai_jobs', s.jobs.today._id))?.status).toBe('running');
      expect((await row('folders', s.keepId))?.deletedAt).toBeNull();
    });

    it('카드를 지우다 실패하면 폴더 · 노트 · 세트 · 보관함 · 작업이 모두 그대로다(롤백)', async () => {
      const s = await seed();
      const spy = vi.spyOn(cards, 'updateMany').mockRejectedValueOnce(new Error('boom'));

      await expect(service.remove(me.toHexString(), s.target._id)).rejects.toThrow('boom');

      spy.mockRestore();
      expect((await row('folders', s.targetId))?.deletedAt).toBeNull();
      expect((await row('materials', s.note))?.deletedAt).toBeNull();
      expect((await row('quiz_sets', s.sets.ready._id))?.deletedAt).toBeNull();
      expect((await row('flashcards', s.cards.byFolder._id))?.deletedAt).toBeNull();
      expect(await row('quiz_box_items', s.box.ready._id)).not.toBeNull();
      expect((await row('ai_jobs', s.jobs.similar._id))?.status).toBe('running');
    });

    it('트랜잭션이 보지 못하고 커밋 전에 생긴 세트도 커밋 뒤에 지우고 그 작업을 취소한다', async () => {
      const s = await seed();
      const late = quizSet({ materialId: s.note, folderId: s.targetId, questions: [] });
      const lateJob = job({ type: 'quiz_generate', targetType: 'quiz_set', targetId: late._id });
      const original = cleanup.removeFor.bind(cleanup);
      const spy = vi.spyOn(cleanup, 'removeFor').mockImplementationOnce(async (...args) => {
        const removed = await original(...args);
        // 트랜잭션 밖의 다른 요청이 세트를 넣음(맞춤 퀴즈 만들기와 겹침)
        await col('quiz_sets').insertOne(late);
        await col('ai_jobs').insertOne(lateJob);
        return removed;
      });

      await service.remove(me.toHexString(), s.target._id);

      spy.mockRestore();
      expect((await row('quiz_sets', late._id))?.deletedAt).toBeInstanceOf(Date);
      expect((await row('ai_jobs', lateJob._id))?.status).toBe('canceled');
    });

    it('커밋 뒤 작업 취소가 실패해도 삭제는 성공이다', async () => {
      const s = await seed();
      const jobs = (cleanup as unknown as { jobs: AiJobsService }).jobs;
      const spy = vi.spyOn(jobs, 'cancelForTargets').mockRejectedValueOnce(new Error('down'));

      await service.remove(me.toHexString(), s.target._id);

      spy.mockRestore();
      expect((await row('folders', s.targetId))?.deletedAt).toBeInstanceOf(Date);
      expect((await row('quiz_sets', s.sets.ready._id))?.deletedAt).toBeInstanceOf(Date);
      expect((await row('ai_jobs', s.jobs.similar._id))?.status).toBe('running');
    });

    it('맞춤 퀴즈 만들기가 노트를 확인한 뒤 폴더가 지워지면 새 세트도 지우고 작업을 취소한 뒤 404', async () => {
      const f = await service.create(me.toHexString(), {
        title: '만드는 중 지움',
        subjectName: '수학',
      });
      const note = new Types.ObjectId();
      await col('materials').insertOne({
        _id: note,
        ownerId: me,
        folderId: new Types.ObjectId(f._id),
        title: '노트',
        kind: 'handwriting',
        pages: [{ pageNo: 1, ocrText: '하나\n둘\n셋\n넷\n다섯\n여섯' }],
        deletedAt: null,
      });
      // 노트를 읽은 뒤(노트 글 만들기) 세트를 넣기 전에 폴더가 지워진다
      const original = recordingPages.notePages.bind(recordingPages);
      const spy = vi.spyOn(recordingPages, 'notePages').mockImplementationOnce(async (...args) => {
        const pages = await original(...args);
        await service.remove(me.toHexString(), f._id);
        return pages;
      });

      await expect(quizSets.create(me.toHexString(), note.toHexString())).rejects.toMatchObject({
        status: 404,
      });

      spy.mockRestore();
      const made = await col('quiz_sets').find({ ownerId: me, materialId: note }).toArray();
      expect(made).toHaveLength(1);
      expect(made[0]?.deletedAt).toBeInstanceOf(Date);
      const jobRow = await col('ai_jobs').findOne({ targetId: made[0]!._id });
      expect(jobRow?.status).toBe('canceled');
    });

    /** 학습 폴더 · 노트 · 다 만든 원본 세트 · 틀린 답이 있는 끝낸 풀이(유사 퀴즈를 만들 수 있는 상태) */
    async function similarSource(title: string) {
      const f = await service.create(me.toHexString(), { title, subjectName: '수학' });
      const folderId = new Types.ObjectId(f._id);
      const note = new Types.ObjectId();
      await col('materials').insertOne({
        _id: note,
        ownerId: me,
        folderId,
        title: '노트',
        kind: 'handwriting',
        pages: [{ pageNo: 1, ocrText: '하나\n둘\n셋\n넷\n다섯' }],
        deletedAt: null,
      });
      const source = quizSet({ materialId: note, folderId });
      await col('quiz_sets').insertOne(source);
      await col('quiz_attempts').insertOne({
        _id: new Types.ObjectId(),
        userId: me,
        quizSetId: source._id,
        answers: [{ questionId: source.questions[0]!._id, answer: '나', correct: false }],
        finishedAt: new Date('2026-11-19T01:00:00.000Z'),
      });
      return { f, note, source };
    }

    it('노트 하나만 지운 퀴즈(폴더는 그대로)는 지금처럼 유사 퀴즈를 만들 수 있다(code-review 1차)', async () => {
      const { note, source } = await similarSource('노트만 지움');
      // 노트 하나 지우기는 퀴즈를 건드리지 않는다(이번 범위 밖)
      await col('materials').updateOne({ _id: note }, { $set: { deletedAt: new Date() } });

      const made = await similar.create(me.toHexString(), String(source._id));

      expect((await row('quiz_sets', new Types.ObjectId(made._id)))?.deletedAt).toBeNull();
      const jobRow = await col('ai_jobs').findOne({ targetId: new Types.ObjectId(made._id) });
      expect(jobRow?.status).toBe('queued');
    });

    it('커밋 뒤 지운 세트에 담긴 보관함 항목도 커밋 뒤 정리가 지운다(code-review 1차)', async () => {
      const s = await seed();
      const late = boxItem(me, s.sets.ready, 9);
      late.questionId = new Types.ObjectId(); // 같은 문제는 이미 담겨 있어 다른 id 로
      const original = cleanup.removeFor.bind(cleanup);
      const spy = vi.spyOn(cleanup, 'removeFor').mockImplementationOnce(async (...args) => {
        const removed = await original(...args);
        // 세트가 살아 있을 때 확인한 다른 기기의 담기가 트랜잭션 밖에서 들어옴
        await col('quiz_box_items').insertOne(late);
        return removed;
      });

      await service.remove(me.toHexString(), s.target._id);

      spy.mockRestore();
      expect(await row('quiz_box_items', late._id)).toBeNull();
      expect(await row('quiz_box_items', s.box.keep._id)).not.toBeNull();
    });

    it('유사 퀴즈 세트 저장 응답이 실패해도(저장은 됨) 폴더가 지워졌으면 그 세트를 지우고 404(code-review 1차)', async () => {
      const { f, source } = await similarSource('저장 응답 실패');
      const originalEnqueue = aiJobs.enqueue.bind(aiJobs);
      const enqueue = vi.spyOn(aiJobs, 'enqueue').mockImplementationOnce(async (input) => {
        const made = await originalEnqueue(input);
        await service.remove(me.toHexString(), f._id);
        return made;
      });
      const originalCreate = setsModel.create.bind(setsModel);
      const create = vi.spyOn(setsModel, 'create').mockImplementationOnce((async (doc: unknown) => {
        await originalCreate(doc as never);
        throw new Error('응답 끊김');
      }) as never);

      await expect(similar.create(me.toHexString(), String(source._id))).rejects.toMatchObject({
        status: 404,
      });

      enqueue.mockRestore();
      create.mockRestore();
      const made = await col('quiz_sets').find({ sourceSetId: source._id }).toArray();
      expect(made).toHaveLength(1);
      expect(made[0]?.deletedAt).toBeInstanceOf(Date);
    });

    it('미리 만들기도 노트를 확인한 뒤 폴더가 지워지면 넣은 작업을 멈춘다(code-review 1차)', async () => {
      const f = await service.create(me.toHexString(), {
        title: '미리 만들기 중 지움',
        subjectName: '수학',
      });
      const note = new Types.ObjectId();
      await col('materials').insertOne({
        _id: note,
        ownerId: me,
        folderId: new Types.ObjectId(f._id),
        title: '노트',
        kind: 'handwriting',
        pages: [{ pageNo: 1, ocrText: '하나\n둘\n셋\n넷\n다섯' }],
        deletedAt: null,
      });
      const original = aiJobs.enqueue.bind(aiJobs);
      const spy = vi.spyOn(aiJobs, 'enqueue').mockImplementationOnce(async (input) => {
        const made = await original(input);
        await service.remove(me.toHexString(), f._id);
        return made;
      });

      expect(await quizSets.pregenerate(me.toHexString(), note.toHexString())).toBeNull();

      spy.mockRestore();
      const jobRow = await col('ai_jobs').findOne({ type: 'quiz_pregen', targetId: note });
      expect(jobRow?.status).toBe('canceled');
    });

    it('오늘의 복습(첫 문제가 지운 폴더)을 끝낸 뒤의 오답 복습은 지금처럼 만든다(code-review 2차)', async () => {
      const { f, note, source } = await similarSource('오늘의 복습 기준 폴더');
      // 이 세트를 오늘의 복습 세트로 바꾼다(첫 문제의 노트 · 폴더를 가짐)
      await col('quiz_sets').updateOne({ _id: source._id }, { $set: { reviewDay: '2026-09-01' } });
      await service.remove(me.toHexString(), f._id);
      expect((await row('materials', note))?.deletedAt).toBeInstanceOf(Date);

      const made = await similar.create(me.toHexString(), String(source._id));

      expect((await row('quiz_sets', new Types.ObjectId(made._id)))?.deletedAt).toBeNull();
    });

    it('세트를 넣은 뒤 폴더 확인이 실패하면 오류를 올리고 넣은 작업은 거두지 않는다(code-review 2차)', async () => {
      const f = await service.create(me.toHexString(), {
        title: '폴더 확인 실패',
        subjectName: '수학',
      });
      const note = new Types.ObjectId();
      await col('materials').insertOne({
        _id: note,
        ownerId: me,
        folderId: new Types.ObjectId(f._id),
        title: '노트',
        kind: 'handwriting',
        pages: [{ pageNo: 1, ocrText: '하나\n둘\n셋\n넷\n다섯' }],
        deletedAt: null,
      });
      const spy = vi.spyOn(quizSets, 'folderGone').mockRejectedValueOnce(new Error('잠깐 끊김'));

      await expect(quizSets.create(me.toHexString(), note.toHexString())).rejects.toThrow(
        '잠깐 끊김',
      );

      spy.mockRestore();
      const made = await col('quiz_sets').findOne({ ownerId: me, materialId: note });
      expect(made?.deletedAt).toBeNull();
      expect((await col('ai_jobs').findOne({ targetId: made!._id }))?.status).toBe('queued');
    });

    it('원본 오늘의 복습이 이미 지워졌어도 거기서 이어 만든 오답 복습은 남긴다(code-review 3차)', async () => {
      const s = await seed();
      // 다시 만들기로 닫힌(지운) 오늘의 복습과 거기서 이어 만든 오답 복습(지울 폴더 값을 가짐)
      const closedToday = quizSet({
        materialId: s.note,
        folderId: s.targetId,
        reviewDay: '2026-09-30',
        deletedAt: new Date('2026-11-01T00:00:00.000Z'),
      });
      const child = quizSet({
        materialId: s.note,
        folderId: s.targetId,
        sourceSetId: closedToday._id,
      });
      await col('quiz_sets').insertMany([closedToday, child]);

      await service.remove(me.toHexString(), s.target._id);

      expect((await row('quiz_sets', child._id))?.deletedAt).toBeNull();
      expect((await row('quiz_sets', s.sets.ready._id))?.deletedAt).toBeInstanceOf(Date);
    });

    it('유사 퀴즈 만들기도 원본 세트를 확인한 뒤 폴더가 지워지면 새 세트를 지우고 작업을 취소한 뒤 404', async () => {
      const f = await service.create(me.toHexString(), {
        title: '유사 퀴즈 중 지움',
        subjectName: '수학',
      });
      const folderId = new Types.ObjectId(f._id);
      const note = new Types.ObjectId();
      await col('materials').insertOne({
        _id: note,
        ownerId: me,
        folderId,
        title: '노트',
        kind: 'handwriting',
        pages: [{ pageNo: 1, ocrText: '하나\n둘\n셋\n넷\n다섯' }],
        deletedAt: null,
      });
      const source = quizSet({ materialId: note, folderId });
      await col('quiz_sets').insertOne(source);
      await col('quiz_attempts').insertOne({
        _id: new Types.ObjectId(),
        userId: me,
        quizSetId: source._id,
        answers: [{ questionId: source.questions[0]!._id, answer: '나', correct: false }],
        finishedAt: new Date('2026-11-19T01:00:00.000Z'),
      });
      // 작업을 넣은 뒤 세트를 넣기 전에 폴더가 지워진다
      const original = aiJobs.enqueue.bind(aiJobs);
      const spy = vi.spyOn(aiJobs, 'enqueue').mockImplementationOnce(async (input) => {
        const made = await original(input);
        await service.remove(me.toHexString(), f._id);
        return made;
      });

      await expect(similar.create(me.toHexString(), String(source._id))).rejects.toMatchObject({
        status: 404,
      });

      spy.mockRestore();
      const made = await col('quiz_sets').find({ sourceSetId: source._id }).toArray();
      expect(made).toHaveLength(1);
      expect(made[0]?.deletedAt).toBeInstanceOf(Date);
      const jobRow = await col('ai_jobs').findOne({ targetId: made[0]!._id });
      expect(jobRow?.status).toBe('canceled');
    });
  });
});
