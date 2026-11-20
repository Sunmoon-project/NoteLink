import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { SIMILAR_PICK_MAX } from '@notelink/shared';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import type { MaterialDocument } from '../src/modules/content/schemas/material.schema.js';
import type { QuizAttemptDocument } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import type { QuizSetDocument } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { readQuestionIds } from '../src/quiz-sets/quiz-sets.controller.js';
import { QuizSetsService, SIMILAR_TYPE } from '../src/quiz-sets/quiz-sets.service.js';
import { fitReviewInput, SimilarQuizService } from '../src/quiz-sets/similar-quiz.service.js';
import { RecordingNotePagesService } from '../src/quiz-sets/recording-note-pages.service.js';
import { createFakeCollection, type Row } from './support/fake-collection.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';

// 유사 퀴즈 고르기(#605): 노트(학습 폴더)에서 끝낸 퀴즈의 문제를 골라 POST /quiz-sets/similar { questionIds }
const ME = new Types.ObjectId();
const OTHER = new Types.ObjectId();
const FOLDER = new Types.ObjectId();
const FOLDER2 = new Types.ObjectId();

const question = (order: number, concept = '세포막') => ({
  _id: new Types.ObjectId(),
  order,
  type: 'multiple_choice',
  prompt: `문제 ${order}`,
  choices: ['가', '나', '다', '라'],
  answer: '가',
  explanation: null,
  conceptTags: [concept],
  difficulty: '하',
  srs: { state: 'active', step: 1 },
});

const live = (r: Row) => r['status'] === 'generating' && (r['deletedAt'] ?? null) === null;
const unique = (a: Row, b: Row) =>
  String(a._id) === String(b._id) ||
  (live(a) &&
    live(b) &&
    String(a['ownerId']) === String(b['ownerId']) &&
    String(a['materialId']) === String(b['materialId']));

function setup() {
  const sets = createFakeCollection<QuizSetDocument>(unique);
  const materials = createFakeCollection<MaterialDocument>();
  const attempts = createFakeCollection<QuizAttemptDocument>();
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  Object.assign(sets.model, { updateOne });
  const jobs = createFakeJobs();
  const aiJobs = new AiJobsService(jobs.model);
  const recordingPages = new RecordingNotePagesService(jobs.model);
  const quizSets = new QuizSetsService(
    sets.model,
    materials.model,
    attempts.model,
    aiJobs,
    recordingPages,
  );
  const similar = new SimilarQuizService(
    sets.model,
    attempts.model,
    materials.model,
    aiJobs,
    quizSets,
    recordingPages,
  );
  const note = async (
    title: string,
    over: { owner?: Types.ObjectId; folder?: Types.ObjectId } = {},
  ) =>
    (await materials.model.create({
      ownerId: over.owner ?? ME,
      folderId: over.folder ?? FOLDER,
      title,
      deletedAt: null,
      pages: [{ pageNo: 1, ocrText: `${title} 노트 글` }],
    } as never)) as unknown as { _id: Types.ObjectId };
  /** 노트로 만든 ready 세트와, 그 세트를 끝낸 풀이(wrong 번째 문제들을 틀림) */
  const seed = async (
    material: Types.ObjectId,
    over: {
      owner?: Types.ObjectId;
      folder?: Types.ObjectId;
      wrong?: number[];
      deleted?: boolean;
      finishedAt?: Date;
    } = {},
  ) => {
    const owner = over.owner ?? ME;
    const qs = [question(1), question(2), question(3, '핵')];
    const set = (await sets.model.create({
      ownerId: owner,
      materialId: material,
      folderId: over.folder ?? FOLDER,
      source: 'ai_generated',
      sourceSetId: null,
      title: '세포 생물학',
      status: 'ready',
      questions: qs,
      questionCount: qs.length,
      deletedAt: over.deleted ? new Date() : null,
    } as never)) as unknown as { _id: Types.ObjectId };
    await attempts.model.create({
      quizSetId: set._id,
      userId: owner,
      finishedAt: over.finishedAt ?? new Date(),
      answers: qs.map((q, i) => ({ questionId: q._id, correct: !(over.wrong ?? [0]).includes(i) })),
    } as never);
    return { set: set._id.toHexString(), qs, ids: qs.map((q) => q._id.toHexString()) };
  };
  return { sets, attempts, jobs, materials, quizSets, similar, note, seed, updateOne };
}

describe('readQuestionIds(POST /quiz-sets/similar 본문)', () => {
  it('문자열 배열만 받고, 아니면 400', () => {
    expect(readQuestionIds({ questionIds: ['a', 'b'] })).toEqual(['a', 'b']);
    for (const bad of [null, {}, { questionIds: 'a' }, { questionIds: [1] }, { questionIds: [''] }])
      expect(() => readQuestionIds(bad)).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('SimilarQuizService.createFromPicks', () => {
  it('고른 문제로 고른 문제 모드 작업을 넣고, 그 노트의 「유사 퀴즈」 세트를 만드는 중으로 돌려준다', async () => {
    const { similar, note, seed, jobs, sets } = setup();
    const cell = await note('세포 생물학');
    const other = await note('세포 분열');
    const a = await seed(cell._id, { wrong: [1] });
    const b = await seed(cell._id, { wrong: [] });
    const c = await seed(other._id, { wrong: [0] });
    // 고른 순서대로, 같은 id는 한 번만
    const out = await similar.createFromPicks(ME.toHexString(), [
      a.ids[1]!,
      b.ids[0]!,
      c.ids[0]!,
      a.ids[1]!,
    ]);
    expect(out).toMatchObject({
      status: 'generating',
      folderId: FOLDER.toHexString(),
      // 고른 문제가 가장 많은 노트
      materialId: cell._id.toHexString(),
      sourceSetId: null,
      title: '세포 생물학 · 유사 퀴즈',
      questions: [],
    });
    const job = jobs.rows.at(-1)!;
    expect(job['type']).toBe(SIMILAR_TYPE);
    expect(String(job['targetId'])).toBe(out._id);
    const input = job['input'] as Record<string, unknown>;
    expect(input['mode']).toBe('pick');
    // 틀림은 그 세트를 마지막으로 끝낸 풀이로
    expect(input['picks']).toEqual([
      { quizSetId: a.set, questionId: a.ids[1], wrong: true },
      { quizSetId: b.set, questionId: b.ids[0], wrong: false },
      { quizSetId: c.set, questionId: c.ids[0], wrong: true },
    ]);
    const inSets = (input['sets'] as { id: string }[]).map((s) => s.id);
    expect(inSets.slice(0, 3).sort()).toEqual([a.set, b.set, c.set].sort());
    expect(Object.keys(input['notes'] as object).sort()).toEqual(
      [cell._id.toHexString(), other._id.toHexString()].sort(),
    );
    const row = sets.rows.find((r) => String(r._id) === out._id)!;
    expect(row['sourceAttemptId'] ?? null).toBeNull();
    expect(row['jobId']).toBeTruthy();
  });

  it('틀림은 그 세트를 마지막으로 끝낸 풀이로 정한다', async () => {
    const { similar, note, seed, attempts, jobs } = setup();
    const cell = await note('세포 생물학');
    const a = await seed(cell._id, { wrong: [0], finishedAt: new Date(Date.now() - 60_000) });
    // 나중 풀이에서는 첫 문제를 맞힘
    await attempts.model.create({
      quizSetId: new Types.ObjectId(a.set),
      userId: ME,
      finishedAt: new Date(),
      answers: a.qs.map((q) => ({ questionId: q._id, correct: true })),
    } as never);
    await similar.createFromPicks(ME.toHexString(), [a.ids[0]!]);
    const input = jobs.rows.at(-1)!['input'] as { picks: { wrong: boolean }[] };
    expect(input.picks[0]!.wrong).toBe(false);
  });

  it('남의 문제 · 지운 세트 · 없는 문제 · 형식이 틀린 id가 섞이면 404이고 작업을 넣지 않는다', async () => {
    const { similar, note, seed, jobs } = setup();
    const cell = await note('세포 생물학');
    const mine = await seed(cell._id);
    const theirs = await seed((await note('남의 노트', { owner: OTHER }))._id, { owner: OTHER });
    const gone = await seed(cell._id, { deleted: true });
    for (const bad of [
      theirs.ids[0]!,
      gone.ids[0]!,
      new Types.ObjectId().toHexString(),
      'not-an-id',
    ]) {
      await expect(
        similar.createFromPicks(ME.toHexString(), [mine.ids[0]!, bad]),
      ).rejects.toMatchObject({ status: 404 });
    }
    expect(jobs.rows).toHaveLength(0);
  });

  it('다른 노트(학습 폴더)의 문제가 섞이거나, 0개 · 상한을 넘으면 400', async () => {
    const { similar, note, seed, jobs } = setup();
    const a = await seed((await note('세포 생물학'))._id);
    const b = await seed((await note('영어', { folder: FOLDER2 }))._id, { folder: FOLDER2 });
    await expect(
      similar.createFromPicks(ME.toHexString(), [a.ids[0]!, b.ids[0]!]),
    ).rejects.toMatchObject({ status: 400 });
    await expect(similar.createFromPicks(ME.toHexString(), [])).rejects.toMatchObject({
      status: 400,
    });
    const many = Array.from({ length: SIMILAR_PICK_MAX + 1 }, () =>
      new Types.ObjectId().toHexString(),
    );
    await expect(similar.createFromPicks(ME.toHexString(), many)).rejects.toMatchObject({
      status: 400,
    });
    expect(jobs.rows).toHaveLength(0);
  });

  it('끝까지 푼 풀이가 없는 세트의 문제는 409', async () => {
    const { similar, note, seed, attempts } = setup();
    const a = await seed((await note('세포 생물학'))._id);
    attempts.rows.length = 0;
    await expect(similar.createFromPicks(ME.toHexString(), [a.ids[0]!])).rejects.toMatchObject({
      status: 409,
    });
  });

  it('같은 노트로 만드는 중인 세트가 있으면 409로 기다리게 하고, 넣은 작업은 거둔다', async () => {
    const { similar, note, seed, sets, jobs } = setup();
    const cell = await note('세포 생물학');
    const a = await seed(cell._id);
    await sets.model.create({
      ownerId: ME,
      materialId: cell._id,
      folderId: FOLDER,
      source: 'ai_generated',
      sourceSetId: null,
      title: '세포 생물학',
      status: 'generating',
      questions: [],
      deletedAt: null,
    } as never);
    await expect(similar.createFromPicks(ME.toHexString(), [a.ids[0]!])).rejects.toMatchObject({
      status: 409,
    });
    expect(jobs.rows.at(-1)!['status']).toBe('canceled');
  });

  it('작업이 끝나면 만든 문제를 넣어 ready로 바꾸고, 복습 상태(srs)는 건드리지 않는다', async () => {
    const { similar, note, seed, jobs, quizSets, updateOne } = setup();
    const a = await seed((await note('세포 생물학'))._id);
    const made = await similar.createFromPicks(ME.toHexString(), [a.ids[0]!]);
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: {
        reviewQuestions: [1, 2, 3].map((order) => ({
          id: new Types.ObjectId().toHexString(),
          order,
          prompt: `새 문제 ${order}`,
          choices: ['세포막', '핵'],
          answer: '세포막',
          conceptTags: ['세포막'],
        })),
        srsUpdates: [],
      },
    });
    const ready = await quizSets.findMine(ME.toHexString(), made._id);
    expect(ready).toMatchObject({ status: 'ready', questionCount: 3 });
    expect(updateOne).not.toHaveBeenCalled();
  });
});

describe('세트 목록의 wrongQuestionIds', () => {
  it('끝낸 세트마다 마지막으로 끝낸 풀이에서 틀린 문제(무효 풀이 제외)를 붙인다', async () => {
    const { quizSets, note, seed, attempts } = setup();
    const cell = await note('세포 생물학');
    const a = await seed(cell._id, { wrong: [0], finishedAt: new Date(Date.now() - 60_000) });
    await attempts.model.create({
      quizSetId: new Types.ObjectId(a.set),
      userId: ME,
      finishedAt: new Date(),
      answers: [
        { questionId: a.qs[0]!._id, correct: true },
        { questionId: a.qs[1]!._id, correct: false },
        { questionId: a.qs[2]!._id, correct: false, void: true },
      ],
    } as never);
    // 끝내지 않은 풀이는 보지 않는다
    await attempts.model.create({
      quizSetId: new Types.ObjectId(a.set),
      userId: ME,
      finishedAt: null,
      answers: [{ questionId: a.qs[0]!._id, correct: false }],
    } as never);
    const list = await quizSets.list(ME.toHexString());
    expect(list.find((s) => s._id === a.set)).toMatchObject({
      completed: true,
      wrongQuestionIds: [a.ids[1]],
    });
  });

  it('끝낸 풀이가 없는 세트에는 붙이지 않는다', async () => {
    const { quizSets, note, seed, attempts } = setup();
    const a = await seed((await note('세포 생물학'))._id);
    attempts.rows.length = 0;
    const list = await quizSets.list(ME.toHexString());
    expect(list.find((s) => s._id === a.set)!.wrongQuestionIds).toBeUndefined();
  });
});

describe('fitReviewInput(고른 문제 모드, code-review)', () => {
  const set = (id: string, materialId: string) => ({ id, materialId, questions: [] });
  const input = {
    sets: [set('s1', 'm1'), set('s2', 'm2'), set('s3', 'm3')],
    history: [],
    notes: {
      m1: [{ pageNo: 1, ocrText: 'a'.repeat(400) }],
      m2: [{ pageNo: 1, ocrText: 'b'.repeat(400) }],
      m3: [{ pageNo: 1, ocrText: 'c'.repeat(400) }],
    },
  };

  it('고른 세트(앞 required개)와 그 노트는 꼭 넣고, 나머지는 들어갈 만큼만', () => {
    const out = fitReviewInput(input, 1500, 2);
    expect(out.sets.map((x) => x.id)).toEqual(['s1', 's2']);
    expect(Object.keys(out.notes).sort()).toEqual(['m1', 'm2']);
  });

  it('고른 세트의 노트를 합쳐 넘으면 넘겨 준 문구로 400', () => {
    expect(() => fitReviewInput(input, 900, 3, '합쳐 너무 길어요')).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({ message: '합쳐 너무 길어요' }),
      }),
    );
  });
});
