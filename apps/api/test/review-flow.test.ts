import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import type { MaterialDocument } from '../src/modules/content/schemas/material.schema.js';
import type { QuizAttemptDocument } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import type { QuizSetDocument } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import {
  QuizSetsService,
  seoulDay,
  SIMILAR_TYPE,
  TODAY_TYPE,
} from '../src/quiz-sets/quiz-sets.service.js';
import { RecordingNotePagesService } from '../src/quiz-sets/recording-note-pages.service.js';
import { SimilarQuizService } from '../src/quiz-sets/similar-quiz.service.js';
import {
  fitTodayInput,
  type TodayInput,
  TodayReviewService,
  TODAY_SIZE,
} from '../src/quiz-sets/today-review.service.js';
import { createFakeCollection, type Row } from './support/fake-collection.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';

const ME = new Types.ObjectId();
const FOLDER = new Types.ObjectId();
const NOW = new Date('2026-11-16T03:00:00.000Z'); // 서울 11/16 12시

const question = (order: number) => ({
  _id: new Types.ObjectId(),
  order,
  type: 'multiple_choice',
  prompt: `문제 ${order}`,
  choices: ['가', '나'],
  answer: '가',
  explanation: null,
  conceptTags: ['세포막'],
  difficulty: '하',
  srs: null,
});

// quiz-set.schema.ts 고유 색인: 같은 노트(노트 없음 포함)로 만드는 중인 세트는 하나 · 오늘의 복습은 날마다 하나
const open = (r: Row) => (r['deletedAt'] ?? null) === null;
const live = (r: Row) => r['status'] === 'generating' && open(r);
const day = (r: Row) => (typeof r['reviewDay'] === 'string' && open(r) ? r['reviewDay'] : null);
const unique = (a: Row, b: Row) =>
  String(a._id) === String(b._id) ||
  (String(a['ownerId']) === String(b['ownerId']) &&
    ((live(a) && live(b) && String(a['materialId'] ?? null) === String(b['materialId'] ?? null)) ||
      (day(a) !== null && day(a) === day(b))));

function setup() {
  const sets = createFakeCollection<QuizSetDocument>(unique);
  const materials = createFakeCollection<MaterialDocument>();
  const attempts = createFakeCollection<QuizAttemptDocument>();
  Object.assign(attempts.model, { aggregate: vi.fn().mockResolvedValue([]) });
  const setUpdate = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  const attemptUpdate = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  Object.assign(sets.model, { updateOne: setUpdate });
  Object.assign(attempts.model, { updateOne: attemptUpdate });
  const jobs = createFakeJobs();
  const aiJobs = new AiJobsService(jobs.model);
  const notePages = new RecordingNotePagesService(jobs.model);
  const quizSets = new QuizSetsService(
    sets.model,
    materials.model,
    attempts.model,
    aiJobs,
    notePages,
  );
  const similar = new SimilarQuizService(
    sets.model,
    attempts.model,
    materials.model,
    aiJobs,
    quizSets,
    notePages,
  );
  const today = new TodayReviewService(
    sets.model,
    attempts.model,
    materials.model,
    aiJobs,
    quizSets,
    notePages,
  );
  /** 노트 · ready 세트 · 끝낸 풀이(첫 문제 틀림 또는 모두 맞음) */
  const seed = async (over: { allCorrect?: boolean; deleted?: boolean } = {}) => {
    const note = (await materials.model.create({
      ownerId: ME,
      folderId: FOLDER,
      title: '세포 생물학',
      deletedAt: null,
      pages: [{ pageNo: 1, ocrText: '세포막은 세포를 둘러싼다.' }],
    } as never)) as unknown as { _id: Types.ObjectId };
    const qs = [question(1), question(2)];
    const set = (await sets.model.create({
      ownerId: ME,
      materialId: note._id,
      folderId: FOLDER,
      source: 'ai_generated',
      sourceSetId: null,
      title: '세포 생물학',
      status: 'ready',
      questions: qs,
      questionCount: 2,
      deletedAt: over.deleted ? new Date() : null,
    } as never)) as unknown as { _id: Types.ObjectId };
    const attempt = (await attempts.model.create({
      quizSetId: set._id,
      userId: ME,
      finishedAt: new Date(NOW.getTime() - 60_000),
      answers: qs.map((q, i) => ({
        questionId: q._id,
        answer: i === 0 && !over.allCorrect ? '나' : '가',
        correct: over.allCorrect ? true : i !== 0,
        ...(i === 1 ? { void: '정답 둘' } : {}),
      })),
    } as never)) as unknown as { _id: Types.ObjectId };
    return { note: note._id, set: set._id, attempt: attempt._id, qs };
  };
  return {
    sets,
    attempts,
    jobs,
    quizSets,
    similar,
    today,
    seed,
    setUpdate,
    attemptUpdate,
    notePages,
  };
}

describe('퀴즈를 끝내면 오답 복습 시작(SimilarQuizService.startAfterFinish)', () => {
  it('틀린 문제가 있으면 다시 보기 세트를 만들고 작업을 넣는다', async () => {
    const { similar, seed, jobs } = setup();
    const s = await seed();
    const out = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    expect(out).toMatchObject({ status: 'generating', sourceSetId: s.set.toHexString() });
    expect(jobs.rows.at(-1)!['type']).toBe(SIMILAR_TYPE);
    // 무효 풀이(결함 문제)는 처리기 입력에 그대로 넘긴다
    const answers = (jobs.rows.at(-1)!['input'] as { answers: unknown[] }).answers;
    expect(answers[1]).toMatchObject({ void: '정답 둘' });
  });

  it('모두 맞혀도 작업을 넣어 복습 상태를 옮긴다(손으로 누른 유사 퀴즈는 409)', async () => {
    const { similar, seed, jobs, quizSets, setUpdate } = setup();
    const perfect = await seed({ allCorrect: true });
    await expect(similar.create(ME.toHexString(), perfect.set.toHexString())).rejects.toMatchObject(
      {
        status: 409,
      },
    );
    const made = await similar.startAfterFinish(ME.toHexString(), perfect.attempt.toHexString());
    expect(made).toMatchObject({ status: 'generating' });
    expect(jobs.rows.at(-1)!['type']).toBe(SIMILAR_TYPE);
    // 처리기가 새 문제 없이 복습 상태만 돌려주면 세트는 failed(앱에 보이지 않음), 복습 상태는 쓴다
    const qid = perfect.qs[0]!._id.toHexString();
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: {
        reviewQuestions: [],
        srsUpdates: [{ quizSetId: perfect.set.toHexString(), questionId: qid, srs: { streak: 1 } }],
      },
    });
    expect(await quizSets.findMine(ME.toHexString(), made!._id)).toMatchObject({
      status: 'failed',
    });
    expect(setUpdate).toHaveBeenCalledTimes(1);
  });

  it('없는 풀이면 아무것도 하지 않고, 이미 만들었으면 같은 세트', async () => {
    const { similar, seed, jobs } = setup();
    expect(
      await similar.startAfterFinish(ME.toHexString(), new Types.ObjectId().toHexString()),
    ).toBeNull();
    expect(jobs.rows).toHaveLength(0);
    const s = await seed();
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    const again = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    expect(again!._id).toBe(first!._id);
    expect(jobs.rows).toHaveLength(1);
  });

  it('앞 작업을 기다리는 사이 끝낸 풀이들은 결과를 옮길 때마다 끝낸 순서대로 하나씩 넣는다', async () => {
    const { similar, seed, jobs, attempts, quizSets } = setup();
    const s = await seed();
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    const later = [];
    for (const sec of [40, 30, 20]) {
      const a = (await attempts.model.create({
        quizSetId: s.set,
        userId: ME,
        finishedAt: new Date(NOW.getTime() - sec * 1000),
        answers: s.qs.map((q) => ({ questionId: q._id, answer: '가', correct: true })),
      } as never)) as unknown as { _id: Types.ObjectId };
      later.push(a._id.toHexString());
      // 같은 노트로 만드는 중인 세트는 하나: 지금은 앞 세트를 돌려주고 작업은 그대로 하나
      const waiting = await similar.startAfterFinish(ME.toHexString(), a._id.toHexString());
      expect(waiting!._id).toBe(first!._id);
    }
    expect(jobs.rows).toHaveLength(1);
    const done = {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: [] },
    };
    const inputAttempt = (i: number) => (jobs.rows[i]!['input'] as { attemptId: string }).attemptId;
    // 결과를 옮길 때마다 다음 풀이 하나(끝낸 순서)
    let setId = first!._id;
    for (const [n, attemptId] of later.entries()) {
      Object.assign(jobs.rows.at(-1)!, done);
      await quizSets.findMine(ME.toHexString(), setId);
      expect(jobs.rows).toHaveLength(n + 2);
      expect(inputAttempt(n + 1)).toBe(attemptId);
      setId = String(jobs.rows.at(-1)!['targetId']);
    }
    // 다 옮기면 더 넣지 않는다
    Object.assign(jobs.rows.at(-1)!, done);
    await quizSets.findMine(ME.toHexString(), setId);
    await quizSets.findMine(ME.toHexString(), first!._id);
    expect(jobs.rows).toHaveLength(4);
  });

  it('결과를 맞추는 사이 다른 요청이 앞 세트를 끝내도 기다리던 풀이를 이어 받는다', async () => {
    const { similar, seed, jobs, attempts, quizSets } = setup();
    const s = await seed();
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    const later = (await attempts.model.create({
      quizSetId: s.set,
      userId: ME,
      finishedAt: NOW,
      answers: s.qs.map((q) => ({ questionId: q._id, answer: '가', correct: true })),
    } as never)) as unknown as { _id: Types.ObjectId };
    Object.assign(jobs.rows[0]!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: [] },
    });
    // 이 요청이 읽기 전에 다른 요청(followUp)이 앞 세트를 끝내고, 이 요청은 끝나기 전 모습(generating)을 본다
    const real = quizSets.findMine.bind(quizSets);
    vi.spyOn(quizSets, 'findMine').mockImplementationOnce(async (user, id) => {
      await real(user, id); // 다른 요청이 끝냄(이어 받기가 돈다)
      return { ...first!, status: 'generating' };
    });
    await similar.startAfterFinish(ME.toHexString(), later._id.toHexString());
    expect(jobs.rows).toHaveLength(2);
    expect((jobs.rows[1]!['input'] as { attemptId: string }).attemptId).toBe(
      later._id.toHexString(),
    );
    expect((await attempts.model.findOne({ _id: later._id }).lean())?.['reviewPending']).toBe(
      false,
    );
  });

  it('같은 노트의 다른 세트를 기다리는 사이 끝낸 풀이도 이어 받는다', async () => {
    const { similar, seed, jobs, attempts, quizSets, sets } = setup();
    const s = await seed();
    // 같은 노트로 만든 다른 세트 B
    const b = (await sets.model.create({
      ownerId: ME,
      materialId: s.note,
      folderId: FOLDER,
      source: 'ai_generated',
      sourceSetId: null,
      title: '세포 생물학 2',
      status: 'ready',
      questions: s.qs,
      questionCount: 2,
      deletedAt: null,
    } as never)) as unknown as { _id: Types.ObjectId };
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    const onB = (await attempts.model.create({
      quizSetId: b._id,
      userId: ME,
      finishedAt: new Date(NOW.getTime() - 30_000),
      answers: s.qs.map((q) => ({ questionId: q._id, answer: '가', correct: true })),
    } as never)) as unknown as { _id: Types.ObjectId };
    // 같은 노트로 만드는 중인 세트가 있어 지금은 넣지 못함(고유 색인)
    expect(await similar.startAfterFinish(ME.toHexString(), onB._id.toHexString())).toBeNull();
    expect(jobs.rows.filter((j) => j['status'] !== 'canceled')).toHaveLength(1);
    Object.assign(jobs.rows[0]!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: [] },
    });
    await quizSets.findMine(ME.toHexString(), first!._id);
    const last = jobs.rows.at(-1)!;
    expect(last['status']).not.toBe('canceled');
    expect((last['input'] as { attemptId: string }).attemptId).toBe(onB._id.toHexString());
  });

  it('무효 풀이만 있는 풀이는 기다리지 않고, 막힌 유효 풀이만 이어 받는다', async () => {
    const { similar, seed, jobs, attempts, quizSets } = setup();
    const s = await seed();
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    // 무효 풀이만 있는 풀이 20개 뒤에 유효한 풀이 하나(끝낼 때마다 자동 시작을 부름)
    for (let i = 0; i < 20; i++) {
      const v = (await attempts.model.create({
        quizSetId: s.set,
        userId: ME,
        finishedAt: new Date(NOW.getTime() - 50_000 + i * 1000),
        answers: [{ questionId: s.qs[0]!._id, answer: '가', correct: true, void: '정답 둘' }],
      } as never)) as unknown as { _id: Types.ObjectId };
      expect(await similar.startAfterFinish(ME.toHexString(), v._id.toHexString())).toBeNull();
    }
    const valid = (await attempts.model.create({
      quizSetId: s.set,
      userId: ME,
      finishedAt: new Date(NOW.getTime() - 10_000),
      answers: s.qs.map((q) => ({ questionId: q._id, answer: '가', correct: true })),
    } as never)) as unknown as { _id: Types.ObjectId };
    await similar.startAfterFinish(ME.toHexString(), valid._id.toHexString());
    expect(attempts.rows.filter((r) => r['reviewPending'] === true)).toHaveLength(1);
    Object.assign(jobs.rows[0]!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: [] },
    });
    await quizSets.findMine(ME.toHexString(), first!._id);
    expect(jobs.rows).toHaveLength(2);
    expect((jobs.rows[1]!['input'] as { attemptId: string }).attemptId).toBe(
      valid._id.toHexString(),
    );
  });

  it('같은 노트로 일반 퀴즈를 만드는 중이면 기다렸다가, 그 퀴즈가 끝날 때 이어 받는다', async () => {
    const { similar, seed, jobs, attempts, quizSets, sets } = setup();
    const s = await seed();
    // 같은 노트로 만드는 중인 일반 퀴즈(고유 색인: 노트마다 만드는 중 세트는 하나)
    const genJob = jobs.rows.length;
    const gen = (await sets.model.create({
      ownerId: ME,
      materialId: s.note,
      folderId: FOLDER,
      source: 'ai_generated',
      sourceSetId: null,
      title: '세포 생물학 2',
      status: 'generating',
      questions: [],
      questionCount: 0,
      deletedAt: null,
    } as never)) as unknown as { _id: Types.ObjectId };
    await new AiJobsService(jobs.model).enqueue({
      type: 'quiz_generate',
      userId: ME.toHexString(),
      targetType: 'quiz_set',
      targetId: gen._id.toHexString(),
      input: {},
    });
    Object.assign(
      sets.rows.find((r) => String(r._id) === String(gen._id))!,
      {
        jobId: jobs.rows[genJob]!._id,
      },
    );
    expect(await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString())).toBeNull();
    const row = () => attempts.rows.find((r) => String(r._id) === String(s.attempt))!;
    expect(row()['reviewPending']).toBe(true);
    // 일반 퀴즈가 끝나면(결과를 옮길 때) 기다리던 풀이로 오답 복습을 넣는다
    Object.assign(jobs.rows[genJob]!, { status: 'failed', error: 'x' });
    await quizSets.findMine(ME.toHexString(), gen._id.toHexString());
    const review = jobs.rows.filter(
      (j) => j['type'] === SIMILAR_TYPE && j['status'] !== 'canceled',
    );
    expect(review).toHaveLength(1);
    expect((review[0]!['input'] as { attemptId: string }).attemptId).toBe(s.attempt.toHexString());
    expect(row()['reviewPending']).toBe(false);
  });

  it('작업을 거두는 사이 막던 일반 퀴즈가 끝나 버려도 기다리지 않고 다시 만든다', async () => {
    const { similar, seed, jobs, attempts, quizSets, sets } = setup();
    const s = await seed();
    const genJob = jobs.rows.length;
    const gen = (await sets.model.create({
      ownerId: ME,
      materialId: s.note,
      folderId: FOLDER,
      source: 'ai_generated',
      sourceSetId: null,
      title: '세포 생물학 2',
      status: 'generating',
      questions: [],
      questionCount: 0,
      deletedAt: null,
    } as never)) as unknown as { _id: Types.ObjectId };
    await new AiJobsService(jobs.model).enqueue({
      type: 'quiz_generate',
      userId: ME.toHexString(),
      targetType: 'quiz_set',
      targetId: gen._id.toHexString(),
      input: {},
    });
    Object.assign(
      sets.rows.find((r) => String(r._id) === String(gen._id))!,
      {
        jobId: jobs.rows[genJob]!._id,
      },
    );
    // 고유 색인에 막혀 넣은 작업을 거두는 사이 일반 퀴즈가 끝나고 그 이어 받기도 돈다(아직 기다림 표시 전)
    const aiJobs = (similar as unknown as { jobs: AiJobsService }).jobs;
    const cancel = aiJobs.cancel.bind(aiJobs);
    vi.spyOn(aiJobs, 'cancel').mockImplementationOnce(async (user, id) => {
      Object.assign(jobs.rows[genJob]!, { status: 'failed', error: 'x' });
      await quizSets.findMine(ME.toHexString(), gen._id.toHexString());
      return cancel(user, id);
    });
    const made = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    expect(made?.status).toBe('generating');
    const review = jobs.rows.filter(
      (j) => j['type'] === SIMILAR_TYPE && j['status'] !== 'canceled',
    );
    expect(review).toHaveLength(1);
    expect(attempts.rows.find((r) => String(r._id) === String(s.attempt))!['reviewPending']).toBe(
      false,
    );
  });

  it('같은 시각에 끝난 두 풀이도 빠지지 않고 이어 받는다', async () => {
    const { similar, seed, jobs, attempts, quizSets } = setup();
    const s = await seed();
    const at = new Date(NOW.getTime() - 60_000); // seed 풀이와 같은 완료 시각
    const twin = (await attempts.model.create({
      quizSetId: s.set,
      userId: ME,
      finishedAt: at,
      answers: s.qs.map((q) => ({ questionId: q._id, answer: '가', correct: true })),
    } as never)) as unknown as { _id: Types.ObjectId };
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    await similar.startAfterFinish(ME.toHexString(), twin._id.toHexString());
    expect(jobs.rows).toHaveLength(1);
    Object.assign(jobs.rows[0]!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: [] },
    });
    await quizSets.findMine(ME.toHexString(), first!._id);
    expect(jobs.rows).toHaveLength(2);
    expect((jobs.rows[1]!['input'] as { attemptId: string }).attemptId).toBe(
      twin._id.toHexString(),
    );
  });

  it('작업이 새 문제까지 만든 뒤 완료 요청을 다시 보내도 같은 세트를 돌려주고 끝난다', async () => {
    const { similar, seed, jobs, attempts } = setup();
    const s = await seed();
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    Object.assign(jobs.rows[0]!, {
      status: 'succeeded',
      progress: 100,
      result: {
        reviewQuestions: [
          {
            id: new Types.ObjectId().toHexString(),
            order: 1,
            prompt: '새 문제',
            choices: ['가', '나'],
            answer: '가',
            conceptTags: ['세포막'],
            srs: { step: 0 },
          },
        ],
        srsUpdates: [],
      },
    });
    // 완료 요청 재전송 = 같은 풀이로 다시 자동 시작
    const again = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    expect(again!._id).toBe(first!._id);
    expect(jobs.rows).toHaveLength(1);
    const row = attempts.rows.find((r) => String(r._id) === String(s.attempt))!;
    expect(row['reviewPending'] ?? false).toBe(false);
  });

  it('기다리던 풀이가 전부 무효가 되면 표시를 지우고 뒤의 풀이를 이어 받는다', async () => {
    const { similar, seed, jobs, attempts, quizSets } = setup();
    const s = await seed();
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    const mk = async (sec: number) => {
      const a = (await attempts.model.create({
        quizSetId: s.set,
        userId: ME,
        finishedAt: new Date(NOW.getTime() - sec * 1000),
        answers: s.qs.map((q) => ({ questionId: q._id, answer: '가', correct: true })),
      } as never)) as unknown as { _id: Types.ObjectId };
      await similar.startAfterFinish(ME.toHexString(), a._id.toHexString());
      return a._id;
    };
    const voided = await mk(40);
    const valid = await mk(30);
    // 기다리는 사이 결함 문제로 답이 모두 무효가 됨(오늘의 복습 voidAnswers)
    const v = attempts.rows.find((r) => String(r._id) === String(voided))!;
    v['answers'] = (v['answers'] as Row[]).map((x) => ({ ...x, void: '정답 둘' }));
    Object.assign(jobs.rows[0]!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: [] },
    });
    await quizSets.findMine(ME.toHexString(), first!._id);
    expect(v['reviewPending']).toBe(false);
    expect((jobs.rows.at(-1)!['input'] as { attemptId: string }).attemptId).toBe(
      valid.toHexString(),
    );
  });

  it('기다리는 풀이가 50개를 넘어 앞의 것을 모두 건너뛰어도 뒤의 풀이를 이어 받는다', async () => {
    const { similar, seed, jobs, attempts, quizSets } = setup();
    const s = await seed();
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    for (let i = 0; i < 51; i++) {
      await attempts.model.create({
        quizSetId: s.set,
        userId: ME,
        finishedAt: new Date(NOW.getTime() - 50_000 + i * 100),
        answers: [{ questionId: s.qs[0]!._id, answer: '가', correct: true, void: '정답 둘' }],
        reviewPending: true,
      } as never);
    }
    const valid = (await attempts.model.create({
      quizSetId: s.set,
      userId: ME,
      finishedAt: new Date(NOW.getTime() - 1_000),
      answers: s.qs.map((q) => ({ questionId: q._id, answer: '가', correct: true })),
      reviewPending: true,
    } as never)) as unknown as { _id: Types.ObjectId };
    Object.assign(jobs.rows[0]!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: [] },
    });
    await quizSets.findMine(ME.toHexString(), first!._id);
    expect((jobs.rows.at(-1)!['input'] as { attemptId: string }).attemptId).toBe(
      valid._id.toHexString(),
    );
    expect(attempts.rows.filter((r) => r['reviewPending'] === true)).toHaveLength(0);
  });

  it('동시에 만든 같은 원본의 복습 세트가 대기를 적기 직전에 끝나도 이번 풀이를 다시 만든다', async () => {
    const { similar, seed, jobs, attempts, sets } = setup();
    const s = await seed();
    const other = (await attempts.model.create({
      quizSetId: s.set,
      userId: ME,
      finishedAt: new Date(NOW.getTime() - 90_000),
      answers: s.qs.map((q) => ({ questionId: q._id, answer: '가', correct: true })),
    } as never)) as unknown as { _id: Types.ObjectId };
    const xId = new Types.ObjectId();
    // 저장하려는 순간 다른 요청이 같은 원본으로 먼저 만든 세트(X) → 고유 색인에 막힘
    const realCreate = sets.model.create.bind(sets.model);
    vi.spyOn(sets.model, 'create').mockImplementationOnce((async (data: Row) => {
      await realCreate({
        _id: xId,
        ownerId: ME,
        materialId: s.note,
        folderId: FOLDER,
        source: 'ai_generated',
        sourceSetId: s.set,
        sourceAttemptId: other._id,
        title: 'X',
        status: 'generating',
        questions: [],
        questionCount: 0,
        deletedAt: null,
      } as never);
      return realCreate(data as never);
    }) as never);
    // 기다림을 적기 직전에 X가 끝나고 이어 받기까지 돌아 버림
    const realUpdate = attempts.model.findOneAndUpdate.bind(attempts.model);
    let raced = false;
    vi.spyOn(attempts.model, 'findOneAndUpdate').mockImplementation(((
      filter: Row,
      update: { $set?: Row },
      opts?: Row,
    ) => {
      if (!raced && update.$set?.['reviewPending'] === true) {
        raced = true;
        Object.assign(
          sets.rows.find((r) => String(r._id) === String(xId))!,
          { status: 'ready' },
        );
      }
      return realUpdate(filter as never, update as never, opts as never);
    }) as never);
    const out = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    expect(raced).toBe(true);
    const mine = jobs.rows.filter(
      (j) =>
        j['type'] === SIMILAR_TYPE &&
        j['status'] !== 'canceled' &&
        (j['input'] as { attemptId: string }).attemptId === s.attempt.toHexString(),
    );
    expect(mine).toHaveLength(1);
    expect(out).toMatchObject({ status: 'generating' });
    const row = attempts.rows.find((r) => String(r._id) === String(s.attempt))!;
    expect(row['reviewPending']).toBe(false);
  });

  it('이어 받을 풀이를 넣지 못하면 표시를 남겨 다음 조회가 다시 넣는다', async () => {
    const { similar, seed, jobs, attempts, quizSets, sets } = setup();
    const s = await seed();
    const first = await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    const next = (await attempts.model.create({
      quizSetId: s.set,
      userId: ME,
      finishedAt: new Date(NOW.getTime() - 30_000),
      answers: s.qs.map((q) => ({ questionId: q._id, answer: '가', correct: true })),
    } as never)) as unknown as { _id: Types.ObjectId };
    await similar.startAfterFinish(ME.toHexString(), next._id.toHexString());

    Object.assign(jobs.rows[0]!, {
      status: 'succeeded',
      progress: 100,
      result: { reviewQuestions: [], srsUpdates: [] },
    });
    const enqueue = vi
      .spyOn(AiJobsService.prototype, 'enqueue')
      .mockRejectedValueOnce(new Error('DB'));
    await quizSets.findMine(ME.toHexString(), first!._id);
    expect(jobs.rows).toHaveLength(1);
    const row = () => sets.rows.find((r) => String(r._id) === first!._id)!;
    expect(row()['followUpPending']).toBe(true);
    // 다시 조회하면 넣고 표시를 지운다
    await quizSets.findMine(ME.toHexString(), first!._id);
    expect(jobs.rows).toHaveLength(2);
    expect((jobs.rows[1]!['input'] as { attemptId: string }).attemptId).toBe(
      next._id.toHexString(),
    );
    expect(row()['followUpPending']).toBe(false);
    enqueue.mockRestore();
  });

  it('만들 수 없는 경우(409 등)는 조용히 넘어가 끝내기에 영향이 없다', async () => {
    const { similar, seed, sets } = setup();
    const s = await seed();
    // 노트가 없는 세트(오늘의 복습 등)는 유사 퀴즈를 만들 수 없다(409)
    Object.assign(
      sets.rows.find((r) => String(r._id) === String(s.set))!,
      { materialId: null },
    );
    expect(await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString())).toBeNull();
  });
});

describe('오늘의 복습(TodayReviewService)', () => {
  it('하루 한 번 만든다: 처리기 입력(지운 세트 · 풀이 답 · 무효 · 노트)과 「오늘의 복습 · MM-DD」 세트', async () => {
    const { today, seed, jobs, sets } = setup();
    const live = await seed();
    const gone = await seed({ deleted: true });
    const made = await today.start(ME.toHexString(), NOW);
    expect(made).toMatchObject({
      status: 'generating',
      title: '오늘의 복습 · 11-16',
      materialId: '',
    });
    expect(sets.rows.find((r) => String(r._id) === made._id)!['reviewDay']).toBe('2026-11-16');
    const job = jobs.rows.at(-1)!;
    expect(job['type']).toBe(TODAY_TYPE);
    const input = job['input'] as TodayInput;
    expect(input).toMatchObject({ day: seoulDay(NOW), size: TODAY_SIZE });
    expect(input.sets.map((x) => x.id)).toEqual([live.set.toHexString(), gone.set.toHexString()]);
    expect(input.sets[1]!.deletedAt).toBeTruthy();
    expect(input.attempts[0]!.answers[0]).toMatchObject({ answer: '나', correct: false });
    expect(Object.keys(input.notes)).toHaveLength(2);

    // 같은 날 다시 요청하면 같은 세트, 작업은 하나
    const again = await today.start(ME.toHexString(), NOW);
    expect(again._id).toBe(made._id);
    expect(jobs.rows).toHaveLength(1);
    expect((await today.get(ME.toHexString(), NOW))!._id).toBe(made._id);
  });

  it('지난날 세트를 닫으려는 순간 처리기가 끝내면 지우지 않고 결과를 옮긴다', async () => {
    const { today, seed, jobs, sets } = setup();
    const s = await seed();
    const first = await today.start(ME.toHexString(), NOW);
    const job = jobs.rows.at(-1)!;
    const realCancel = AiJobsService.prototype.cancel;
    const cancel = vi
      .spyOn(AiJobsService.prototype, 'cancel')
      .mockImplementationOnce(async function (this: AiJobsService, userId: string, jobId: string) {
        // 취소 직전에 처리기가 끝냄(성공은 취소되지 않음)
        Object.assign(job, {
          status: 'succeeded',
          progress: 100,
          result: {
            questions: [
              {
                id: new Types.ObjectId().toHexString(),
                order: 1,
                prompt: '문제 1',
                choices: ['가', '나'],
                answer: '가',
                conceptTags: ['세포막'],
                srs: { step: 1 },
              },
            ],
            title: '오늘의 복습 · 11-16',
            baseSetId: s.set.toHexString(),
            srsUpdates: [],
          },
        });
        return realCancel.call(this, userId, jobId);
      });
    const next = await today.start(ME.toHexString(), new Date('2026-11-17T03:00:00.000Z'));
    cancel.mockRestore();
    expect(next.title).toBe('오늘의 복습 · 11-17');
    const prev = sets.rows.find((r) => String(r._id) === first._id)!;
    expect(prev['deletedAt'] ?? null).toBeNull();
    expect(prev['status']).toBe('ready');
  });

  it('동시 요청의 앞 세트가 다 만들어진 뒤 늦은 요청이 만들려 해도 오늘 세트는 하나', async () => {
    const { today, seed, jobs, sets, quizSets } = setup();
    await seed();
    let first = '';
    const realCreate = sets.model.create.bind(sets.model);
    const create = vi
      .spyOn(sets.model, 'create')
      .mockImplementationOnce(async (...args: unknown[]) => {
        // 늦은 요청이 「오늘 세트 없음」을 읽은 뒤, 앞 요청이 세트를 만들고 결과까지 옮김(ready)
        first = (await today.start(ME.toHexString(), NOW))._id;
        Object.assign(jobs.rows.at(-1)!, {
          status: 'succeeded',
          progress: 100,
          result: {
            questions: [
              {
                id: new Types.ObjectId().toHexString(),
                order: 1,
                prompt: '문제 1',
                choices: ['가', '나'],
                answer: '가',
                conceptTags: ['세포막'],
                srs: { step: 1 },
              },
            ],
            title: '오늘의 복습 · 11-16',
            srsUpdates: [],
          },
        });
        expect((await quizSets.findMine(ME.toHexString(), first)).status).toBe('ready');
        return (realCreate as (...a: unknown[]) => unknown)(...args) as never;
      });
    const late = await today.start(ME.toHexString(), NOW);
    create.mockRestore();
    expect(late._id).toBe(first);
    expect(late.status).toBe('ready');
    const todays = sets.rows.filter((r) => r['reviewDay'] === '2026-11-16' && !r['deletedAt']);
    expect(todays).toHaveLength(1);
    expect(jobs.rows[0]!['status']).toBe('canceled'); // 늦은 요청의 작업
  });

  it('오답 복습이 아직 도는 세트는 문제를 고르지 않게(지운 세트처럼) 넘겨, 방금 푼 복습 상태를 덮지 않는다', async () => {
    const { today, similar, seed, jobs } = setup();
    const s = await seed();
    const other = await seed();
    // s의 풀이로 오답 복습이 아직 도는 중(결과가 곧 s 세트 문제의 복습 상태를 바꿈)
    await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    await today.start(ME.toHexString(), NOW);
    const input = jobs.rows.find((j) => j['type'] === TODAY_TYPE)!['input'] as TodayInput;
    const byId = (id: Types.ObjectId) => input.sets.find((x) => x.id === id.toHexString())!;
    expect(byId(s.set).deletedAt).toBeTruthy();
    expect(byId(other.set).deletedAt).toBeUndefined();
    // 풀이는 그대로 넘겨 약한 개념에는 센다
    expect(input.attempts.some((a) => a.quizSetId === s.set.toHexString())).toBe(true);
  });

  // Codex 3차 리뷰: 복습 상태(세트)를 읽은 뒤에만 「도는 복습」을 보면, 그 사이 끝나 결과를 저장한 복습을 놓쳐
  // 결과 전 상태로 만든 오늘의 복습이 방금 푼 결과를 덮는다
  it('세트를 읽는 사이 오답 복습이 끝나도 그 원본은 고르지 않는다', async () => {
    const { today, similar, seed, jobs, sets } = setup();
    const s = await seed();
    await similar.startAfterFinish(ME.toHexString(), s.attempt.toHexString());
    const review = sets.rows.find(
      (r) => r['status'] === 'generating' && String(r['sourceSetId']) === s.set.toHexString(),
    )!;
    const realFind = sets.model.find.bind(sets.model);
    const find = vi.spyOn(sets.model, 'find').mockImplementation(((
      filter: Record<string, unknown>,
      ...rest: unknown[]
    ) => {
      // 오늘의 복습이 세트(복습 상태)를 읽는 바로 그때 오답 복습이 끝나 결과를 저장한다
      if (filter['status'] === 'ready' && filter['materialId']) review['status'] = 'ready';
      return (realFind as (...a: unknown[]) => unknown)(filter, ...rest);
    }) as never);
    await today.start(ME.toHexString(), NOW);
    find.mockRestore();
    const input = jobs.rows.find((j) => j['type'] === TODAY_TYPE)!['input'] as TodayInput;
    expect(input.sets.find((x) => x.id === s.set.toHexString())!.deletedAt).toBeTruthy();
  });

  it('복습할 문제가 없으면 조회는 null, 처리기가 실패했으면 failed(앱이 다시 만들게)', async () => {
    const { today, seed, jobs } = setup();
    await seed();
    await today.start(ME.toHexString(), NOW);
    Object.assign(jobs.rows.at(-1)!, { status: 'failed', error: 'LLM' });
    expect(await today.get(ME.toHexString(), NOW)).toMatchObject({ status: 'failed' });
    await today.start(ME.toHexString(), NOW);
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: { questions: [], srsUpdates: [] },
    });
    expect(await today.get(ME.toHexString(), NOW)).toBeNull();
  });

  it('노트 글은 녹음 노트면 대본에서 읽는다(유사 퀴즈 · 맞춤 퀴즈와 같은 곳)', async () => {
    const { today, seed, jobs, notePages } = setup();
    const s = await seed();
    const transcript = [{ pageNo: 1, ocrText: '녹음 대본' }];
    const read = vi.spyOn(notePages, 'notePages').mockResolvedValue(transcript);
    await today.start(ME.toHexString(), NOW);
    expect(read).toHaveBeenCalled();
    expect((jobs.rows.at(-1)!['input'] as TodayInput).notes[s.note.toHexString()]).toEqual(
      transcript,
    );
  });

  it('처리기가 실패로 끝냈으면 그 세트를 닫고 다시 만든다', async () => {
    const { today, seed, jobs, sets } = setup();
    await seed();
    const first = await today.start(ME.toHexString(), NOW);
    Object.assign(jobs.rows.at(-1)!, { status: 'failed', error: 'LLM' });
    const second = await today.start(ME.toHexString(), NOW);
    expect(second._id).not.toBe(first._id);
    expect(sets.rows.find((r) => String(r._id) === first._id)!['deletedAt']).toBeInstanceOf(Date);
  });

  it('작업 조회가 잠시 실패하면 오늘 세트를 닫지 않고 오류를 낸다', async () => {
    const { today, seed, sets } = setup();
    await seed();
    const first = await today.start(ME.toHexString(), NOW);
    const aiJobs = (today as unknown as { jobs: AiJobsService }).jobs;
    const read = vi.spyOn(aiJobs, 'findMine').mockRejectedValue(new Error('DB'));
    await expect(today.start(ME.toHexString(), NOW)).rejects.toThrow('DB');
    read.mockRestore();
    expect(sets.rows.find((r) => String(r._id) === first._id)!['deletedAt']).toBeNull();
    expect((await today.start(ME.toHexString(), NOW))._id).toBe(first._id);
  });

  it('다음 날에는 새로 만든다', async () => {
    const { today, seed, quizSets, jobs } = setup();
    await seed();
    const first = await today.start(ME.toHexString(), NOW);
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: { questions: [], srsUpdates: [] },
    });
    await quizSets.findMine(ME.toHexString(), first._id);
    expect(await today.get(ME.toHexString(), new Date('2026-11-17T03:00:00.000Z'))).toBeNull();
    const next = await today.start(ME.toHexString(), new Date('2026-11-17T03:00:00.000Z'));
    expect(next._id).not.toBe(first._id);
    expect(next.title).toBe('오늘의 복습 · 11-17');
  });

  it('전날 세트가 결과를 못 옮겨 만드는 중이면: 끝난 작업은 옮기고, 아직이면 닫고 오늘 세트를 만든다', async () => {
    const { today, seed, jobs, sets } = setup();
    await seed();
    const tomorrow = new Date('2026-11-17T03:00:00.000Z');
    const first = await today.start(ME.toHexString(), NOW);
    const next = await today.start(ME.toHexString(), tomorrow);
    expect(next._id).not.toBe(first._id);
    expect(next.title).toBe('오늘의 복습 · 11-17');
    expect(sets.rows.find((r) => String(r._id) === first._id)!['deletedAt']).toBeInstanceOf(Date);
    expect(jobs.rows[0]!['status']).toBe('canceled');

    // 끝났는데 아무도 조회하지 않은 전날 세트는 결과를 옮긴다(닫지 않음)
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: { questions: [], srsUpdates: [] },
    });
    const third = await today.start(ME.toHexString(), new Date('2026-11-18T03:00:00.000Z'));
    expect(third._id).not.toBe(next._id);
    const prev = sets.rows.find((r) => String(r._id) === next._id)!;
    expect(prev['status']).toBe('failed');
    expect(prev['deletedAt'] ?? null).toBeNull();
  });

  it('결과를 옮기면 문제(복습 상태 유지) · 기준 세트의 노트 · 복습 상태 · 무효 풀이를 반영한다', async () => {
    const { today, seed, jobs, quizSets, setUpdate, attemptUpdate } = setup();
    const s = await seed();
    const made = await today.start(ME.toHexString(), NOW);
    const copyId = new Types.ObjectId().toHexString();
    Object.assign(jobs.rows.at(-1)!, {
      status: 'succeeded',
      progress: 100,
      result: {
        questions: [
          {
            id: copyId,
            order: 1,
            prompt: '문제 1',
            choices: ['가', '나'],
            answer: '가',
            conceptTags: ['세포막'],
            srs: { step: 1 },
          },
        ],
        title: '오늘의 복습 · 11-16',
        baseSetId: s.set.toHexString(),
        srsUpdates: [
          {
            quizSetId: s.set.toHexString(),
            questionId: s.qs[0]!._id.toHexString(),
            srs: { moved: true },
          },
        ],
        voidAnswers: [
          {
            attemptId: s.attempt.toHexString(),
            questionId: s.qs[1]!._id.toHexString(),
            void: '정답 둘',
          },
        ],
      },
    });
    const ready = await quizSets.findMine(ME.toHexString(), made._id);
    expect(ready).toMatchObject({
      status: 'ready',
      questionCount: 1,
      materialId: s.note.toHexString(),
      folderId: FOLDER.toHexString(),
    });
    expect(ready.questions[0]!._id).toBe(copyId);
    expect(setUpdate).toHaveBeenCalledTimes(1);
    expect(attemptUpdate).toHaveBeenCalledWith(
      { _id: s.attempt, userId: ME },
      { $set: { 'answers.$[a].void': '정답 둘' } },
      { arrayFilters: [{ 'a.questionId': s.qs[1]!._id }] },
    );
  });
});

describe('오늘의 복습 입력 크기(fitTodayInput)', () => {
  const input = (): TodayInput => ({
    day: '2026-11-16',
    size: 5,
    sets: ['s1', 's2', 's3'].map((id, i) => ({
      id,
      materialId: `m${i + 1}`,
      questions: [{ prompt: 'x'.repeat(i === 0 ? 3000 : 100) }],
    })),
    attempts: [{ id: 'a1', quizSetId: 's1', finishedAt: '2026-11-15T00:00:00.000Z', answers: [] }],
    notes: {
      m1: [{ pageNo: 1, ocrText: '1' }],
      m2: [{ pageNo: 1, ocrText: '2' }],
      m3: [{ pageNo: 1, ocrText: '3' }],
    },
  });

  it('한도 안이면 그대로, 넘으면 최근 세트부터 넣고 만든 순서는 지킨다', () => {
    expect(fitTodayInput(input())).toEqual(input());
    const fitted = fitTodayInput(input(), 1500);
    expect(fitted.sets.map((s) => s.id)).toEqual(['s2', 's3']);
    expect(fitted.attempts).toEqual([]);
    expect(Object.keys(fitted.notes).sort()).toEqual(['m2', 'm3']);
  });

  it('세트가 하나도 안 들어가면 400', () => {
    expect(() => fitTodayInput(input(), 200)).toThrow(
      expect.objectContaining({ status: 400 }) as unknown as Error,
    );
  });
});
