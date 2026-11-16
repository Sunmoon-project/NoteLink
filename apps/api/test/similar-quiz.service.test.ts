import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import type { MaterialDocument } from '../src/modules/content/schemas/material.schema.js';
import type { QuizAttemptDocument } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import type { QuizSetDocument } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { QuizSetsService, SIMILAR_TYPE } from '../src/quiz-sets/quiz-sets.service.js';
import { SimilarQuizService } from '../src/quiz-sets/similar-quiz.service.js';
import { createFakeCollection, type Row } from './support/fake-collection.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';

const ME = new Types.ObjectId();
const OTHER = new Types.ObjectId();
const FOLDER = new Types.ObjectId();
const DAY = 24 * 60 * 60 * 1000;

const question = (order: number) => ({
  _id: new Types.ObjectId(),
  order,
  type: 'multiple_choice',
  prompt: `문제 ${order}`,
  choices: ['가', '나', '다', '라'],
  answer: '가',
  explanation: null,
  conceptTags: ['세포막'],
  difficulty: '하',
  srs: null,
});

// quiz-set.schema.ts 고유 색인: 같은 노트로 만드는 중인 세트는 하나
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
  Object.assign(attempts.model, { aggregate: vi.fn().mockResolvedValue([]) });
  const updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  Object.assign(sets.model, { updateOne });
  const jobs = createFakeJobs();
  const aiJobs = new AiJobsService(jobs.model);
  const quizSets = new QuizSetsService(sets.model, materials.model, attempts.model, aiJobs);
  const similar = new SimilarQuizService(
    sets.model,
    attempts.model,
    materials.model,
    aiJobs,
    quizSets,
  );
  /** 노트 하나와 그 노트로 만든 ready 세트, 그 세트를 끝낸 풀이(첫 문제를 틀림) */
  const seed = async (over: { owner?: Types.ObjectId; allCorrect?: boolean } = {}) => {
    const owner = over.owner ?? ME;
    const note = (await materials.model.create({
      ownerId: owner,
      folderId: FOLDER,
      title: '세포 생물학',
      deletedAt: null,
      pages: [{ pageNo: 1, ocrText: '세포막은 세포를 둘러싼다.' }],
    } as never)) as unknown as { _id: Types.ObjectId };
    const qs = [question(1), question(2)];
    const set = (await sets.model.create({
      ownerId: owner,
      materialId: note._id,
      folderId: FOLDER,
      source: 'ai_generated',
      sourceSetId: null,
      title: '세포 생물학',
      status: 'ready',
      questions: qs,
      questionCount: 2,
      deletedAt: null,
    } as never)) as unknown as { _id: Types.ObjectId };
    const finishedAt = new Date();
    const attempt = (await attempts.model.create({
      quizSetId: set._id,
      userId: owner,
      finishedAt,
      answers: qs.map((q, i) => ({
        questionId: q._id,
        correct: over.allCorrect ? true : i !== 0,
      })),
    } as never)) as unknown as { _id: Types.ObjectId };
    return { note: note._id, set: set._id.toHexString(), attempt: attempt._id, qs, finishedAt };
  };
  return { sets, attempts, jobs, quizSets, similar, seed, updateOne };
}

describe('SimilarQuizService.create', () => {
  it('마지막 풀이로 오답 복습 작업을 넣고 「다시 보기」 세트를 만드는 중으로 돌려준다', async () => {
    const { similar, seed, jobs, sets, attempts } = setup();
    const s = await seed();
    // 30일 안의 다른 풀이는 이력으로, 그보다 오래된 풀이는 넣지 않는다
    await attempts.model.create({
      quizSetId: new Types.ObjectId(s.set),
      userId: ME,
      finishedAt: new Date(s.finishedAt.getTime() - 3 * DAY),
      answers: [],
    } as never);
    await attempts.model.create({
      quizSetId: new Types.ObjectId(s.set),
      userId: ME,
      finishedAt: new Date(s.finishedAt.getTime() - 40 * DAY),
      answers: [],
    } as never);

    const out = await similar.create(ME.toHexString(), s.set);
    expect(out).toMatchObject({
      status: 'generating',
      sourceSetId: s.set,
      title: '세포 생물학 · 다시 보기',
      questions: [],
    });
    const job = jobs.rows.at(-1)!;
    expect(job['type']).toBe(SIMILAR_TYPE);
    expect(String(job['targetId'])).toBe(out._id);
    const input = job['input'] as Record<string, unknown>;
    expect(input).toMatchObject({
      attemptId: s.attempt.toHexString(),
      quizSetId: s.set,
      answers: [
        { questionId: s.qs[0]!._id.toHexString(), correct: false },
        { questionId: s.qs[1]!._id.toHexString(), correct: true },
      ],
      notes: { [s.note.toHexString()]: [{ pageNo: 1, ocrText: '세포막은 세포를 둘러싼다.' }] },
    });
    expect((input['sets'] as { id: string }[])[0]!.id).toBe(s.set);
    expect(input['history']).toHaveLength(1);
    expect(sets.rows.find((r) => String(r._id) === out._id)!['jobId']).toBeTruthy();
  });

  it('같은 세트로 만드는 중이면 그 세트를 돌려주고 작업을 더 넣지 않는다', async () => {
    const { similar, seed, jobs } = setup();
    const s = await seed();
    const first = await similar.create(ME.toHexString(), s.set);
    const count = jobs.rows.length;
    const again = await similar.create(ME.toHexString(), s.set);
    expect(again._id).toBe(first._id);
    expect(jobs.rows).toHaveLength(count);
  });

  it('남의 세트 · 없는 세트는 404, 풀지 않았거나 틀린 문제가 없으면 409', async () => {
    const { similar, seed } = setup();
    const others = await seed({ owner: OTHER });
    await expect(similar.create(ME.toHexString(), others.set)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      similar.create(ME.toHexString(), new Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({ status: 404 });

    const perfect = await seed({ allCorrect: true });
    await expect(similar.create(ME.toHexString(), perfect.set)).rejects.toMatchObject({
      status: 409,
      response: { message: '틀린 문제가 없어요' },
    });
  });

  it('끝낸 풀이가 없으면 먼저 풀라고 409', async () => {
    const { similar, seed, attempts } = setup();
    const s = await seed();
    attempts.rows.length = 0;
    await expect(similar.create(ME.toHexString(), s.set)).rejects.toMatchObject({
      status: 409,
      response: { message: '먼저 이 퀴즈를 끝까지 풀어 주세요' },
    });
  });
  it('같은 노트로 맞춤 퀴즈를 만드는 중이면 409로 기다리게 하고, 넣은 작업은 거둔다', async () => {
    const { similar, seed, sets, jobs } = setup();
    const s = await seed();
    const note = sets.rows.find((r) => String(r._id) === s.set)!['materialId'];
    await sets.model.create({
      ownerId: ME,
      materialId: note,
      source: 'ai_generated',
      sourceSetId: null,
      title: '세포 생물학',
      status: 'generating',
      questions: [],
      deletedAt: null,
    } as never);
    await expect(similar.create(ME.toHexString(), s.set)).rejects.toMatchObject({ status: 409 });
    expect(jobs.rows.at(-1)!['status']).toBe('canceled');
  });
});

describe('다시 보기 세트 결과 옮기기(QuizSetsService.findMine)', () => {
  it('작업이 끝나면 reviewQuestions를 문제로 넣어 ready로 바꾸고, 복습 상태(srs)를 옮긴다', async () => {
    const { similar, seed, jobs, quizSets, updateOne } = setup();
    const s = await seed();
    const made = await similar.create(ME.toHexString(), s.set);
    const job = jobs.rows.at(-1)!;
    const newId = new Types.ObjectId().toHexString();
    const srs = { box: 1, dueAt: '2026-11-17T15:00:00.000Z' };
    Object.assign(job, {
      status: 'succeeded',
      progress: 100,
      result: {
        reviewQuestions: [
          {
            id: newId,
            order: 1,
            type: '정의',
            prompt: '세포를 둘러싼 막은?',
            choices: ['세포막', '핵', '리보솜', '골지체'],
            answer: '세포막',
            explanation: '세포막이 세포를 둘러싼다.',
            conceptTags: ['세포막'],
            difficulty: '하',
            srs: { box: 0 },
          },
        ],
        srsUpdates: [{ quizSetId: s.set, questionId: s.qs[0]!._id.toHexString(), srs }],
      },
    });
    const ready = await quizSets.findMine(ME.toHexString(), made._id);
    expect(ready).toMatchObject({ status: 'ready', questionCount: 1 });
    expect(ready.questions[0]).toMatchObject({ _id: newId, prompt: '세포를 둘러싼 막은?' });
    expect(updateOne).toHaveBeenCalledWith(
      { _id: new Types.ObjectId(s.set), ownerId: ME },
      { $set: { 'questions.$[q].srs': srs } },
      { arrayFilters: [{ 'q._id': s.qs[0]!._id }] },
    );
  });

  it('만들지 못했으면(reviewQuestions가 비었음) 세트를 failed로 둔다', async () => {
    const { similar, seed, jobs, quizSets } = setup();
    const s = await seed();
    const made = await similar.create(ME.toHexString(), s.set);
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: [] },
    });
    expect(await quizSets.findMine(ME.toHexString(), made._id)).toMatchObject({ status: 'failed' });
  });
});
