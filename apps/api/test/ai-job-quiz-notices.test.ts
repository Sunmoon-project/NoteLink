// 퀴즈 · 다시 만들기 알림 내용(#634) 단위 테스트: 가짜 모델로 어떤 문구를 보내는지 본다.
// - 유사 문제(similar_quiz)는 세트의 상태 · 문제 수를 보고, 0개면 「준비됐어요」 대신 실패를 알린다(TestQA COM-004)
// - 세트가 아직 만드는 중(동기화 전)이면 세트 동기화와 같은 규칙으로 작업 결과의 문제를 센다
// - 다른 퀴즈 작업(퀴즈 만들기 · 미리 만들기) 문구는 그대로다
// - 노트 다시 만들기 작업(processing.regenJobId)이 노트 동기화 전에 끝나도 알린다(#616 Codex 2차). 쓸 수 없는 결과면 실패로
// 선점 · 재시도 · 기록 규칙은 ai-job-notices.test.ts, 진짜 DB는 ai-job-quiz-notices-real-db.test.ts
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { AiJobNoticesService } from '../src/ai-jobs/ai-job-notices.service.js';

const NOW = new Date('2026-11-22T03:00:00Z');
const userId = new Types.ObjectId();

type Sent = { title: string; body: string; data: Record<string, unknown> };

/** 처리기가 만든 유사 문제 하나(세트 동기화가 받는 모양) */
const workerQuestion = (order: number) => ({
  id: new Types.ObjectId().toHexString(),
  order,
  prompt: `문제 ${order}`,
  choices: ['가', '나', '다', '라'],
  answer: '가',
  explanation: '해설',
  srs: { interval: 1 },
});

function setup(opts: {
  job: { type: string; status?: string; targetType?: string; awaited?: boolean };
  /** 작업 결과(유사 문제 세트가 ready 가 아닐 때 · 동기화 전 다시 만들기가 성공했을 때 읽는다) */
  result?: Record<string, unknown> | null;
  /** 그 작업을 가리키는 세트(null이면 없음) */
  set?: { status?: string; questionCount?: number; title?: string } | null;
  /** 노트(요약 작업일 때) */
  material?: {
    jobId?: Types.ObjectId | 'self' | null;
    regenJobId?: Types.ObjectId | 'self' | null;
  };
}) {
  const job = {
    _id: new Types.ObjectId(),
    type: opts.job.type,
    status: opts.job.status ?? 'succeeded',
    userId,
    targetType: opts.job.targetType ?? 'quiz_set',
    targetId: new Types.ObjectId(),
    awaited: opts.job.awaited,
    updatedAt: new Date(NOW.getTime() - 60_000),
  };
  const setId = new Types.ObjectId();
  const states: unknown[] = [];
  const jobs = {
    find: () => {
      const chain = {
        sort: () => chain,
        limit: () => chain,
        lean: () => Promise.resolve([job]),
      };
      return chain;
    },
    findOneAndUpdate: () => ({
      lean: () => Promise.resolve({ _id: job._id, notice: { attempts: 1 } }),
    }),
    findOne: (filter: Record<string, unknown>) => ({
      lean: () =>
        Promise.resolve(
          // 선점 뒤 다시 확인하는 조회와 작업 결과를 읽는 조회를 나눈다
          'notice.claimId' in filter
            ? { _id: job._id }
            : {
                _id: job._id,
                type: job.type,
                status: job.status,
                progress: 100,
                result: opts.result ?? null,
              },
        ),
    }),
    updateOne: (_filter: unknown, update: { $set?: Record<string, unknown> }) => {
      states.push(update.$set?.['notice.state']);
      return Promise.resolve({ matchedCount: 1 });
    },
    updateMany: () => Promise.resolve({ modifiedCount: 0 }),
  };
  const pick = (v: Types.ObjectId | 'self' | null | undefined) => (v === 'self' ? job._id : v);
  const materials = {
    findOne: () => ({
      lean: () =>
        Promise.resolve({
          _id: job.targetId,
          kind: 'recording',
          deletedAt: null,
          title: '영어 필기',
          processing: {
            status: 'done',
            jobId: pick(opts.material?.jobId === undefined ? 'self' : opts.material.jobId),
            regenJobId: pick(opts.material?.regenJobId ?? null),
          },
        }),
    }),
  };
  const sets = {
    findOne: () => ({
      lean: () =>
        Promise.resolve(
          opts.set === null ? null : { _id: setId, title: '영어 단어', ...(opts.set ?? {}) },
        ),
    }),
  };
  const devices = {
    find: () => ({ lean: () => Promise.resolve([{ pushToken: 'ExponentPushToken[aaa]' }]) }),
    deleteMany: () => Promise.resolve(),
  };
  const sent: Sent[] = [];
  const push = {
    send: (messages: Sent[]) => {
      sent.push(...messages);
      return Promise.resolve({ invalidTokens: [], failedTickets: [] });
    },
  };
  const service = new AiJobNoticesService(
    jobs as never,
    materials as never,
    devices as never,
    push as never,
    sets as never,
    {
      saveToInbox: (input: { userIds: unknown[] }) =>
        Promise.resolve(new Map(input.userIds.map((id) => [String(id), 'n1']))),
      pushAllowed: (ids: unknown[]) => Promise.resolve(ids),
    } as never,
  );
  return { service, sent, states, job, setId };
}

const READY = '유사 문제가 준비됐어요';
const SIMILAR_FAILED = '유사 문제를 만들지 못했어요. 다시 시도해 주세요';

describe('유사 문제 알림은 세트의 상태 · 문제 수를 본다(#634, COM-004)', () => {
  it('작업은 성공했지만 세트가 failed(유사 문제 0개)면 「준비됐어요」 대신 실패를 알린다', async () => {
    const { service, sent, states } = setup({
      job: { type: 'similar_quiz' },
      set: { status: 'failed', questionCount: 0 },
    });
    await service.runOnce(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.title).toBe(SIMILAR_FAILED);
    // 앱은 quizSetId가 없으면 퀴즈 탭으로 간다(빈 세트로 보내지 않는다)
    expect(sent[0]!.data).toMatchObject({ type: 'quiz-ready', status: 'failed' });
    expect(sent[0]!.data['quizSetId']).toBeUndefined();
    expect(states).toEqual(['sent']);
  });

  it('세트가 ready 여도 문제가 0개면 실패를 알린다', async () => {
    const { service, sent } = setup({
      job: { type: 'similar_quiz' },
      set: { status: 'ready', questionCount: 0 },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual([SIMILAR_FAILED]);
  });

  it('세트가 아직 만드는 중(동기화 전)이고 작업 결과에 쓸 문제가 없으면 실패를 알린다', async () => {
    const { service, sent } = setup({
      job: { type: 'similar_quiz' },
      set: { status: 'generating', questionCount: 0 },
      result: { reviewQuestions: [], srsUpdates: [] },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual([SIMILAR_FAILED]);
  });

  it('동기화 전 결과의 문제가 모두 모양이 틀려도(세트 동기화가 빼는 문제) 실패를 알린다', async () => {
    const { service, sent } = setup({
      job: { type: 'similar_quiz' },
      set: { status: 'generating' },
      result: { reviewQuestions: [{ order: 1 }] },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual([SIMILAR_FAILED]);
  });

  it('세트가 ready 이고 1문제 이상이면 지금처럼 「유사 문제가 준비됐어요」와 세트 id를 보낸다', async () => {
    const { service, sent, setId } = setup({
      job: { type: 'similar_quiz' },
      set: { status: 'ready', questionCount: 3 },
    });
    await service.runOnce(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: READY,
      body: '영어 단어',
      data: { type: 'quiz-ready', quizSetId: setId.toHexString(), status: 'succeeded' },
    });
  });

  it('세트가 아직 만드는 중이어도 작업 결과에 쓸 문제가 있으면 「준비됐어요」', async () => {
    const { service, sent, setId } = setup({
      job: { type: 'similar_quiz' },
      set: { status: 'generating' },
      result: { reviewQuestions: [workerQuestion(1), workerQuestion(2)] },
    });
    await service.runOnce(NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: READY,
      data: { quizSetId: setId.toHexString(), status: 'succeeded' },
    });
  });

  it('앞선 실패로 failed 였던 세트도 다시 시도한 작업 결과에 문제가 있으면 「준비됐어요」(세트 동기화가 ready로 되살린다)', async () => {
    const { service, sent } = setup({
      job: { type: 'similar_quiz' },
      set: { status: 'failed', questionCount: 0 },
      result: { reviewQuestions: [workerQuestion(1)] },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual([READY]);
  });

  it('작업이 실패했으면 지금처럼 실패 문구(세트를 보지 않는다)', async () => {
    const { service, sent } = setup({
      job: { type: 'similar_quiz', status: 'failed' },
      set: null,
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual([SIMILAR_FAILED]);
  });
});

describe('다른 퀴즈 작업 알림은 그대로다(#634)', () => {
  it('퀴즈 만들기(quiz_generate)는 지금처럼 「퀴즈가 준비됐어요」(유사 문제 판정을 타지 않는다)', async () => {
    const { service, sent } = setup({
      job: { type: 'quiz_generate' },
      set: { status: 'ready', questionCount: 5 },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual(['퀴즈가 준비됐어요']);
  });

  it('사용자가 기다린 미리 만들기(quiz_pregen)도 지금처럼 「퀴즈가 준비됐어요」', async () => {
    const { service, sent } = setup({
      job: { type: 'quiz_pregen', targetType: 'material', awaited: true },
      set: { status: 'ready', questionCount: 5 },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual(['퀴즈가 준비됐어요']);
  });
});

describe('노트 다시 만들기 알림(#616 Codex 2차)', () => {
  const old = new Types.ObjectId();

  it('다시 만들기 작업(regenJobId)이 노트 동기화 전에 성공하면 「노트 정리가 끝났어요」를 보낸다', async () => {
    const { service, sent, states } = setup({
      job: { type: 'recording_summary', targetType: 'material' },
      material: { jobId: old, regenJobId: 'self' },
      result: { slides: [{ title: '도입', summary: '시작', startMs: 0, endMs: 1 }] },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual(['노트 정리가 끝났어요']);
    expect(sent[0]!.data).toMatchObject({ type: 'note-summary', status: 'succeeded' });
    expect(states).toEqual(['sent']);
  });

  it('동기화 전의 다시 만들기가 성공했어도 결과를 쓸 수 없으면(노트는 옛 결과 그대로) 실패로 알린다', async () => {
    const { service, sent } = setup({
      job: { type: 'recording_summary', targetType: 'material' },
      material: { jobId: old, regenJobId: 'self' },
      result: { slides: [] },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual(['노트 정리에 실패했어요. 다시 시도해 주세요']);
    expect(sent[0]!.data).toMatchObject({ type: 'note-summary', status: 'failed' });
  });

  it('다시 만들기 작업이 노트 동기화 전에 실패해도 실패를 알린다', async () => {
    const { service, sent } = setup({
      job: { type: 'handwriting_summary', status: 'failed', targetType: 'material' },
      material: { jobId: old, regenJobId: 'self' },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual(['노트 정리에 실패했어요. 다시 시도해 주세요']);
  });

  it('노트의 현재 작업도 다시 만들기 작업도 아닌 옛 작업은 보내지 않고 skipped', async () => {
    const { service, sent, states } = setup({
      job: { type: 'document_summary', targetType: 'material' },
      material: { jobId: old, regenJobId: new Types.ObjectId() },
    });
    await service.runOnce(NOW);
    expect(sent).toHaveLength(0);
    expect(states).toEqual(['skipped']);
  });

  it('다시 만들기 중에 끝난 원래 작업(jobId)은 지금처럼 알린다', async () => {
    const { service, sent } = setup({
      job: { type: 'recording_summary', targetType: 'material' },
      material: { jobId: 'self', regenJobId: new Types.ObjectId() },
    });
    await service.runOnce(NOW);
    expect(sent.map((m) => m.title)).toEqual(['노트 정리가 끝났어요']);
  });
});
