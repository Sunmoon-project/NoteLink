// 녹음 노트의 대본 → 퀴즈 처리기 입력 쪽([{pageNo, ocrText}]) 변환(FR-38)과 대본을 작업 결과에서 읽는 공용 함수 테스트.
// 쪽 나누기 기준: apps/ai services/quiz/generate.py (5줄 미만 쪽은 묻지 않음 · 생성 모델은 쪽 글 앞 2500자만 봄)
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  loadRecordingTranscript,
  RECORDING_JOB_PROJECTION,
  RECORDING_MIN_LINES,
  RECORDING_PAGE_MAX_CHARS,
  recordingTranscriptOf,
  transcriptToPages,
} from '../src/quiz-sets/recording-pages.js';
import { createFakeJobs } from './support/fake-ai-jobs.js';

const line = (i: number, pad = 0) => `문장 ${i}` + '가'.repeat(pad) + '.';
const sentences = (n: number, pad = 0) =>
  Array.from({ length: n }, (_, i) => ({
    text: line(i, pad),
    startMs: i,
    endMs: i + 1,
    words: [],
  }));
const slide = (sentenceStart: number, sentenceEnd: number) => ({
  sentenceStart,
  sentenceEnd,
  title: `슬라이드 ${sentenceStart}`,
  summary: '요약',
});
const make = (result: unknown) => recordingTranscriptOf(result)!;
const textOf = (pages: { ocrText: string }[]) => pages.flatMap((p) => p.ocrText.split('\n'));

describe('transcriptToPages: 대본 → 쪽', () => {
  it('슬라이드 하나가 쪽 하나, 5줄보다 짧은 슬라이드는 뒤 슬라이드와 합친다', () => {
    // 슬라이드: 6줄 · 2줄 · 4줄 → 6줄 쪽 + (2 + 4)줄 쪽
    const pages = transcriptToPages(
      make({ sentences: sentences(12), slides: [slide(0, 6), slide(6, 8), slide(8, 12)] }),
    );
    expect(pages.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(pages[0]!.ocrText.split('\n')).toHaveLength(6);
    expect(pages[1]!.ocrText.split('\n')).toEqual([6, 7, 8, 9, 10, 11].map((i) => line(i)));
  });

  it('마지막에 남은 짧은 부분은 앞 쪽에 붙인다', () => {
    const pages = transcriptToPages(
      make({ sentences: sentences(8), slides: [slide(0, 6), slide(6, 8)] }),
    );
    expect(pages).toHaveLength(1);
    expect(pages[0]!.ocrText.split('\n')).toHaveLength(8);
  });

  it('한 쪽이 2400자를 넘으면 문장 경계에서 나눈다(문장을 잃지 않고 순서 그대로, 모든 쪽이 5줄 이상)', () => {
    const all = sentences(60, 90); // 문장마다 약 100자
    const pages = transcriptToPages(make({ sentences: all, slides: [slide(0, 60)] }));
    expect(pages.length).toBeGreaterThan(1);
    expect(textOf(pages)).toEqual(all.map((s) => s.text));
    for (const p of pages) {
      expect(p.ocrText.split('\n').length).toBeGreaterThanOrEqual(RECORDING_MIN_LINES);
    }
    // 마지막이 아닌 쪽은 처리기가 보는 길이(2500자) 안이다
    for (const p of pages.slice(0, -1))
      expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
    expect(pages.map((p) => p.pageNo)).toEqual(pages.map((_, i) => i + 1));
  });

  it('슬라이드가 없거나 모양이 틀리면(겹침 · 범위 밖 · 숫자가 아님) 문장을 차례로 묶는다', () => {
    const all = sentences(30, 90);
    for (const slides of [
      undefined,
      [],
      [{ sentenceStart: 'a', sentenceEnd: 3 }],
      [slide(5, 5), slide(40, 50)],
    ]) {
      const pages = transcriptToPages(make({ sentences: all, slides }));
      expect(textOf(pages)).toEqual(all.map((s) => s.text));
    }
    // 겹치는 슬라이드는 앞 것만 쓴다
    const overlapped = transcriptToPages(
      make({ sentences: sentences(12), slides: [slide(0, 8), slide(4, 12)] }),
    );
    expect(textOf(overlapped)).toEqual(sentences(12).map((s) => s.text));
  });

  it('슬라이드가 덮지 못한 문장도 버리지 않는다', () => {
    const pages = transcriptToPages(make({ sentences: sentences(14), slides: [slide(3, 9)] }));
    expect(textOf(pages)).toEqual(sentences(14).map((s) => s.text));
  });

  it('문장이 없으면 전체 대본(transcript)을 문장 부호로 나눈다', () => {
    const transcript = Array.from({ length: 7 }, (_, i) => line(i)).join(' ');
    const pages = transcriptToPages(make({ transcript }));
    expect(textOf(pages)).toEqual(Array.from({ length: 7 }, (_, i) => line(i)));
  });

  it('빈 문장은 줄로 세지 않는다. 글이 없으면 쪽도 없다', () => {
    const withBlanks = [
      ...sentences(3),
      { text: '   ', startMs: 0, endMs: 1 },
      { text: 5 },
      ...sentences(4),
    ];
    const pages = transcriptToPages(make({ sentences: withBlanks }));
    expect(pages[0]!.ocrText.split('\n')).toHaveLength(7);
    expect(transcriptToPages(make({ sentences: [], transcript: '  ' }))).toEqual([]);
  });

  it('같은 결과에서는 늘 같은 쪽이 나온다(미리 만든 결과를 다시 쓸 때 쪽 비교)', () => {
    const result = { sentences: sentences(40, 50), slides: [slide(0, 25), slide(25, 40)] };
    expect(transcriptToPages(make(result))).toEqual(transcriptToPages(make(result)));
  });

  it('결과가 객체가 아니면 읽지 않는다', () => {
    expect(recordingTranscriptOf(null)).toBeNull();
    expect(recordingTranscriptOf('x')).toBeNull();
  });
});

describe('loadRecordingTranscript: 작업 결과에서 대본 읽기', () => {
  const owner = new Types.ObjectId();
  const result = {
    durationMs: 1000,
    transcript: '전체 대본.',
    sentences: sentences(6),
    slides: [slide(0, 6)],
    chunks: [{ embedding: [0.1, 0.2] }],
  };
  const setup = () => {
    const jobs = createFakeJobs();
    const findOne = vi.fn(jobs.model.findOne);
    const model = { ...jobs.model, findOne } as never;
    const add = (over: Record<string, unknown> = {}) => {
      const row = {
        _id: new Types.ObjectId(),
        type: 'recording_summary',
        userId: owner,
        status: 'succeeded',
        result,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...over,
      };
      jobs.rows.push(row as never);
      return row._id;
    };
    return { model, findOne, add };
  };

  it('성공한 녹음 정리 작업이면 대본을 돌려준다', async () => {
    const { model, add } = setup();
    const id = add();
    const got = await loadRecordingTranscript(model, owner, id);
    expect(transcriptToPages(got!)).toHaveLength(1);
  });

  it('성공이 아니거나 남의 작업이거나 다른 종류거나 id 가 없으면 null', async () => {
    const { model, add } = setup();
    for (const status of ['queued', 'running', 'failed', 'canceled']) {
      expect(await loadRecordingTranscript(model, owner, add({ status }))).toBeNull();
    }
    expect(
      await loadRecordingTranscript(model, owner, add({ userId: new Types.ObjectId() })),
    ).toBeNull();
    expect(
      await loadRecordingTranscript(model, owner, add({ type: 'handwriting_summary' })),
    ).toBeNull();
    expect(await loadRecordingTranscript(model, owner, null)).toBeNull();
    expect(await loadRecordingTranscript(model, owner, undefined)).toBeNull();
  });

  it('필요한 필드만 읽는다(단어 시각 · 조각 embedding · 슬라이드 요약 도식은 읽지 않는다)', async () => {
    const { model, findOne, add } = setup();
    await loadRecordingTranscript(model, owner, add());
    expect(findOne.mock.calls[0]![1]).toBe(RECORDING_JOB_PROJECTION);
    expect(Object.keys(RECORDING_JOB_PROJECTION).sort()).toEqual([
      'result.sentences.text',
      'result.slides.sentenceEnd',
      'result.slides.sentenceStart',
      'result.transcript',
      'status',
    ]);
    expect(JSON.stringify(RECORDING_JOB_PROJECTION)).not.toMatch(/words|embedding|chunks|diagram/);
  });
});
