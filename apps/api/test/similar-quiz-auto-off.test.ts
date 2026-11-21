import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import type { MaterialDocument } from '../src/modules/content/schemas/material.schema.js';
import type { QuizAttemptDocument } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import type { QuizSetDocument } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { autoSimilarOnFinish } from '../src/quiz-sets/auto-similar.js';
import { QuizSetsService, SIMILAR_TYPE } from '../src/quiz-sets/quiz-sets.service.js';
import { RecordingNotePagesService } from '../src/quiz-sets/recording-note-pages.service.js';
import { SimilarQuizService } from '../src/quiz-sets/similar-quiz.service.js';
import { createFakeCollection, type Row } from './support/fake-collection.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';

// 퀴즈를 끝낸 뒤 자동 오답 복습을 끈 기본 설정(#625): 사용자가 요청하지 않은 LLM 작업을 넣지 않고, 결과 화면의 유사 퀴즈
// (세트로 만들기)는 복습 상태를 옮기지 않는 고르기 모드로 만든다. 켜진 설정(되돌리기)은 similar-quiz.service.test.ts ·
// review-flow.test.ts가 본다
const ME = new Types.ObjectId();
const FOLDER = new Types.ObjectId();

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
  srs: { step: 0, streak: 1, reviews: 1, state: 'active', dueAt: new Date('2026-11-20T15:00:00Z') },
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
  const pages = new RecordingNotePagesService(jobs.model);
  const quizSets = new QuizSetsService(
    sets.model,
    materials.model,
    attempts.model,
    aiJobs,
    pages,
    createFakeCollection().model as never,
  );
  const similar = new SimilarQuizService(
    sets.model,
    attempts.model,
    materials.model,
    aiJobs,
    quizSets,
    pages,
  );
  /** 노트 · ready 세트 · 끝낸 풀이(wrong 번째 문제를 틀림, voids 번째 답은 무효) */
  const seed = async (
    over: { wrong?: number[]; voids?: number[]; reviewDay?: string; folder?: boolean } = {},
  ) => {
    const note = (await materials.model.create({
      ownerId: ME,
      folderId: FOLDER,
      title: '세포 생물학',
      deletedAt: null,
      pages: [{ pageNo: 1, ocrText: '세포막은 세포를 둘러싼다.' }],
    } as never)) as unknown as { _id: Types.ObjectId };
    const qs = [question(1), question(2), question(3)];
    const set = (await sets.model.create({
      ownerId: ME,
      materialId: note._id,
      ...(over.folder === false ? {} : { folderId: FOLDER }),
      source: 'ai_generated',
      sourceSetId: null,
      title: over.reviewDay ? '오늘의 복습 · 11-20' : '세포 생물학',
      status: 'ready',
      reviewDay: over.reviewDay ?? null,
      questions: qs,
      questionCount: qs.length,
      deletedAt: null,
    } as never)) as unknown as { _id: Types.ObjectId };
    const attempt = (await attempts.model.create({
      quizSetId: set._id,
      userId: ME,
      finishedAt: new Date(),
      answers: qs.map((q, i) => ({
        questionId: q._id,
        correct: !(over.wrong ?? [0]).includes(i),
        ...((over.voids ?? []).includes(i) ? { void: '정답 둘' } : {}),
      })),
    } as never)) as unknown as { _id: Types.ObjectId };
    return { note: note._id, set: set._id, attempt: attempt._id, qs };
  };
  return { sets, attempts, jobs, quizSets, similar, seed, updateOne };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('autoSimilarOnFinish(AUTO_SIMILAR_ON_FINISH)', () => {
  it("'true'(앞뒤 빈칸 · 대소문자 무시)일 때만 켜고, 없거나 다른 값이면 끈다(기본 꺼짐)", () => {
    expect(autoSimilarOnFinish({})).toBe(false);
    for (const off of ['', 'false', '0', '1', 'yes', 'on'])
      expect(autoSimilarOnFinish({ AUTO_SIMILAR_ON_FINISH: off })).toBe(false);
    for (const on of ['true', ' TRUE ', 'True'])
      expect(autoSimilarOnFinish({ AUTO_SIMILAR_ON_FINISH: on })).toBe(true);
  });

  it('인자가 없으면 지금 process.env를 읽는다', () => {
    vi.stubEnv('AUTO_SIMILAR_ON_FINISH', 'true');
    expect(autoSimilarOnFinish()).toBe(true);
    vi.stubEnv('AUTO_SIMILAR_ON_FINISH', '');
    expect(autoSimilarOnFinish()).toBe(false);
  });
});

describe('결과 화면의 유사 퀴즈(create, 세트로 만들기) — 자동 오답 복습 꺼짐', () => {
  it('그 풀이의 틀린 문제로 고르기 모드 작업을 넣는다: 복습 상태(srs)를 옮기는 오답 복습(run)을 쓰지 않는다', async () => {
    const { similar, seed, jobs } = setup();
    const s = await seed({ wrong: [0, 2] });

    const out = await similar.create(ME.toHexString(), s.set.toHexString());

    expect(out).toMatchObject({
      status: 'generating',
      title: '세포 생물학 · 유사 퀴즈',
      sourceSetId: s.set.toHexString(),
    });
    expect(jobs.rows).toHaveLength(1);
    const job = jobs.rows[0]!;
    expect(job['type']).toBe(SIMILAR_TYPE);
    const input = job['input'] as { mode?: string; picks?: unknown; attemptId?: string };
    expect(input.mode).toBe('pick');
    expect(input.attemptId).toBeUndefined();
    expect(input.picks).toEqual([
      { quizSetId: s.set.toHexString(), questionId: s.qs[0]!._id.toHexString(), wrong: true },
      { quizSetId: s.set.toHexString(), questionId: s.qs[2]!._id.toHexString(), wrong: true },
    ]);
  });

  it('오늘의 복습 세트 · 노트 폴더가 없는 옛 세트도 그 틀린 문제로 만든다', async () => {
    for (const over of [{ reviewDay: '2026-11-20' }, { folder: false }]) {
      const { similar, seed, jobs } = setup();
      const s = await seed(over);
      await similar.create(ME.toHexString(), s.set.toHexString());
      expect(
        (jobs.rows[0]!['input'] as { picks: { questionId: string }[] }).picks.map(
          (p) => p.questionId,
        ),
      ).toEqual([s.qs[0]!._id.toHexString()]);
    }
  });

  it('틀린 답이 모두 무효(결함 문제)면 409이고 작업을 넣지 않는다', async () => {
    const { similar, seed, jobs } = setup();
    const s = await seed({ wrong: [0], voids: [0] });
    await expect(similar.create(ME.toHexString(), s.set.toHexString())).rejects.toMatchObject({
      status: 409,
    });
    expect(jobs.rows).toHaveLength(0);
  });

  it('만든 세트에 원본 세트 · 풀이를 남긴다: 오늘의 복습에서 이어 만든 세트로 보고(폴더 삭제에서 남김) 앱이 원본을 거슬러 오른다', async () => {
    const { similar, seed, sets } = setup();
    const s = await seed({ reviewDay: '2026-11-20' });
    const out = await similar.create(ME.toHexString(), s.set.toHexString());
    expect(out.sourceSetId).toBe(s.set.toHexString());
    const row = sets.rows.find((r) => String(r._id) === out._id)!;
    expect(String(row['sourceAttemptId'])).toBe(s.attempt.toHexString());
  });

  it('같은 풀이로 다시 누르면 만드는 중 · 다 만든 그 세트를 돌려주고 작업을 더 넣지 않는다(실패한 세트는 새로 만듦)', async () => {
    const { similar, seed, sets, jobs } = setup();
    const s = await seed();
    const first = await similar.create(ME.toHexString(), s.set.toHexString());
    // 만드는 중에 다시 누름(같은 노트 만드는 중 색인에 막혀 409가 되지 않게)
    expect((await similar.create(ME.toHexString(), s.set.toHexString()))._id).toBe(first._id);
    // 다 만든 뒤 다시 누름
    Object.assign(
      sets.rows.find((r) => String(r._id) === first._id)!,
      { status: 'ready' },
    );
    expect((await similar.create(ME.toHexString(), s.set.toHexString()))._id).toBe(first._id);
    expect(jobs.rows).toHaveLength(1);
    // 실패로 끝났으면 다시 만든다
    Object.assign(
      sets.rows.find((r) => String(r._id) === first._id)!,
      { status: 'failed' },
    );
    const again = await similar.create(ME.toHexString(), s.set.toHexString());
    expect(again._id).not.toBe(first._id);
    expect(jobs.rows).toHaveLength(2);
  });

  it('설정을 끄기 전에 그 풀이로 만든 「다시 보기」 세트가 있으면 그 세트를 돌려주고 작업을 더 넣지 않는다', async () => {
    const { similar, seed, sets, jobs } = setup();
    const s = await seed();
    const made = (await sets.model.create({
      ownerId: ME,
      materialId: s.note,
      folderId: FOLDER,
      source: 'ai_generated',
      sourceSetId: s.set,
      sourceAttemptId: s.attempt,
      title: '세포 생물학 · 다시 보기',
      status: 'ready',
      questions: [question(1)],
      questionCount: 1,
      deletedAt: null,
    } as never)) as unknown as { _id: Types.ObjectId };

    const out = await similar.create(ME.toHexString(), s.set.toHexString());

    expect(out._id).toBe(made._id.toHexString());
    expect(jobs.rows).toHaveLength(0);
  });

  it('설정을 켜면 예전처럼 그 풀이로 오답 복습 작업(run)을 넣는다(되돌리기)', async () => {
    vi.stubEnv('AUTO_SIMILAR_ON_FINISH', 'true');
    const { similar, seed, jobs } = setup();
    const s = await seed();
    const out = await similar.create(ME.toHexString(), s.set.toHexString());
    expect(out.title).toBe('세포 생물학 · 다시 보기');
    const input = jobs.rows[0]!['input'] as { mode?: string; attemptId?: string };
    expect(input.mode).toBeUndefined();
    expect(input.attemptId).toBe(s.attempt.toHexString());
  });
});

describe('이어 받기(catchUp) — 자동 오답 복습 꺼짐', () => {
  /** 같은 노트로 만드는 중인 맞춤 퀴즈와, 그 세트에 막혀 기다리는 풀이(reviewPending) */
  const blocked = async () => {
    const t = setup();
    const s = await t.seed();
    const gen = (await t.sets.model.create({
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
    const job = await new AiJobsService(t.jobs.model).enqueue({
      type: 'quiz_generate',
      userId: ME.toHexString(),
      targetType: 'quiz_set',
      targetId: gen._id.toHexString(),
      input: {},
    });
    Object.assign(
      t.sets.rows.find((r) => String(r._id) === String(gen._id))!,
      { jobId: new Types.ObjectId(job._id) },
    );
    Object.assign(
      t.attempts.rows.find((r) => String(r._id) === String(s.attempt))!,
      { reviewPending: true },
    );
    // 맞춤 퀴즈가 끝남(실패): 결과를 옮길 때 기다리던 풀이를 이어 받는다
    Object.assign(t.jobs.rows[0]!, { status: 'failed', error: 'x' });
    return { ...t, gen: gen._id };
  };
  const similarJobs = (rows: Row[]) =>
    rows.filter((j) => j['type'] === SIMILAR_TYPE && j['status'] !== 'canceled');

  it('막은 세트가 끝나도 기다리던 풀이에 오답 복습 작업을 넣지 않는다', async () => {
    const { quizSets, jobs, gen } = await blocked();
    await quizSets.findMine(ME.toHexString(), gen.toHexString());
    expect(similarJobs(jobs.rows)).toHaveLength(0);
  });

  it('설정을 켜면 예전처럼 이어 받는다(되돌리기)', async () => {
    vi.stubEnv('AUTO_SIMILAR_ON_FINISH', 'true');
    const { quizSets, jobs, gen } = await blocked();
    await quizSets.findMine(ME.toHexString(), gen.toHexString());
    expect(similarJobs(jobs.rows)).toHaveLength(1);
  });
});
