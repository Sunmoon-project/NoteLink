import { AiJob, QuizSet } from '@notelink/shared';
import { mongo, Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import {
  fitInput,
  INPUT_ATTEMPT_LIMIT,
  INPUT_BYTE_LIMIT,
  nextSetId,
  QUIZ_MIN_LINES,
  QUIZ_SET_SIZE,
  QuizSetsService,
  seoulDay,
  type WorkerInput,
} from '../src/quiz-sets/quiz-sets.service.js';
import type { MaterialDocument } from '../src/modules/content/schemas/material.schema.js';
import {
  QuizAttemptSchema,
  type QuizAttemptDocument,
} from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import {
  QuizSetSchema,
  type QuizSetDocument,
} from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { createFakeCollection, type Row } from './support/fake-collection.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';

/** 처리기가 물을 수 있는 쪽 글(QUIZ_MIN_LINES줄) */
const NOTE_TEXT =
  '세포막은 세포를 둘러싼다.\n핵에는 DNA가 있다.\n리보솜은 단백질을 만든다.\n미토콘드리아는 에너지를 만든다.\n골지체는 단백질을 포장한다.';

const ME = new Types.ObjectId();
const OTHER = new Types.ObjectId();
const FOLDER = new Types.ObjectId();

/** 처리기 result.questions의 한 문제(apps/ai services/quiz/generate.py run) */
const workerQuestion = (order: number, over: Record<string, unknown> = {}) => ({
  id: new Types.ObjectId().toHexString(),
  order,
  type: '빈칸',
  prompt: '빈칸에 들어갈 말은?',
  passage: '세포는 ____ 로 둘러싸여 있다.',
  choices: ['세포막', '핵', '리보솜', '골지체'],
  answer: '세포막',
  explanation: '세포막이 세포를 둘러싼다.',
  conceptTags: ['세포막'],
  difficulty: '하',
  srs: null,
  ...over,
});
/** 처리기가 QUIZ_SET_SIZE개를 다 만든 결과의 문제들(order from부터) */
const fullSet = (from = 1) =>
  Array.from({ length: QUIZ_SET_SIZE }, (_, i) => workerQuestion(from + i));

// quiz-set.schema.ts 고유 색인: 만드는 중 · 지우지 않은 세트만
const live = (r: Row) => r['status'] === 'generating' && (r['deletedAt'] ?? null) === null;
const sameGenerating = (a: Row, b: Row) =>
  live(a) &&
  live(b) &&
  String(a['ownerId']) === String(b['ownerId']) &&
  String(a['materialId']) === String(b['materialId']);

// MongoDB는 _id도 늘 고유 색인이다(끝난 미리 만들기로 만드는 세트는 그 작업과 같은 id를 쓴다)
const sameId = (a: Row, b: Row) => String(a._id) === String(b._id);

function setup() {
  const sets = createFakeCollection<QuizSetDocument>(
    (a, b) => sameId(a, b) || sameGenerating(a, b),
  );
  const materials = createFakeCollection<MaterialDocument>();
  const attempts = createFakeCollection<QuizAttemptDocument>();
  const aggregate = vi.fn().mockResolvedValue([]);
  Object.assign(attempts.model, { aggregate });
  const jobs = createFakeJobs();
  const aiJobs = new AiJobsService(jobs.model);
  const service = new QuizSetsService(sets.model, materials.model, attempts.model, aiJobs);
  const addNote = async (over: Record<string, unknown> = {}) => {
    const { _id } = (await materials.model.create({
      ownerId: ME,
      folderId: FOLDER,
      title: '세포 생물학',
      deletedAt: null,
      pages: [
        { pageNo: 1, ocrText: NOTE_TEXT },
        { pageNo: 2, ocrText: '   ' },
        { pageNo: 3, ocrText: null },
      ],
      ...over,
    } as never)) as unknown as { _id: Types.ObjectId };
    return _id.toHexString();
  };
  const job = (id: string) => jobs.rows.find((r) => r._id.toString() === id)!;
  const set = (id: string) => sets.rows.find((r) => r._id.toString() === id)!;
  const finish = (id: string, result: Record<string, unknown>) =>
    Object.assign(job(id), { status: 'succeeded', progress: 100, result });
  return { service, aiJobs, sets, materials, attempts, jobs, addNote, job, set, finish, aggregate };
}

const notFound = { status: 404, response: { code: 'NOT_FOUND' } };

describe('QuizSetsService.create', () => {
  it('일반 생성과 미리 만들기 모두 전체 유형별 통계를 AI 작업에 전달한다', async () => {
    const { service, aggregate, addNote, job } = setup();
    aggregate.mockResolvedValue([{ _id: '조합', answered: 40, correct: 36 }]);
    const first = await service.create(ME.toHexString(), await addNote());
    const second = await service.pregenerate(ME.toHexString(), await addNote());
    expect((job(first.job._id).input as WorkerInput).typeStats).toEqual({
      조합: { answered: 40, correct: 36 },
    });
    expect((job(second!._id).input as WorkerInput).typeStats).toEqual({
      조합: { answered: 40, correct: 36 },
    });
    expect(aggregate).toHaveBeenCalledTimes(1);
  });

  it('전체 통계를 읽을 수 없으면 기본 난이도로 조용히 진행하지 않는다', async () => {
    const { service, aggregate, addNote, jobs } = setup();
    aggregate.mockRejectedValueOnce(new Error('statistics unavailable'));
    await expect(service.create(ME.toHexString(), await addNote())).rejects.toThrow(
      'statistics unavailable',
    );
    expect(jobs.rows).toHaveLength(0);
  });

  it('동시에 생성하면 통계 집계 하나를 공유하고 실패 후 재시도할 수 있다', async () => {
    const { service, aggregate, addNote } = setup();
    const first = await addNote();
    const second = await addNote();
    let resolve!: (rows: { _id: string; answered: number; correct: number }[]) => void;
    aggregate.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const a = service.pregenerate(ME.toHexString(), first);
    const b = service.pregenerate(ME.toHexString(), second);
    await vi.waitFor(() => expect(aggregate).toHaveBeenCalledTimes(1));
    resolve([{ _id: '규칙', answered: 30, correct: 20 }]);
    await Promise.all([a, b]);
    expect(aggregate).toHaveBeenCalledTimes(1);

    const next = setup();
    next.aggregate.mockRejectedValueOnce(new Error('통계 오류')).mockResolvedValueOnce([]);
    const note = await next.addNote();
    await expect(next.service.pregenerate(ME.toHexString(), note)).rejects.toThrow('통계 오류');
    await expect(next.service.pregenerate(ME.toHexString(), note)).resolves.not.toBeNull();
    expect(next.aggregate).toHaveBeenCalledTimes(2);
  });
  it('만드는 중인 세트를 만들고 quiz_generate 작업을 넣어 { quizSet, job }을 돌려준다', async () => {
    const { service, addNote, job, set } = setup();
    const materialId = await addNote();
    const { quizSet, job: created } = await service.create(ME.toHexString(), materialId);

    expect(QuizSet.parse(quizSet)).toEqual(quizSet);
    expect(AiJob.parse(created)).toEqual(created);
    expect(quizSet).toMatchObject({
      materialId,
      folderId: FOLDER.toHexString(),
      title: '세포 생물학',
      status: 'generating',
      questions: [],
    });
    expect(created).toMatchObject({
      type: 'quiz_generate',
      status: 'queued',
      targetType: 'quiz_set',
      targetId: quizSet._id,
    });
    expect(String(set(quizSet._id)['jobId'])).toBe(created._id);

    const input = job(created._id)['input'] as Record<string, unknown>;
    expect(input['day']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 글이 없는 쪽(공백 · 정리 전)은 넣지 않는다
    expect(input['material']).toEqual({
      id: materialId,
      title: '세포 생물학',
      pages: [{ pageNo: 1, ocrText: NOTE_TEXT }],
    });
    expect(input).toMatchObject({ size: QUIZ_SET_SIZE, sets: [], attempts: [], notes: {} });
  });

  it.each([
    ['남의 노트', { ownerId: OTHER }],
    ['지운 노트', { deletedAt: new Date() }],
  ])('%s는 404', async (_name, over) => {
    const { service, addNote, jobs } = setup();
    const materialId = await addNote(over);
    await expect(service.create(ME.toHexString(), materialId)).rejects.toMatchObject(notFound);
    expect(jobs.rows).toHaveLength(0);
  });

  it('없는 노트 · 형식이 틀린 id는 404', async () => {
    const { service } = setup();
    await expect(
      service.create(ME.toHexString(), new Types.ObjectId().toHexString()),
    ).rejects.toMatchObject(notFound);
    await expect(service.create(ME.toHexString(), 'abc')).rejects.toMatchObject(notFound);
  });

  it('노트 글이 없으면(정리 전) 400 VALIDATION_FAILED이고 작업을 넣지 않는다', async () => {
    const { service, addNote, jobs, sets } = setup();
    const materialId = await addNote({ pages: [{ pageNo: 1, ocrText: null }] });
    await expect(service.create(ME.toHexString(), materialId)).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_FAILED' },
    });
    expect(jobs.rows).toHaveLength(0);
    expect(sets.rows).toHaveLength(0);
  });

  it.each([
    ['줄이 적음', ['가', '나', '다', '라'].join('\n')],
    ['[?] 줄을 빼면 적음', ['가', '나 [?]', '다', '라', '마 [?]', '', '바'].join('\n')],
    // Python strip()은 지우고 JS trim()은 남기는 글자만 있는 줄(처리기는 빈 줄로 뺀다)
    ['빈 줄로 보는 글자', ['가', '나', '다', '라', '\x1c\x85'].join('\n')],
  ])(
    '물을 수 있는 쪽이 없으면(%s) 400 VALIDATION_FAILED이고 작업을 넣지 않는다',
    async (_name, text) => {
      const { service, addNote, jobs, sets } = setup();
      const materialId = await addNote({ pages: [{ pageNo: 1, ocrText: text }] });
      await expect(service.create(ME.toHexString(), materialId)).rejects.toMatchObject({
        status: 400,
        response: {
          code: 'VALIDATION_FAILED',
          message: expect.stringContaining(`${QUIZ_MIN_LINES}줄 이상`),
        },
      });
      expect(jobs.rows).toHaveLength(0);
      expect(sets.rows).toHaveLength(0);
    },
  );

  it('[?] 줄을 빼고도 QUIZ_MIN_LINES줄 남는 쪽이 하나라도 있으면 만든다(글은 그대로 보냄)', async () => {
    const { service, addNote, job } = setup();
    const text = [...Array.from({ length: QUIZ_MIN_LINES }, (_, i) => `줄 ${i}`), '흐림 [?]'].join(
      '\n',
    );
    const materialId = await addNote({
      pages: [
        { pageNo: 1, ocrText: '짧은 쪽' },
        { pageNo: 2, ocrText: text },
      ],
    });
    const { job: created } = await service.create(ME.toHexString(), materialId);
    const input = job(created._id)['input'] as { material: { pages: unknown[] } };
    expect(input.material.pages).toEqual([
      { pageNo: 1, ocrText: '짧은 쪽' },
      { pageNo: 2, ocrText: text },
    ]);
  });

  it('만드는 중인 세트가 있으면 그사이 노트 글이 줄어도 400이 아니라 그 세트를 돌려준다', async () => {
    const { service, addNote, materials } = setup();
    const materialId = await addNote();
    const first = await service.create(ME.toHexString(), materialId);
    Object.assign(materials.rows[0]!, { pages: [{ pageNo: 1, ocrText: '짧은 쪽' }] });
    const again = await service.create(ME.toHexString(), materialId);
    expect(again.quizSet._id).toBe(first.quizSet._id);
  });

  it('같은 노트에 만드는 중인 세트가 있으면 새로 만들지 않고 그 세트 · 작업을 돌려준다', async () => {
    const { service, addNote, jobs, sets } = setup();
    const materialId = await addNote();
    const first = await service.create(ME.toHexString(), materialId);
    const again = await service.create(ME.toHexString(), materialId);
    expect(again.quizSet._id).toBe(first.quizSet._id);
    expect(again.job._id).toBe(first.job._id);
    expect(jobs.rows).toHaveLength(1);
    expect(sets.rows).toHaveLength(1);
  });

  it('거의 동시에 두 번 와도 세트는 하나이고, 늦은 쪽이 넣은 작업은 취소한다', async () => {
    const { service, addNote, jobs, sets } = setup();
    const materialId = await addNote();
    const [a, b] = await Promise.all([
      service.create(ME.toHexString(), materialId),
      service.create(ME.toHexString(), materialId),
    ]);
    expect(a.quizSet._id).toBe(b.quizSet._id);
    expect(sets.rows).toHaveLength(1);
    const statuses = jobs.rows.map((r) => r['status']).sort();
    expect(statuses).toEqual(['canceled', 'queued']);
  });

  it('노트의 미리 만들기가 끝나지 않았으면 새 작업 대신 이어받는다(#134)', async () => {
    const { service, aiJobs, addNote, jobs } = setup();
    const materialId = await addNote();
    const pregen = await aiJobs.enqueue({
      type: 'quiz_pregen',
      userId: ME.toHexString(),
      targetType: 'material',
      targetId: materialId,
      input: {},
    });
    const { job } = await service.create(ME.toHexString(), materialId);
    expect(job).toMatchObject({ _id: pregen._id, type: 'quiz_pregen', awaited: true });
    expect(jobs.rows).toHaveLength(1);
  });

  it('지난 세트 · 끝낸 풀이 · 그 세트의 다른 노트 글을 처리기 입력에 담는다', async () => {
    const { service, addNote, sets, attempts, job } = setup();
    const materialId = await addNote();
    const otherNote = await addNote({ title: '유전', pages: [{ pageNo: 4, ocrText: 'DNA' }] });
    const qid = new Types.ObjectId();
    const old = (await sets.model.create({
      ownerId: ME,
      materialId: new Types.ObjectId(otherNote),
      folderId: FOLDER,
      title: '유전 퀴즈',
      status: 'ready',
      deletedAt: null,
      questions: [
        {
          _id: qid,
          order: 1,
          type: 'multiple_choice',
          category: '정의',
          prompt: 'DNA는?',
          passage: null,
          choices: ['유전 물질', '단백질'],
          answer: '유전 물질',
          explanation: null,
          conceptTags: ['DNA'],
          difficulty: '중',
          srs: null,
        },
      ],
    } as never)) as unknown as { _id: Types.ObjectId };
    const finishedAt = new Date('2026-11-07T03:00:00Z');
    await attempts.model.create({
      userId: ME,
      quizSetId: old._id,
      finishedAt,
      answers: [{ questionId: qid, correct: false, answer: '단백질', tries: 1 }],
    } as never);
    await attempts.model.create({ userId: ME, quizSetId: old._id, finishedAt: null } as never);
    await attempts.model.create({ userId: OTHER, quizSetId: old._id, finishedAt } as never);

    const { job: created } = await service.create(ME.toHexString(), materialId);
    const input = job(created._id)['input'] as Record<string, unknown>;
    expect(input['sets']).toEqual([
      {
        id: old._id.toHexString(),
        materialId: otherNote,
        questions: [
          {
            id: qid.toHexString(),
            order: 1,
            prompt: 'DNA는?',
            choices: ['유전 물질', '단백질'],
            answer: '유전 물질',
            type: '정의',
            conceptTags: ['DNA'],
            difficulty: '중', // 처리기가 정답률로 고칠 때 씀(#268)
            srs: null,
          },
        ],
      },
    ]);
    expect(input['attempts']).toEqual([
      {
        id: expect.any(String),
        quizSetId: old._id.toHexString(),
        finishedAt: finishedAt.toISOString(),
        answers: [{ questionId: qid.toHexString(), correct: false }],
      },
    ]);
    expect(input['notes']).toEqual({ [otherNote]: [{ pageNo: 4, ocrText: 'DNA' }] });
  });
});

describe('QuizSetsService 작업 결과 반영', () => {
  it('작업이 성공하면 문제를 세트에 옮겨 ready로(지문은 질문 아래에, 갈래는 따로 저장)', async () => {
    const { service, addNote, finish, set } = setup();
    const materialId = await addNote();
    const { quizSet, job } = await service.create(ME.toHexString(), materialId);
    const q1 = workerQuestion(1);
    const q2 = workerQuestion(2, { type: '정의', passage: null, choices: null, answer: '세포막' });
    finish(job._id, {
      questions: [q1, q2, ...fullSet(3).slice(0, QUIZ_SET_SIZE - 2)],
      title: '세포 생물학 맞춤 퀴즈 · 11-08',
      concepts: null,
    });

    const ready = await service.findMine(ME.toHexString(), quizSet._id);
    expect(QuizSet.parse(ready)).toEqual(ready);
    expect(ready).toMatchObject({
      status: 'ready',
      progress: 100,
      questionCount: QUIZ_SET_SIZE,
      title: '세포 생물학 맞춤 퀴즈 · 11-08',
    });
    expect(ready.questions[0]).toEqual({
      _id: q1.id,
      order: 1,
      type: 'multiple_choice',
      prompt: '빈칸에 들어갈 말은?\n\n세포는 ____ 로 둘러싸여 있다.',
      choices: q1.choices,
      answer: '세포막',
      explanation: '세포막이 세포를 둘러싼다.',
      conceptTags: ['세포막'],
      difficulty: '하',
    });
    expect(ready.questions[1]).toMatchObject({ type: 'short_answer', choices: null });
    const stored = (set(quizSet._id)['questions'] as Record<string, unknown>[])[0]!;
    expect(stored).toMatchObject({
      category: '빈칸',
      passage: '세포는 ____ 로 둘러싸여 있다.',
      difficulty: '하',
    });
  });

  it('난이도는 하 · 중 · 상만 저장하고, 없거나 다른 값이면 문제는 두고 null로(#268)', async () => {
    const { service, addNote, finish, set } = setup();
    const materialId = await addNote();
    const { quizSet, job } = await service.create(ME.toHexString(), materialId);
    finish(job._id, {
      questions: [
        workerQuestion(1, { difficulty: '상' }),
        workerQuestion(2, { difficulty: '어려움' }),
        workerQuestion(3, { difficulty: undefined }),
        ...fullSet(4).slice(0, QUIZ_SET_SIZE - 3),
      ],
      title: '세포 생물학 맞춤 퀴즈 · 11-08',
      concepts: null,
    });

    const ready = await service.findMine(ME.toHexString(), quizSet._id);
    expect(QuizSet.parse(ready)).toEqual(ready);
    expect(ready.questions.slice(0, 3).map((q) => q.difficulty)).toEqual(['상', null, null]);
    const stored = set(quizSet._id)['questions'] as Record<string, unknown>[];
    expect(stored.slice(0, 3).map((q) => q['difficulty'])).toEqual(['상', null, null]);
  });

  it('처리 중이면 작업 진행률을 담고 세트는 그대로 만드는 중', async () => {
    const { service, addNote, job } = setup();
    const materialId = await addNote();
    const created = await service.create(ME.toHexString(), materialId);
    Object.assign(job(created.job._id), { status: 'running', progress: 40 });
    expect(await service.findMine(ME.toHexString(), created.quizSet._id)).toMatchObject({
      status: 'generating',
      progress: 40,
    });
  });

  it.each([
    ['작업 실패', { status: 'failed', error: '처리 중 오류' }],
    ['작업 취소', { status: 'canceled' }],
    ['한 문제도 못 만듦', { status: 'succeeded', result: { questions: [], title: 't' } }],
    [
      '문제 모양이 틀림',
      { status: 'succeeded', result: { questions: [{ id: 'x', prompt: 'p' }], title: 't' } },
    ],
  ])('%s이면 세트를 failed로', async (_name, state) => {
    const { service, addNote, job } = setup();
    const materialId = await addNote();
    const created = await service.create(ME.toHexString(), materialId);
    Object.assign(job(created.job._id), state);
    expect(await service.findMine(ME.toHexString(), created.quizSet._id)).toMatchObject({
      status: 'failed',
      questions: [],
    });
  });

  it('실패한 세트가 있으면 다시 요청할 때 새 세트를 만든다(실패 화면의 다시 시도)', async () => {
    const { service, addNote, job, sets } = setup();
    const materialId = await addNote();
    const first = await service.create(ME.toHexString(), materialId);
    Object.assign(job(first.job._id), { status: 'failed' });
    const again = await service.create(ME.toHexString(), materialId);
    expect(again.quizSet._id).not.toBe(first.quizSet._id);
    expect(again.job._id).not.toBe(first.job._id);
    expect(sets.rows.map((r) => r['status']).sort()).toEqual(['failed', 'generating']);
  });

  it('여러 번 조회해도 결과는 한 번만 옮긴다', async () => {
    const { service, addNote, finish, sets } = setup();
    const materialId = await addNote();
    const { quizSet, job } = await service.create(ME.toHexString(), materialId);
    finish(job._id, { questions: fullSet(), title: 't' });
    await Promise.all([
      service.findMine(ME.toHexString(), quizSet._id),
      service.findMine(ME.toHexString(), quizSet._id),
    ]);
    expect(sets.rows).toHaveLength(1);
    expect(sets.rows[0]!['questionCount']).toBe(QUIZ_SET_SIZE);
  });
});

describe('QuizSetsService 난이도를 붙이기 전 문제(Codex 리뷰 #292)', () => {
  it('difficulty가 없는 저장 문제는 앱에 null로 보내고, 처리기 입력에는 넣지 않는다', async () => {
    const { service, addNote, sets, job } = setup();
    const otherNote = await addNote({ title: '유전', pages: [{ pageNo: 4, ocrText: 'DNA' }] });
    const qid = new Types.ObjectId();
    // 난이도 필드가 생기기 전에 저장한 문서(필드 자체가 없음)
    const old = (await sets.model.create({
      ownerId: ME,
      materialId: new Types.ObjectId(otherNote),
      folderId: FOLDER,
      title: '유전 퀴즈',
      status: 'ready',
      deletedAt: null,
      questions: [
        {
          _id: qid,
          order: 1,
          type: 'multiple_choice',
          category: '정의',
          prompt: 'DNA는?',
          passage: null,
          choices: ['유전 물질', '단백질'],
          answer: '유전 물질',
          explanation: null,
          conceptTags: ['DNA'],
          srs: null,
        },
      ],
    } as never)) as unknown as { _id: Types.ObjectId };

    const shown = await service.findMine(ME.toHexString(), old._id.toHexString());
    expect(QuizSet.parse(shown)).toEqual(shown);
    expect(shown.questions[0]!.difficulty).toBeNull();

    const { job: created } = await service.create(ME.toHexString(), await addNote());
    const input = job(created._id)['input'] as { sets: { questions: Record<string, unknown>[] }[] };
    const sent = input.sets.find((x) => x.questions[0]?.['id'] === qid.toHexString())!;
    expect(sent.questions[0]).not.toHaveProperty('difficulty');
  });
});

describe('QuizSetsService 리뷰 반영(/code-review)', () => {
  it('모양이 틀린 문제만 빼고 나머지로 ready, 번호는 1부터 다시 매긴다', async () => {
    const { service, addNote, finish } = setup();
    const { quizSet, job } = await service.create(ME.toHexString(), await addNote());
    const good = fullSet(2);
    finish(job._id, { questions: [{ id: 'x', prompt: 'p' }, ...good], title: 't' });
    const ready = await service.findMine(ME.toHexString(), quizSet._id);
    expect(ready).toMatchObject({ status: 'ready', questionCount: QUIZ_SET_SIZE });
    expect(ready.questions.map((q) => q._id)).toEqual(good.map((q) => q.id));
    expect(ready.questions.map((q) => q.order)).toEqual(good.map((_, i) => i + 1));
  });

  it('번호는 처리기의 order 차례대로 다시 매긴다(배열 차례가 달라도)', async () => {
    const { service, addNote, finish } = setup();
    const { quizSet, job } = await service.create(ME.toHexString(), await addNote());
    const good = fullSet();
    finish(job._id, { questions: [...good].reverse(), title: 't' });
    const ready = await service.findMine(ME.toHexString(), quizSet._id);
    expect(ready.questions.map((q) => q._id)).toEqual(good.map((q) => q.id));
  });

  it('처리기 결과가 모자라도(처리기는 #247부터 실패로 끝냄) 받은 만큼 ready로 둔다', async () => {
    const { service, addNote, finish } = setup();
    const { quizSet, job } = await service.create(ME.toHexString(), await addNote());
    finish(job._id, { questions: fullSet().slice(0, 2), title: 't' });
    expect(await service.findMine(ME.toHexString(), quizSet._id)).toMatchObject({
      status: 'ready',
      questionCount: 2,
    });
  });

  it('failed 세트도 작업이 나중에 성공하면(다시 시도) ready로 되살린다', async () => {
    const { service, aiJobs, addNote, job, finish } = setup();
    const { quizSet, job: created } = await service.create(ME.toHexString(), await addNote());
    Object.assign(job(created._id), { status: 'failed', error: '처리 중 오류' });
    expect((await service.findMine(ME.toHexString(), quizSet._id)).status).toBe('failed');
    await aiJobs.retry(ME.toHexString(), created._id);
    finish(created._id, { questions: fullSet(), title: 't' });
    expect(await service.findMine(ME.toHexString(), quizSet._id)).toMatchObject({
      status: 'ready',
      questionCount: QUIZ_SET_SIZE,
    });
  });

  it('세트를 저장하지 못하면(중복 말고 다른 오류) 넣은 작업을 거둔다', async () => {
    const { service, addNote, sets, jobs } = setup();
    const materialId = await addNote();
    const create = sets.model.create.bind(sets.model);
    (sets.model as unknown as { create: unknown }).create = () =>
      Promise.reject(new Error('DB 쓰기 실패'));
    await expect(service.create(ME.toHexString(), materialId)).rejects.toThrow('DB 쓰기 실패');
    expect(jobs.rows.map((r) => r['status'])).toEqual(['canceled']);
    (sets.model as unknown as { create: unknown }).create = create;
  });

  it('이어받은 미리 만들기는 앱이 취소해도 지우지 않고 이어받기만 푼다', async () => {
    const { service, aiJobs, addNote, job } = setup();
    const materialId = await addNote();
    const pregen = await aiJobs.enqueue({
      type: 'quiz_pregen',
      userId: ME.toHexString(),
      targetType: 'material',
      targetId: materialId,
      input: {},
    });
    const { quizSet } = await service.create(ME.toHexString(), materialId);
    await aiJobs.cancel(ME.toHexString(), pregen._id);
    expect(job(pregen._id)).toMatchObject({ status: 'queued', awaited: false });
    expect((await service.findMine(ME.toHexString(), quizSet._id)).status).toBe('generating');
  });

  it('order가 정수가 아닌 문제는 뺀다(처리기 parse_question은 정수만 받는다)', async () => {
    const { service, addNote, finish } = setup();
    const { quizSet, job } = await service.create(ME.toHexString(), await addNote());
    const good = fullSet(2);
    finish(job._id, { questions: [workerQuestion(1.5), ...good], title: 't' });
    const ready = await service.findMine(ME.toHexString(), quizSet._id);
    expect(ready).toMatchObject({ status: 'ready', questionCount: QUIZ_SET_SIZE });
    expect(ready.questions.map((q) => q._id)).toEqual(good.map((q) => q.id));
  });

  it('미리 만들기를 이어받을 때 거의 동시에 두 번 와도 늦은 쪽이 이어받기를 풀지 않는다', async () => {
    const { service, aiJobs, addNote, job, sets } = setup();
    const materialId = await addNote();
    const pregen = await aiJobs.enqueue({
      type: 'quiz_pregen',
      userId: ME.toHexString(),
      targetType: 'material',
      targetId: materialId,
      input: {},
    });
    const [a, b] = await Promise.all([
      service.create(ME.toHexString(), materialId),
      service.create(ME.toHexString(), materialId),
    ]);
    expect(a.quizSet._id).toBe(b.quizSet._id);
    expect(sets.rows).toHaveLength(1);
    expect(job(pregen._id)).toMatchObject({ status: 'queued', awaited: true });
  });

  it('앱이 떠나 이어받기가 풀린 뒤 다시 요청하면 그 미리 만들기를 다시 이어받는다', async () => {
    const { service, aiJobs, addNote, job } = setup();
    const materialId = await addNote();
    const pregen = await aiJobs.enqueue({
      type: 'quiz_pregen',
      userId: ME.toHexString(),
      targetType: 'material',
      targetId: materialId,
      input: {},
    });
    const first = await service.create(ME.toHexString(), materialId);
    await aiJobs.cancel(ME.toHexString(), pregen._id);
    const again = await service.create(ME.toHexString(), materialId);
    expect(again.quizSet._id).toBe(first.quizSet._id);
    expect(again.job).toMatchObject({ _id: pregen._id, awaited: true });
    expect(job(pregen._id)).toMatchObject({ status: 'queued', awaited: true });
  });

  it('처리기 입력에는 보내는 세트의 풀이만 담는다', async () => {
    const { service, addNote, sets, attempts, job } = setup();
    const gone = (await sets.model.create({
      ownerId: ME,
      materialId: new Types.ObjectId(),
      title: '지운 세트',
      status: 'ready',
      deletedAt: new Date(),
      questions: [],
    } as never)) as unknown as { _id: Types.ObjectId };
    await attempts.model.create({
      userId: ME,
      quizSetId: gone._id,
      finishedAt: new Date(),
      answers: [],
    } as never);
    const { job: created } = await service.create(ME.toHexString(), await addNote());
    expect((job(created._id)['input'] as Record<string, unknown>)['attempts']).toEqual([]);
  });

  it('고유 색인은 만드는 중 · 지우지 않은 세트만 센다(위 가짜 sameGenerating과 같은 조건)', () => {
    expect(QuizSetSchema.indexes()).toContainEqual([
      { ownerId: 1, materialId: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: { status: 'generating', deletedAt: { $type: 'null' } },
      }),
    ]);
  });

  it('처리기 입력의 풀이를 읽는 색인(내 풀이 · 최근 것부터)', () => {
    expect(QuizAttemptSchema.indexes()).toContainEqual([
      { userId: 1, finishedAt: -1 },
      expect.anything(),
    ]);
  });

  it('지운 만드는 중 세트는 같은 노트의 새 세트를 막지 않는다', async () => {
    const { service, addNote, sets } = setup();
    const materialId = await addNote();
    const first = await service.create(ME.toHexString(), materialId);
    // 고유 색인의 $type: 'null'은 필드가 없는 문서를 세지 않아 만들 때 null을 넣는다
    expect(sets.rows[0]).toHaveProperty('deletedAt', null);
    sets.rows[0]!['deletedAt'] = new Date();
    const again = await service.create(ME.toHexString(), materialId);
    expect(again.quizSet._id).not.toBe(first.quizSet._id);
    expect(again.quizSet.status).toBe('generating');
  });

  it(`처리기 입력의 풀이는 최근 ${INPUT_ATTEMPT_LIMIT}개까지`, async () => {
    const { service, addNote, sets, attempts, job } = setup();
    const ready = (await sets.model.create({
      ownerId: ME,
      materialId: new Types.ObjectId(),
      title: '지난 세트',
      status: 'ready',
      deletedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      questions: [],
    } as never)) as unknown as { _id: Types.ObjectId };
    const start = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i <= INPUT_ATTEMPT_LIMIT; i += 1) {
      await attempts.model.create({
        userId: ME,
        quizSetId: ready._id,
        finishedAt: new Date(start + i * 60_000),
        answers: [],
      } as never);
    }
    const { job: created } = await service.create(ME.toHexString(), await addNote());
    const sent = (job(created._id)['input'] as Record<string, unknown>)['attempts'] as {
      finishedAt: string;
    }[];
    expect(sent).toHaveLength(INPUT_ATTEMPT_LIMIT);
    // 가장 오래된 풀이(i = 0)가 빠진다
    expect(sent.map((a) => Date.parse(a.finishedAt))).not.toContain(start);
  });
});

describe('QuizSetsService 조회', () => {
  it('목록은 내 세트만 최근 것부터, 만드는 중인 세트는 결과를 옮겨서', async () => {
    const { service, addNote, finish } = setup();
    const a = await service.create(ME.toHexString(), await addNote());
    const b = await service.create(ME.toHexString(), await addNote({ title: '두 번째' }));
    await service.create(OTHER.toHexString(), await addNote({ ownerId: OTHER }));
    finish(a.job._id, { questions: fullSet(), title: '첫 번째 퀴즈' });
    const list = await service.list(ME.toHexString());
    expect(list.map((s) => s._id)).toEqual([b.quizSet._id, a.quizSet._id]);
    expect(list[1]).toMatchObject({ status: 'ready', title: '첫 번째 퀴즈' });
  });

  it('남의 세트 · 없는 세트 · 형식이 틀린 id는 404', async () => {
    const { service, addNote } = setup();
    const theirs = await service.create(OTHER.toHexString(), await addNote({ ownerId: OTHER }));
    for (const id of [theirs.quizSet._id, new Types.ObjectId().toHexString(), 'abc']) {
      await expect(service.findMine(ME.toHexString(), id)).rejects.toMatchObject(notFound);
    }
  });
});

describe('fitInput (처리기 입력 크기 한도)', () => {
  const page = (size: number) => [{ pageNo: 1, ocrText: 'x'.repeat(size) }];
  const input = (): WorkerInput => ({
    day: '2026-11-09',
    size: QUIZ_SET_SIZE,
    material: { id: 'm0', title: '이번 노트', pages: page(100) },
    // 최근 것부터: s1(긴 노트 m2) · s2(노트 m1) · s3(노트 m1)
    sets: [
      { id: 's1', materialId: 'm2', questions: [] },
      { id: 's2', materialId: 'm1', questions: [] },
      { id: 's3', materialId: 'm1', questions: [] },
    ],
    attempts: [{ quizSetId: 's1' }, { quizSetId: 's2' }, { quizSetId: 's3' }],
    notes: { m1: page(1000), m2: page(5000) },
  });
  // MongoDB가 세는 크기
  const size = (v: object) => mongo.BSON.calculateObjectSize(v);

  it('한도 안이면 그대로', () => {
    const all = input();
    expect(fitInput(all)).toBe(all);
  });

  it('들어가지 않는 세트만 그 풀이 · 노트 글과 함께 건너뛰고 다음 세트를 넣는다', () => {
    const all = input();
    const limit = size(all) - 3000;
    const fitted = fitInput(all, limit);
    expect(fitted.sets.map((s) => s.id)).toEqual(['s2', 's3']);
    expect(fitted.attempts).toEqual([{ quizSetId: 's2' }, { quizSetId: 's3' }]);
    expect(Object.keys(fitted.notes)).toEqual(['m1']);
  });

  it('줄인 결과는 실제 BSON 크기로 늘 한도 안', () => {
    const all = input();
    const base = size({ ...all, sets: [], attempts: [], notes: {} });
    for (let limit = base; limit <= size(all) + 100; limit += 37) {
      expect(size(fitInput(all, limit))).toBeLessThanOrEqual(limit);
    }
  });

  it('지난 세트를 모두 빼도 넘으면(이번 노트가 너무 김) 400 VALIDATION_FAILED', () => {
    const all = input();
    const base = size({ ...all, sets: [], attempts: [], notes: {} });
    expect(fitInput(all, base).sets).toEqual([]);
    expect(() => fitInput(all, base - 1)).toThrow(
      expect.objectContaining({
        status: 400,
        response: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      }),
    );
  });

  it('만들 때 노트가 너무 길면 400이고 작업 · 세트를 남기지 않는다', async () => {
    const { service, addNote, jobs, sets } = setup();
    const line = 'x'.repeat(INPUT_BYTE_LIMIT / QUIZ_MIN_LINES);
    const long = [{ pageNo: 1, ocrText: Array(QUIZ_MIN_LINES).fill(line).join('\n') }];
    const materialId = await addNote({ pages: long });
    await expect(service.create(ME.toHexString(), materialId)).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_FAILED', message: expect.stringContaining('너무 길어') },
    });
    expect(jobs.rows).toHaveLength(0);
    expect(sets.rows).toHaveLength(0);
  });
});

describe('QuizSetsService 끝난 미리 만들기 바로 쓰기(#274)', () => {
  /** 노트 정리 뒤 넣은 미리 만들기. 입력의 노트 글은 addNote의 글이 있는 쪽과 같다 */
  async function pregen(
    t: ReturnType<typeof setup>,
    materialId: string,
    pages = [{ pageNo: 1, ocrText: NOTE_TEXT }],
  ) {
    return t.aiJobs.enqueue({
      type: 'quiz_pregen',
      userId: ME.toHexString(),
      targetType: 'material',
      targetId: materialId,
      input: {
        day: '2026-11-10',
        size: QUIZ_SET_SIZE,
        material: { id: materialId, title: '세포 생물학', pages },
      },
    });
  }
  const result = (over: Record<string, unknown> = {}) => ({
    questions: fullSet(),
    title: '세포 생물학 퀴즈',
    concepts: ['세포막', '핵', '리보솜'],
    ...over,
  });

  it('새 작업 없이 그 결과로 바로 ready 세트를 만들고, 개념 이름을 노트에 저장한다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await pregen(t, materialId);
    t.finish(p._id, result());

    const { quizSet, job } = await t.service.create(ME.toHexString(), materialId);

    expect(QuizSet.parse(quizSet)).toEqual(quizSet);
    expect(AiJob.parse(job)).toEqual(job);
    expect(t.jobs.rows).toHaveLength(1);
    expect(job).toMatchObject({ _id: p._id, type: 'quiz_pregen', status: 'succeeded' });
    expect(quizSet).toMatchObject({
      _id: p._id,
      status: 'ready',
      questionCount: QUIZ_SET_SIZE,
      title: '세포 생물학 퀴즈',
    });
    expect(String(t.set(quizSet._id)['jobId'])).toBe(p._id);
    expect(t.materials.rows[0]!['concepts']).toEqual(['세포막', '핵', '리보솜']);
  });

  it('같은 결과는 한 번만 쓴다: 다음 요청은 저장한 개념 이름을 넣어 새로 만든다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await pregen(t, materialId);
    t.finish(p._id, result());
    const first = await t.service.create(ME.toHexString(), materialId);

    const second = await t.service.create(ME.toHexString(), materialId);

    expect(second.quizSet._id).not.toBe(first.quizSet._id);
    expect(second.job).toMatchObject({ type: 'quiz_generate', status: 'queued' });
    const input = t.job(second.job._id)['input'] as WorkerInput;
    expect(input.material.concepts).toEqual(['세포막', '핵', '리보솜']);
  });

  it('거의 동시에 두 번 와도 세트는 하나(같은 id)이고 새 작업을 넣지 않는다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await pregen(t, materialId);
    t.finish(p._id, result());

    const [a, b] = await Promise.all([
      t.service.create(ME.toHexString(), materialId),
      t.service.create(ME.toHexString(), materialId),
    ]);

    expect(a.quizSet._id).toBe(p._id);
    expect(b.quizSet._id).toBe(p._id);
    expect(b.quizSet.status).toBe('ready');
    expect(t.sets.rows).toHaveLength(1);
    expect(t.jobs.rows).toHaveLength(1);
  });

  it('이어받아 만든 세트가 그 작업을 가리키면 끝난 뒤 다시 쓰지 않는다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await pregen(t, materialId);
    const taken = await t.service.create(ME.toHexString(), materialId);
    expect(taken.job._id).toBe(p._id);
    t.finish(p._id, result());
    await t.service.findMine(ME.toHexString(), taken.quizSet._id);

    const next = await t.service.create(ME.toHexString(), materialId);

    expect(next.job.type).toBe('quiz_generate');
    expect(t.sets.rows).toHaveLength(2);
  });

  it('지운 세트로 쓴 결과도 되살리지 않는다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await pregen(t, materialId);
    t.finish(p._id, result());
    const first = await t.service.create(ME.toHexString(), materialId);
    Object.assign(t.set(first.quizSet._id), { deletedAt: new Date() });

    const next = await t.service.create(ME.toHexString(), materialId);

    expect(next.job.type).toBe('quiz_generate');
  });

  it.each([
    [
      '노트 글이 그 사이 바뀜',
      [{ pageNo: 1, ocrText: `${NOTE_TEXT}\n세포벽은 식물에 있다.` }],
      result(),
    ],
    ['쓸 문제가 없음', [{ pageNo: 1, ocrText: NOTE_TEXT }], result({ questions: [] })],
  ])('%s이면 쓰지 않고 새로 만든다', async (_name, pages, res) => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await pregen(t, materialId, pages);
    t.finish(p._id, res);

    const { job } = await t.service.create(ME.toHexString(), materialId);

    expect(job.type).toBe('quiz_generate');
    expect(t.job(p._id)['status']).toBe('succeeded');
  });

  it('실패한 미리 만들기는 쓰지 않고 새로 만든다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await pregen(t, materialId);
    Object.assign(t.job(p._id), { status: 'failed', error: 'NO_QUESTIONS: 만든 문제가 없음' });

    const { job } = await t.service.create(ME.toHexString(), materialId);

    expect(job.type).toBe('quiz_generate');
  });

  it('가장 최근 미리 만들기만 본다(그 전 결과는 낡음)', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const old = await pregen(t, materialId);
    t.finish(old._id, result());
    const latest = await pregen(t, materialId);
    Object.assign(t.job(latest._id), { status: 'failed' });

    const { job } = await t.service.create(ME.toHexString(), materialId);

    expect(job.type).toBe('quiz_generate');
  });

  it('처리기가 개념을 새로 뽑지 않은 결과(concepts null)는 노트의 개념 이름을 그대로 둔다', async () => {
    const t = setup();
    const materialId = await t.addNote({ concepts: ['세포막'] });
    const { quizSet, job } = await t.service.create(ME.toHexString(), materialId);
    expect((t.job(job._id)['input'] as WorkerInput).material.concepts).toEqual(['세포막']);
    t.finish(job._id, { questions: fullSet(), concepts: null });

    await t.service.findMine(ME.toHexString(), quizSet._id);

    expect(t.materials.rows[0]!['concepts']).toEqual(['세포막']);
  });
});

describe('QuizSetsService 리뷰 반영(Codex #276)', () => {
  const result = { questions: fullSet(), concepts: ['세포막', '핵'] };

  it('이어받은 요청이 세트를 넣기 전에 작업이 끝나 다른 요청이 결과로 세트를 만들어도 세트는 하나', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await t.aiJobs.enqueue({
      type: 'quiz_pregen',
      userId: ME.toHexString(),
      targetType: 'material',
      targetId: materialId,
      input: { material: { pages: [{ pageNo: 1, ocrText: NOTE_TEXT }] } },
    });
    // 첫 요청(이어받음)의 세트 넣기를 붙잡아 둔다
    const create = t.sets.model.create.bind(t.sets.model);
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    (t.sets.model as unknown as { create: typeof create }).create = (async (
      ...args: Parameters<typeof create>
    ) => {
      if (first) {
        first = false;
        held();
        await gate;
      }
      return create(...args);
    }) as typeof create;

    const a = t.service.create(ME.toHexString(), materialId);
    await holding;
    t.finish(p._id, result);
    const b = await t.service.create(ME.toHexString(), materialId);
    release();
    const late = await a;

    expect(b.quizSet).toMatchObject({ _id: p._id, status: 'ready' });
    expect(late.quizSet).toMatchObject({ _id: p._id, status: 'ready' });
    expect(t.sets.rows).toHaveLength(1);
    expect(t.jobs.rows).toHaveLength(1);
  });

  it('지운 세트가 그 미리 만들기 id를 쓰고 있으면 이어받는 새 세트는 새 id로 만든다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await t.aiJobs.enqueue({
      type: 'quiz_pregen',
      userId: ME.toHexString(),
      targetType: 'material',
      targetId: materialId,
      input: {},
    });
    const first = await t.service.create(ME.toHexString(), materialId);
    expect(first.quizSet._id).toBe(p._id);
    Object.assign(t.set(first.quizSet._id), { deletedAt: new Date() });

    const again = await t.service.create(ME.toHexString(), materialId);

    expect(again.quizSet._id).not.toBe(p._id);
    expect(again.quizSet._id).toBe(nextSetId(new Types.ObjectId(p._id)).toHexString());
    expect(again.job).toMatchObject({ _id: p._id, awaited: true });
  });

  it('지운 뒤 이어받는 두 요청 중 늦은 쪽이 다른 세트가 ready가 된 뒤 넣어도 세트는 하나(Codex 재리뷰)', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await t.aiJobs.enqueue({
      type: 'quiz_pregen',
      userId: ME.toHexString(),
      targetType: 'material',
      targetId: materialId,
      input: { material: { pages: [{ pageNo: 1, ocrText: NOTE_TEXT }] } },
    });
    const deleted = await t.service.create(ME.toHexString(), materialId);
    Object.assign(t.set(deleted.quizSet._id), { deletedAt: new Date() });
    // 다음 요청(이어받음)의 세트 넣기를 붙잡아 둔다
    const create = t.sets.model.create.bind(t.sets.model);
    let release!: () => void;
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    (t.sets.model as unknown as { create: typeof create }).create = (async (
      ...args: Parameters<typeof create>
    ) => {
      if (first) {
        first = false;
        held();
        await gate;
      }
      return create(...args);
    }) as typeof create;

    const a = t.service.create(ME.toHexString(), materialId);
    await holding;
    const b = await t.service.create(ME.toHexString(), materialId);
    t.finish(p._id, result);
    const shown = await t.service.findMine(ME.toHexString(), b.quizSet._id);
    release();
    const late = await a;

    expect(shown).toMatchObject({ status: 'ready' });
    expect(late.quizSet).toMatchObject({ _id: b.quizSet._id, status: 'ready' });
    expect(t.sets.rows.filter((r) => !r['deletedAt'])).toHaveLength(1);
    expect(t.jobs.rows).toHaveLength(1);
  });

  it('개념 저장이 실패하면 세트도 그대로 두어 다음 조회가 다시 옮기며 저장한다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const { quizSet, job } = await t.service.create(ME.toHexString(), materialId);
    t.finish(job._id, result);
    const update = t.materials.model.findOneAndUpdate.bind(t.materials.model);
    (t.materials.model as unknown as { findOneAndUpdate: unknown }).findOneAndUpdate = () => {
      throw new Error('DB 연결 끊김');
    };

    await expect(t.service.findMine(ME.toHexString(), quizSet._id)).rejects.toThrow('DB 연결 끊김');
    expect(t.set(quizSet._id)['status']).toBe('generating');

    (t.materials.model as unknown as { findOneAndUpdate: unknown }).findOneAndUpdate = update;
    const again = await t.service.findMine(ME.toHexString(), quizSet._id);
    expect(again.status).toBe('ready');
    expect(t.materials.rows[0]!['concepts']).toEqual(['세포막', '핵']);
  });

  it('직전 세트를 옮기며 저장한 개념 이름을 같은 요청이 만드는 다음 세트 입력에 넣는다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const prev = await t.service.create(ME.toHexString(), materialId);
    t.finish(prev.job._id, result);

    // 조회 없이 바로 다시 요청: 만드는 중인 직전 세트를 이 요청이 옮긴다
    const next = await t.service.create(ME.toHexString(), materialId);

    expect(next.quizSet._id).not.toBe(prev.quizSet._id);
    expect(t.set(prev.quizSet._id)['status']).toBe('ready');
    expect((t.job(next.job._id)['input'] as WorkerInput).material.concepts).toEqual([
      '세포막',
      '핵',
    ]);
  });
});

describe('QuizSetsService.pregenerate (#134 · #274)', () => {
  it('노트 내용만으로 첫 세트를 만드는 quiz_pregen을 넣는다', async () => {
    const t = setup();
    const materialId = await t.addNote();

    const job = await t.service.pregenerate(ME.toHexString(), materialId);

    expect(job).toMatchObject({
      type: 'quiz_pregen',
      status: 'queued',
      targetType: 'material',
      targetId: materialId,
    });
    const input = t.job(job!._id)['input'] as WorkerInput;
    expect(input).toMatchObject({ size: QUIZ_SET_SIZE, sets: [], attempts: [], notes: {} });
    expect(input.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(input.material).toEqual({
      id: materialId,
      title: '세포 생물학',
      pages: [{ pageNo: 1, ocrText: NOTE_TEXT }],
    });
  });

  it('넣은 미리 만들기를 퀴즈 요청이 이어받는다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const p = await t.service.pregenerate(ME.toHexString(), materialId);

    const { job } = await t.service.create(ME.toHexString(), materialId);

    expect(job).toMatchObject({ _id: p!._id, awaited: true });
  });

  it('도는 미리 만들기 · 아직 쓰지 않은 결과가 있으면 새로 넣지 않고 그 작업을 돌려준다', async () => {
    const t = setup();
    const materialId = await t.addNote();
    const first = await t.service.pregenerate(ME.toHexString(), materialId);
    expect(await t.service.pregenerate(ME.toHexString(), materialId)).toMatchObject({
      _id: first!._id,
    });
    t.finish(first!._id, { questions: fullSet() });
    expect(await t.service.pregenerate(ME.toHexString(), materialId)).toMatchObject({
      _id: first!._id,
    });
    expect(t.jobs.rows).toHaveLength(1);
  });

  it('이 노트에 세트가 이미 있으면 넣지 않는다(첫 세트만 미리 만든다)', async () => {
    const t = setup();
    const materialId = await t.addNote();
    await t.service.create(ME.toHexString(), materialId);

    expect(await t.service.pregenerate(ME.toHexString(), materialId)).toBeNull();
    expect(t.jobs.rows).toHaveLength(1);
  });

  it('물을 수 있는 쪽이 없으면 넣지 않는다', async () => {
    const t = setup();
    const materialId = await t.addNote({ pages: [{ pageNo: 1, ocrText: '한 줄뿐' }] });

    expect(await t.service.pregenerate(ME.toHexString(), materialId)).toBeNull();
    expect(t.jobs.rows).toHaveLength(0);
  });

  it('저장된 개념 이름이 있으면 입력에 넣는다', async () => {
    const t = setup();
    const materialId = await t.addNote({ concepts: ['세포막', '핵'] });

    const job = await t.service.pregenerate(ME.toHexString(), materialId);

    expect((t.job(job!._id)['input'] as WorkerInput).material.concepts).toEqual(['세포막', '핵']);
  });

  it('남의 노트는 404', async () => {
    const t = setup();
    const materialId = await t.addNote({ ownerId: OTHER });

    await expect(t.service.pregenerate(ME.toHexString(), materialId)).rejects.toMatchObject(
      notFound,
    );
  });
});

describe('seoulDay', () => {
  it.each([
    ['2026-11-08T14:59:59Z', '2026-11-08'],
    // 서울 자정(UTC 15시)에 날짜가 바뀐다(DAY_RESET_HOUR = 0)
    ['2026-11-08T15:00:00Z', '2026-11-09'],
  ])('%s → %s', (at, day) => {
    expect(seoulDay(new Date(at))).toBe(day);
  });
});
