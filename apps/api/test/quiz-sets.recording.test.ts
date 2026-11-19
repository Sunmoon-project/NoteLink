// 녹음 노트로 맞춤 퀴즈 만들기(FR-38): 퀴즈 · 미리 만들기가 녹음 정리 작업(recording_summary)의 대본을
// 처리기 입력 쪽([{pageNo, ocrText}])으로 바꿔 넣는지, 정리가 안 끝났거나 실패한 녹음 노트는 거절하는지,
// 필기 노트의 입력은 그대로인지 본다.
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { AiJobsService } from '../src/ai-jobs/ai-jobs.service.js';
import type { MaterialDocument } from '../src/modules/content/schemas/material.schema.js';
import type { QuizAttemptDocument } from '../src/modules/quiz/schemas/quiz-attempt.schema.js';
import type { QuizSetDocument } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { transcriptToPages, recordingTranscriptOf } from '../src/quiz-sets/recording-pages.js';
import { RecordingNotePagesService } from '../src/quiz-sets/recording-note-pages.service.js';
import {
  QuizSetsService,
  textPages,
  type WorkerInput,
} from '../src/quiz-sets/quiz-sets.service.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';
import { createFakeCollection } from './support/fake-collection.js';

const ME = new Types.ObjectId();
const FOLDER = new Types.ObjectId();

const SENTENCES = Array.from({ length: 12 }, (_, i) => ({
  text: `녹음 문장 ${i}.`,
  startMs: i * 1000,
  endMs: i * 1000 + 900,
  words: [{ text: '단어', startMs: 0, endMs: 1 }],
}));
const RESULT = {
  durationMs: 12_000,
  transcript: SENTENCES.map((s) => s.text).join(' '),
  sentences: SENTENCES,
  slides: [
    { sentenceStart: 0, sentenceEnd: 6, title: '앞', summary: '앞 요약', startMs: 0, endMs: 6000 },
    {
      sentenceStart: 6,
      sentenceEnd: 12,
      title: '뒤',
      summary: '뒤 요약',
      startMs: 6000,
      endMs: 12000,
    },
  ],
  chunks: [{ embedding: [0.1] }],
};
const EXPECTED_PAGES = transcriptToPages(recordingTranscriptOf(RESULT)!);
const HANDWRITING_TEXT = '가.\n나.\n다.\n라.\n마.';

function setup() {
  const sets = createFakeCollection<QuizSetDocument>();
  const materials = createFakeCollection<MaterialDocument>();
  const attempts = createFakeCollection<QuizAttemptDocument>();
  Object.assign(attempts.model, { aggregate: vi.fn().mockResolvedValue([]) });
  const jobs = createFakeJobs();
  const recordingPages = new RecordingNotePagesService(jobs.model);
  const service = new QuizSetsService(
    sets.model,
    materials.model,
    attempts.model,
    new AiJobsService(jobs.model),
    recordingPages,
    { saveFromQuizSet: async () => undefined } as never, // 개념 카드(#558)는 이 시험 밖
  );
  /** 녹음 정리 작업을 넣는다 */
  const addSummaryJob = (over: Record<string, unknown> = {}) => {
    const row = {
      _id: new Types.ObjectId(),
      type: 'recording_summary',
      userId: ME,
      targetType: 'material',
      status: 'succeeded',
      result: RESULT,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...over,
    };
    jobs.rows.push(row as never);
    return row._id;
  };
  const addNote = async (over: Record<string, unknown> = {}) => {
    const { _id } = (await materials.model.create({
      ownerId: ME,
      folderId: FOLDER,
      title: '녹음 강의',
      deletedAt: null,
      kind: 'recording',
      processing: { status: 'done', jobId: null },
      pages: [],
      ...over,
    } as never)) as unknown as { _id: Types.ObjectId };
    return _id.toHexString();
  };
  /** 정리가 끝난 녹음 노트 */
  const addRecording = async (jobOver: Record<string, unknown> = {}) => {
    const jobId = addSummaryJob(jobOver);
    return addNote({ processing: { status: 'done', jobId } });
  };
  const queuedInputs = () =>
    jobs.rows.filter((r) => r.type !== 'recording_summary').map((r) => r.input as WorkerInput);
  return {
    service,
    recordingPages,
    sets,
    materials,
    jobs,
    addNote,
    addRecording,
    addSummaryJob,
    queuedInputs,
  };
}

const validation = { status: 400, response: { code: 'VALIDATION_FAILED' } };

describe('녹음 노트로 퀴즈 만들기', () => {
  it('정리가 끝난 녹음 노트는 대본을 쪽으로 바꿔 처리기 입력에 넣는다', async () => {
    const { service, addRecording, queuedInputs } = setup();
    const id = await addRecording();
    const { job } = await service.create(ME.toHexString(), id);
    expect(job.type).toBe('quiz_generate');
    const [input] = queuedInputs();
    expect(input!.material.pages).toEqual(EXPECTED_PAGES);
    expect(EXPECTED_PAGES.length).toBeGreaterThan(0);
    // 단어 시각 · embedding 은 처리기 입력에 없다
    expect(JSON.stringify(input)).not.toMatch(/embedding|"words"/);
  });

  it('공백 없는 100자 문장 6개를 슬라이드 3개에 2개씩 나눈 대본도 400 없이 작업을 넣는다(합쳐서 5줄 이상인 쪽을 만든다)', async () => {
    const { service, addRecording, queuedInputs } = setup();
    const sentences = Array.from({ length: 6 }, (_, i) => ({
      text: String.fromCharCode(0xac00 + i).repeat(99) + '.',
      startMs: i,
      endMs: i + 1,
    }));
    const slide = (sentenceStart: number, sentenceEnd: number) => ({ sentenceStart, sentenceEnd });
    const result = { sentences, slides: [slide(0, 2), slide(2, 4), slide(4, 6)] };
    const id = await addRecording({ result });
    const { job } = await service.create(ME.toHexString(), id);
    expect(job.type).toBe('quiz_generate');
    const pages = queuedInputs()[0]!.material.pages;
    expect(pages).toEqual(transcriptToPages(recordingTranscriptOf(result)!));
    expect(pages.some((p) => p.ocrText.split('\n').length >= 5)).toBe(true);
  });

  it('미리 만들기도 녹음 노트의 대본으로 quiz_pregen 을 넣는다', async () => {
    const { service, addRecording, queuedInputs } = setup();
    const job = await service.pregenerate(ME.toHexString(), await addRecording());
    expect(job).toMatchObject({ type: 'quiz_pregen', targetType: 'material' });
    expect(queuedInputs()[0]!.material.pages).toEqual(EXPECTED_PAGES);
  });

  it('정리 중인 녹음 노트는 400 이고 작업을 넣지 않는다', async () => {
    const { service, addNote, addSummaryJob, queuedInputs } = setup();
    const jobId = addSummaryJob({ status: 'running', result: null });
    const id = await addNote({ processing: { status: 'processing', jobId } });
    await expect(service.create(ME.toHexString(), id)).rejects.toMatchObject(validation);
    expect(queuedInputs()).toHaveLength(0);
  });

  it('정리에 실패한 녹음 노트는 400 이고 작업을 넣지 않는다(다시 정리하라고 알린다)', async () => {
    const { service, addNote, addSummaryJob, queuedInputs } = setup();
    const jobId = addSummaryJob({ status: 'failed', result: null });
    const id = await addNote({ processing: { status: 'failed', jobId } });
    await expect(service.create(ME.toHexString(), id)).rejects.toMatchObject({
      ...validation,
      response: { code: 'VALIDATION_FAILED', message: expect.stringContaining('실패') },
    });
    expect(queuedInputs()).toHaveLength(0);
  });

  it('노트는 끝났다고 되어 있지만 작업이 성공이 아니면(대본을 못 읽으면) 400', async () => {
    const { service, addRecording, queuedInputs } = setup();
    const id = await addRecording({ status: 'running' });
    await expect(service.create(ME.toHexString(), id)).rejects.toMatchObject(validation);
    expect(queuedInputs()).toHaveLength(0);
  });

  it('작업 id 가 없는 녹음 노트(등록 중)는 400, 미리 만들기는 조용히 null', async () => {
    const { service, addNote, queuedInputs } = setup();
    const id = await addNote({ processing: { status: 'uploading', jobId: null } });
    await expect(service.create(ME.toHexString(), id)).rejects.toMatchObject(validation);
    expect(await service.pregenerate(ME.toHexString(), id)).toBeNull();
    expect(queuedInputs()).toHaveLength(0);
  });

  it('실패한 녹음 노트의 미리 만들기는 던지지 않고 null', async () => {
    const { service, addNote, addSummaryJob } = setup();
    const jobId = addSummaryJob({ status: 'failed', result: null });
    const id = await addNote({ processing: { status: 'failed', jobId } });
    expect(await service.pregenerate(ME.toHexString(), id)).toBeNull();
  });

  it('남의 작업이면 대본을 읽지 않는다', async () => {
    const { service, addRecording } = setup();
    const id = await addRecording({ userId: new Types.ObjectId() });
    await expect(service.create(ME.toHexString(), id)).rejects.toMatchObject(validation);
  });

  it('입력 크기 상한(INPUT_BYTE_LIMIT)을 그대로 지킨다: 너무 긴 대본은 400', async () => {
    const { service, addRecording, queuedInputs } = setup();
    const long = Array.from({ length: 40_000 }, (_, i) => ({
      text: `${i} ` + '가'.repeat(100),
      startMs: i,
      endMs: i + 1,
    }));
    const id = await addRecording({ result: { sentences: long, slides: [] } });
    await expect(service.create(ME.toHexString(), id)).rejects.toMatchObject({
      status: 400,
      response: { code: 'VALIDATION_FAILED', message: expect.stringContaining('너무 길어') },
    });
    expect(queuedInputs()).toHaveLength(0);
  });
});

describe('다른 노트 글(notes)에도 녹음 대본이 들어간다', () => {
  it('이미 세트가 있는 녹음 노트의 글을 다른 노트의 퀴즈 입력 notes 에 넣는다', async () => {
    const { service, addRecording, addNote, sets, queuedInputs } = setup();
    const recording = await addRecording();
    await sets.model.create({
      ownerId: ME,
      materialId: new Types.ObjectId(recording),
      folderId: FOLDER,
      title: '녹음 퀴즈',
      status: 'ready',
      deletedAt: null,
      questions: [
        {
          _id: new Types.ObjectId(),
          order: 1,
          prompt: '문제?',
          answer: '녹음 문장 0',
          conceptTags: [],
        },
      ],
    } as never);
    const hand = await addNote({
      kind: 'handwriting',
      title: '필기',
      pages: [{ pageNo: 1, ocrText: HANDWRITING_TEXT }],
      processing: { status: 'done', jobId: null },
    });
    await service.create(ME.toHexString(), hand);
    expect(queuedInputs()[0]!.notes[recording]).toEqual(EXPECTED_PAGES);
  });
});

describe('필기 노트는 그대로', () => {
  it('필기 노트의 입력 쪽은 textPages(material.pages)와 같고 녹음 대본을 읽지 않는다', async () => {
    const { service, recordingPages, addNote, queuedInputs } = setup();
    const spy = vi.spyOn(recordingPages, 'pages');
    const pages = [
      { pageNo: 1, ocrText: HANDWRITING_TEXT },
      { pageNo: 2, ocrText: '   ' },
    ];
    const id = await addNote({ kind: 'handwriting', title: '필기', pages });
    await service.create(ME.toHexString(), id);
    expect(queuedInputs()[0]!.material.pages).toEqual(textPages(pages));
    expect(spy).not.toHaveBeenCalled();
  });

  it('종류가 없는 옛 노트도 필기와 같게 쪽 글을 쓴다', async () => {
    const { service, materials, queuedInputs } = setup();
    const { _id } = (await materials.model.create({
      ownerId: ME,
      folderId: FOLDER,
      title: '옛 노트',
      deletedAt: null,
      pages: [{ pageNo: 1, ocrText: HANDWRITING_TEXT }],
    } as never)) as unknown as { _id: Types.ObjectId };
    await service.create(ME.toHexString(), _id.toHexString());
    expect(queuedInputs()[0]!.material.pages).toEqual([{ pageNo: 1, ocrText: HANDWRITING_TEXT }]);
  });

  it('쪽 글이 없는 필기 노트는 지금처럼 400', async () => {
    const { service, addNote } = setup();
    const id = await addNote({ kind: 'handwriting', pages: [] });
    await expect(service.create(ME.toHexString(), id)).rejects.toMatchObject(validation);
  });
});
