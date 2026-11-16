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

// quiz-set.schema.ts 고유 색인: 같은 노트(노트 없음 포함)로 만드는 중인 세트는 하나
const live = (r: Row) => r['status'] === 'generating' && (r['deletedAt'] ?? null) === null;
const unique = (a: Row, b: Row) =>
  String(a._id) === String(b._id) ||
  (live(a) &&
    live(b) &&
    String(a['ownerId']) === String(b['ownerId']) &&
    String(a['materialId'] ?? null) === String(b['materialId'] ?? null));

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
  const quizSets = new QuizSetsService(sets.model, materials.model, attempts.model, aiJobs);
  const similar = new SimilarQuizService(
    sets.model,
    attempts.model,
    materials.model,
    aiJobs,
    quizSets,
  );
  const today = new TodayReviewService(
    sets.model,
    attempts.model,
    materials.model,
    aiJobs,
    quizSets,
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
  return { sets, attempts, jobs, quizSets, similar, today, seed, setUpdate, attemptUpdate };
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

  it('처리기가 실패로 끝냈으면 그 세트를 닫고 다시 만든다', async () => {
    const { today, seed, jobs, sets } = setup();
    await seed();
    const first = await today.start(ME.toHexString(), NOW);
    Object.assign(jobs.rows.at(-1)!, { status: 'failed', error: 'LLM' });
    const second = await today.start(ME.toHexString(), NOW);
    expect(second._id).not.toBe(first._id);
    expect(sets.rows.find((r) => String(r._id) === first._id)!['deletedAt']).toBeInstanceOf(Date);
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
