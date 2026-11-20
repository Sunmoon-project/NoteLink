import { Types } from 'mongoose';
import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import type { MaterialDocument } from '../src/modules/content/schemas/material.schema.js';
import type { QuizAttemptDocument } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import type { QuizSetDocument } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { QuizSetsService, SIMILAR_TYPE } from '../src/quiz-sets/quiz-sets.service.js';
import {
  fitReviewInput,
  type ReviewInput,
  SimilarQuizService,
} from '../src/quiz-sets/similar-quiz.service.js';
import { RecordingNotePagesService } from '../src/quiz-sets/recording-note-pages.service.js';
import { recordingTranscriptOf, transcriptToPages } from '../src/quiz-sets/recording-pages.js';
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
  return { sets, attempts, jobs, materials, quizSets, similar, seed, updateOne };
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

  it('녹음 노트 세트의 유사 퀴즈 입력 notes 에는 녹음 대본 쪽이 들어간다(필기 노트는 위 테스트처럼 쪽 글 그대로)', async () => {
    const { similar, seed, jobs, materials } = setup();
    const s = await seed();
    const result = {
      sentences: Array.from({ length: 8 }, (_, i) => ({
        text: `녹음 문장 ${i}.`,
        startMs: i,
        endMs: i + 1,
      })),
      slides: [{ sentenceStart: 0, sentenceEnd: 8 }],
    };
    const summaryJob = {
      _id: new Types.ObjectId(),
      type: 'recording_summary',
      userId: ME,
      status: 'succeeded',
      result,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    jobs.rows.push(summaryJob as never);
    // 노트를 녹음 노트로 바꾼다: pages 가 없고 대본은 작업 결과에 있다
    Object.assign(
      materials.rows.find((r) => String(r._id) === s.note.toHexString())!,
      {
        kind: 'recording',
        pages: [],
        processing: { status: 'done', jobId: summaryJob._id },
      },
    );
    await similar.create(ME.toHexString(), s.set);
    const input = jobs.rows.at(-1)!['input'] as ReviewInput;
    const expected = transcriptToPages(recordingTranscriptOf(result)!);
    expect(expected.length).toBeGreaterThan(0);
    expect(input.notes[s.note.toHexString()]).toEqual(expected);
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
    const { similar, seed, jobs, quizSets, updateOne, sets } = setup();
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
    const at = sets.rows.find((r) => String(r._id) === made._id)!['createdAt'] as Date;
    expect(updateOne).toHaveBeenCalledWith(
      { _id: new Types.ObjectId(s.set), ownerId: ME },
      {
        $set: { 'questions.$[q].srs': srs, 'questions.$[q].srsAt': at },
        $unset: { 'questions.$[q].srsAttemptId': '' },
      },
      { arrayFilters: [{ 'q._id': s.qs[0]!._id, 'q.srsAt': { $not: { $gt: at } } }] },
    );
  });

  it('만들지 못했으면(reviewQuestions가 비었음) 세트를 failed로 두되 복습 상태는 옮긴다', async () => {
    const { similar, seed, jobs, quizSets, updateOne } = setup();
    const s = await seed();
    const made = await similar.create(ME.toHexString(), s.set);
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: {
        reviewQuestions: [],
        srsUpdates: [
          { quizSetId: s.set, questionId: s.qs[0]!._id.toHexString(), srs: { step: 1 } },
        ],
      },
    });
    expect(await quizSets.findMine(ME.toHexString(), made._id)).toMatchObject({ status: 'failed' });
    // 새 문제를 못 만들어도 처리기가 끝냈으면 복습 상태는 옮긴다
    expect(updateOne).toHaveBeenCalledTimes(1);
  });
});

describe('한 풀이에 한 번(복습 상태를 두 번 옮기지 않게)', () => {
  const finishJob = (jobs: ReturnType<typeof setup>['jobs'], questions: unknown[]) =>
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: questions, srsUpdates: [] },
    });
  const reviewQuestion = () => ({
    id: new Types.ObjectId().toHexString(),
    order: 1,
    prompt: '세포를 둘러싼 막은?',
    choices: ['세포막', '핵'],
    answer: '세포막',
    conceptTags: [],
  });

  it('다 만든 뒤 같은 풀이로 다시 요청하면 그 세트를 돌려주고 작업을 더 넣지 않는다', async () => {
    const { similar, seed, jobs, quizSets } = setup();
    const s = await seed();
    const made = await similar.create(ME.toHexString(), s.set);
    finishJob(jobs, [reviewQuestion()]);
    await quizSets.findMine(ME.toHexString(), made._id);
    const count = jobs.rows.length;
    const again = await similar.create(ME.toHexString(), s.set);
    expect(again).toMatchObject({ _id: made._id, status: 'ready' });
    expect(jobs.rows).toHaveLength(count);
  });

  it('처리기가 끝낸 세트를 지웠거나 새 문제를 못 만들었으면 같은 풀이로는 409', async () => {
    const { similar, seed, jobs, quizSets, sets } = setup();
    const s = await seed();
    const made = await similar.create(ME.toHexString(), s.set);
    finishJob(jobs, []);
    await quizSets.findMine(ME.toHexString(), made._id); // failed로 옮김
    await expect(similar.create(ME.toHexString(), s.set)).rejects.toMatchObject({ status: 409 });
    Object.assign(
      sets.rows.find((r) => String(r._id) === made._id)!,
      { deletedAt: new Date() },
    );
    await expect(similar.create(ME.toHexString(), s.set)).rejects.toMatchObject({ status: 409 });
  });

  it('처리기가 실패로 끝냈으면(옮긴 것 없음) 같은 풀이로 새로 만든다', async () => {
    const { similar, seed, jobs, quizSets } = setup();
    const s = await seed();
    const made = await similar.create(ME.toHexString(), s.set);
    Object.assign(jobs.rows.at(-1)!, { status: 'failed', error: 'LLM' });
    await quizSets.findMine(ME.toHexString(), made._id);
    const again = await similar.create(ME.toHexString(), s.set);
    expect(again._id).not.toBe(made._id);
    expect(again.status).toBe('generating');
  });
});

describe('실패한 작업을 다시 시도해도 한 풀이의 복습 상태는 한 번만', () => {
  it('A 실패 → 같은 풀이로 B를 만들면 A를 닫고, 나중에 A를 다시 시도해 성공해도 A는 옮기지 않는다', async () => {
    const { similar, seed, jobs, quizSets, sets, updateOne } = setup();
    const s = await seed();
    const a = await similar.create(ME.toHexString(), s.set);
    const jobA = jobs.rows.at(-1)!;
    Object.assign(jobA, { status: 'failed', error: 'LLM' });
    await quizSets.findMine(ME.toHexString(), a._id); // A → failed
    const b = await similar.create(ME.toHexString(), s.set);
    expect(b._id).not.toBe(a._id);
    expect(sets.rows.find((r) => String(r._id) === a._id)!['deletedAt']).toBeInstanceOf(Date);
    // A를 다시 시도(ai-jobs retry)해 성공으로 끝나도, 지운 세트라 조회 · 옮기기가 없다
    Object.assign(jobA, {
      status: 'succeeded',
      result: {
        reviewQuestions: [],
        srsUpdates: [
          { quizSetId: s.set, questionId: s.qs[0]!._id.toHexString(), srs: { step: 9 } },
        ],
      },
    });
    await expect(quizSets.findMine(ME.toHexString(), a._id)).rejects.toMatchObject({ status: 404 });
    expect(updateOne).not.toHaveBeenCalled();
  });

  it('실패한 세트의 작업을 다시 시도해 새 문제 없이 끝나면 세트는 failed로 두고 복습 상태를 옮긴다', async () => {
    const { similar, seed, jobs, quizSets, updateOne } = setup();
    const s = await seed();
    const made = await similar.create(ME.toHexString(), s.set);
    const job = jobs.rows.at(-1)!;
    Object.assign(job, { status: 'failed', error: 'LLM' });
    expect(await quizSets.findMine(ME.toHexString(), made._id)).toMatchObject({ status: 'failed' });
    expect(updateOne).not.toHaveBeenCalled();
    Object.assign(job, {
      status: 'succeeded',
      error: null,
      result: {
        reviewQuestions: [],
        srsUpdates: [
          { quizSetId: s.set, questionId: s.qs[0]!._id.toHexString(), srs: { step: 1 } },
        ],
      },
    });
    expect(await quizSets.findMine(ME.toHexString(), made._id)).toMatchObject({ status: 'failed' });
    expect(updateOne).toHaveBeenCalledTimes(1);
  });
});

describe('복습 상태는 세트마다 한 번만 옮긴다', () => {
  it('A(새 문제 없음)를 옮긴 뒤 다시 풀어 B를 만들어 옮기면, A를 다시 조회 · 목록 조회해도 A가 다시 쓰지 않는다', async () => {
    const { similar, seed, jobs, quizSets, attempts, updateOne, sets } = setup();
    const s = await seed();
    const srsUpdates = (step: number) => [
      { quizSetId: s.set, questionId: s.qs[0]!._id.toHexString(), srs: { step } },
    ];
    const a = await similar.create(ME.toHexString(), s.set);
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: srsUpdates(1) },
    });
    expect(await quizSets.findMine(ME.toHexString(), a._id)).toMatchObject({ status: 'failed' });
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(sets.rows.find((r) => String(r._id) === a._id)!['srsSavedAt']).toBeInstanceOf(Date);

    // 같은 퀴즈를 다시 풀어(새 풀이) B를 만들고 끝낸다
    await attempts.model.create({
      quizSetId: new Types.ObjectId(s.set),
      userId: ME,
      finishedAt: new Date(Date.now() + 1000),
      answers: [{ questionId: s.qs[0]!._id, correct: false }],
    } as never);
    const b = await similar.create(ME.toHexString(), s.set);
    expect(b._id).not.toBe(a._id);
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: srsUpdates(2) },
    });
    await quizSets.findMine(ME.toHexString(), b._id);
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(updateOne.mock.calls.at(-1)![1]).toMatchObject({
      $set: { 'questions.$[q].srs': { step: 2 } },
    });

    // A를 다시 열거나 목록을 읽어도 A의 옛 복습 상태(step 1)로 되돌리지 않는다
    await quizSets.findMine(ME.toHexString(), a._id);
    await quizSets.list(ME.toHexString());
    expect(updateOne).toHaveBeenCalledTimes(2);
  });
});

describe('복습 상태 옮기기: 동시 조회 · 실패', () => {
  const finishEmpty = (jobs: ReturnType<typeof setup>['jobs'], qid: string, set: string) =>
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: {
        reviewQuestions: [],
        srsUpdates: [{ quizSetId: set, questionId: qid, srs: { step: 1 } }],
      },
    });

  it('복습 상태는 이 세트보다 오래된(또는 없는) 상태만 덮는 조건으로 쓴다', async () => {
    const { similar, seed, jobs, quizSets, updateOne, sets } = setup();
    const s = await seed();
    const made = await similar.create(ME.toHexString(), s.set);
    finishEmpty(jobs, s.qs[0]!._id.toHexString(), s.set);
    const at = sets.rows.find((r) => String(r._id) === made._id)!['createdAt'] as Date;
    await Promise.all([
      quizSets.findMine(ME.toHexString(), made._id),
      quizSets.findMine(ME.toHexString(), made._id),
    ]);
    // 같이 옮겨도 같은 값 · 같은 조건이라 몇 번 써도 결과가 같다
    expect(updateOne).toHaveBeenCalledWith(
      { _id: new Types.ObjectId(s.set), ownerId: ME },
      {
        $set: { 'questions.$[q].srs': { step: 1 }, 'questions.$[q].srsAt': at },
        $unset: { 'questions.$[q].srsAttemptId': '' },
      },
      { arrayFilters: [{ 'q._id': s.qs[0]!._id, 'q.srsAt': { $not: { $gt: at } } }] },
    );
    expect(sets.rows.find((r) => String(r._id) === made._id)!['srsSavedAt']).toBeInstanceOf(Date);
    // 다 옮긴 세트는 다시 쓰지 않는다
    const calls = updateOne.mock.calls.length;
    await quizSets.findMine(ME.toHexString(), made._id);
    expect(updateOne).toHaveBeenCalledTimes(calls);
  });

  it('쓰다 실패하면 표시도 세트 상태도 그대로라 다음 조회가 다시 옮긴다', async () => {
    const { similar, seed, jobs, quizSets, updateOne, sets } = setup();
    const s = await seed();
    const made = await similar.create(ME.toHexString(), s.set);
    finishEmpty(jobs, s.qs[0]!._id.toHexString(), s.set);
    updateOne.mockRejectedValueOnce(new Error('DB 끊김'));
    await expect(quizSets.findMine(ME.toHexString(), made._id)).rejects.toThrow('DB 끊김');
    const row = () => sets.rows.find((r) => String(r._id) === made._id)!;
    expect(row()['srsSavedAt'] ?? null).toBeNull();
    expect(row()['status']).toBe('generating');
    await quizSets.findMine(ME.toHexString(), made._id);
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(sets.rows.find((r) => String(r._id) === made._id)!['srsSavedAt']).toBeInstanceOf(Date);
  });
});

describe('처리기 입력 크기(fitReviewInput)', () => {
  const set = (id: string, materialId: string, n = 1) => ({
    id,
    materialId,
    questions: Array.from({ length: n }, () => ({ prompt: 'x'.repeat(100) })),
  });
  const input = (over: Partial<ReviewInput> = {}): ReviewInput => ({
    attemptId: 'a',
    quizSetId: 's1',
    finishedAt: '2026-11-16T00:00:00.000Z',
    answers: [],
    sets: [set('s1', 'm1'), set('s2', 'm2', 50), set('s3', 'm3')],
    history: [
      { id: 'h2', quizSetId: 's2', finishedAt: '2026-11-15T00:00:00.000Z', answers: [] },
      { id: 'h3', quizSetId: 's3', finishedAt: '2026-11-15T00:00:00.000Z', answers: [] },
    ],
    notes: {
      m1: [{ pageNo: 1, ocrText: '노트 1' }],
      m2: [{ pageNo: 1, ocrText: '노트 2' }],
      m3: [{ pageNo: 1, ocrText: '노트 3' }],
    },
    ...over,
  });

  it('한도 안이면 그대로', () => {
    expect(fitReviewInput(input())).toEqual(input());
  });

  it('넘으면 이번 세트는 남기고, 들어가지 않는 다른 세트는 그 풀이 · 노트와 함께 뺀다', () => {
    const base = fitReviewInput(
      input({
        sets: [set('s1', 'm1')],
        history: [],
        notes: { m1: [{ pageNo: 1, ocrText: '노트 1' }] },
      }),
    );
    const fitted = fitReviewInput(input(), JSON.stringify(base).length + 1200);
    expect(fitted.sets.map((x) => x.id)).toEqual(['s1', 's3']);
    expect(fitted.history.map((x) => x.id)).toEqual(['h3']);
    expect(Object.keys(fitted.notes).sort()).toEqual(['m1', 'm3']);
  });

  it('이번 세트만으로도 넘으면 400', () => {
    expect(() => fitReviewInput(input(), 100)).toThrow(
      expect.objectContaining({ status: 400 }) as unknown as Error,
    );
  });
});

describe('작업 조회가 실패하면 만든 세트를 닫지 않는다(madeFor)', () => {
  const ready = async (t: ReturnType<typeof setup>) => {
    const s = await t.seed();
    const made = await t.similar.create(ME.toHexString(), s.set);
    Object.assign(t.jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: {
        reviewQuestions: [
          {
            id: new Types.ObjectId().toHexString(),
            order: 1,
            prompt: '세포를 둘러싼 막은?',
            choices: ['세포막', '핵'],
            answer: '세포막',
            conceptTags: [],
          },
        ],
        srsUpdates: [],
      },
    });
    await t.quizSets.findMine(ME.toHexString(), made._id);
    const row = () => t.sets.rows.find((r) => String(r._id) === made._id)!;
    expect(row()['status']).toBe('ready');
    return { s, made, row };
  };

  it('일시적인 조회 오류는 그대로 알리고, 다 만든 세트는 지우지 않으며 작업도 더 넣지 않는다', async () => {
    const t = setup();
    const { s, made, row } = await ready(t);
    const count = t.jobs.rows.length;
    const find = vi
      .spyOn(AiJobsService.prototype, 'findMine')
      .mockRejectedValueOnce(new Error('DB 끊김'));
    try {
      await expect(t.similar.create(ME.toHexString(), s.set)).rejects.toThrow('DB 끊김');
    } finally {
      find.mockRestore();
    }
    expect(row()['deletedAt'] ?? null).toBeNull();
    expect(t.jobs.rows).toHaveLength(count);
    // 조회가 돌아오면 같은 세트를 그대로 돌려준다
    expect(await t.similar.create(ME.toHexString(), s.set)).toMatchObject({
      _id: made._id,
      status: 'ready',
    });
  });

  it('작업이 없어진 세트(404)는 전처럼 닫고 새로 만든다', async () => {
    const t = setup();
    const { s, made, row } = await ready(t);
    t.jobs.rows.length = 0;
    const again = await t.similar.create(ME.toHexString(), s.set);
    expect(again._id).not.toBe(made._id);
    expect(row()['deletedAt']).toBeInstanceOf(Date);
  });
});

describe('세트 저장 결과가 불명확할 때 작업 거두기(create)', () => {
  /** 세트 저장이 한 번 실패하게 한다. saved 면 저장은 반영되고 응답만 실패한 것처럼 */
  const failCreate = (t: ReturnType<typeof setup>, saved: boolean) => {
    const original = t.sets.model.create.bind(t.sets.model);
    return vi.spyOn(t.sets.model, 'create').mockImplementationOnce((async (doc: never) => {
      if (saved) await original(doc);
      throw new Error('쓰기 확인 실패');
    }) as never);
  };

  it('저장은 됐는데 응답만 실패했으면 작업을 거두지 않고 그 세트를 돌려준다', async () => {
    const t = setup();
    const s = await t.seed();
    failCreate(t, true);
    const out = await t.similar.create(ME.toHexString(), s.set);
    const job = t.jobs.rows.at(-1)!;
    expect(out).toMatchObject({ status: 'generating', sourceSetId: s.set });
    expect(String(job['targetId'])).toBe(out._id);
    expect(job['status']).not.toBe('canceled');
    // 다시 눌러도 같은 세트(작업을 더 넣지 않는다)
    const count = t.jobs.rows.length;
    expect((await t.similar.create(ME.toHexString(), s.set))._id).toBe(out._id);
    expect(t.jobs.rows).toHaveLength(count);
  });

  it('저장되지 않았으면 넣은 작업을 거두고 오류를 알린다', async () => {
    const t = setup();
    const s = await t.seed();
    failCreate(t, false);
    await expect(t.similar.create(ME.toHexString(), s.set)).rejects.toThrow('쓰기 확인 실패');
    expect(t.jobs.rows.at(-1)!['status']).toBe('canceled');
    expect(t.sets.rows.some((r) => String(r['sourceSetId']) === s.set)).toBe(false);
  });

  it('세트 저장과 작업 취소가 모두 실패하면 최초 저장 오류를 알린다', async () => {
    const t = setup();
    const s = await t.seed();
    const saveError = new Error('세트 저장 실패');
    vi.spyOn(t.sets.model, 'create').mockRejectedValueOnce(saveError as never);
    const cancel = vi
      .spyOn(AiJobsService.prototype, 'cancel')
      .mockRejectedValueOnce(new Error('취소 실패'));
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(t.similar.create(ME.toHexString(), s.set)).rejects.toBe(saveError);
      const jobId = String(t.jobs.rows.at(-1)!['_id']);
      expect(cancel).toHaveBeenCalledExactlyOnceWith(ME.toHexString(), jobId);
      expect(warn).toHaveBeenCalledExactlyOnceWith(`유사 퀴즈 작업 취소 실패 (작업 ID: ${jobId})`);
      expect(t.sets.rows.some((r) => String(r['sourceSetId']) === s.set)).toBe(false);
    } finally {
      cancel.mockRestore();
      warn.mockRestore();
    }
  });

  it('저장됐는지 확인하지 못하면 작업을 거두지 않고 원래 오류를 알린다', async () => {
    const t = setup();
    const s = await t.seed();
    failCreate(t, true);
    const findOne = t.sets.model.findOne.bind(t.sets.model);
    let calls = 0;
    // 저장 실패 뒤의 확인 조회만 실패하게 한다(그 앞의 원래 세트 · 만드는 중 조회 두 번은 그대로)
    vi.spyOn(t.sets.model, 'findOne').mockImplementation(((filter: never) => {
      calls += 1;
      if (calls === 3) return { lean: () => Promise.reject(new Error('DB 끊김')) };
      return findOne(filter);
    }) as never);
    await expect(t.similar.create(ME.toHexString(), s.set)).rejects.toThrow('쓰기 확인 실패');
    expect(calls).toBe(3);
    expect(t.jobs.rows.at(-1)!['status']).not.toBe('canceled');
  });
});
