// 녹음 노트의 대본 → 퀴즈 처리기 입력 쪽([{pageNo, ocrText}]) 변환(FR-38)과 대본을 작업 결과에서 읽는 공용 함수 테스트.
// 쪽 나누기 기준: apps/ai services/quiz/generate.py (5줄 미만 쪽은 묻지 않음 · 생성 모델은 쪽 글 앞 2500자만 봄)
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  loadRecordingTranscript,
  RECORDING_ENOUGH_CHARS,
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
    // 마지막 쪽까지 모든 쪽이 처리기가 보는 길이(2500자) 안이다
    for (const p of pages) expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
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

/** 정확히 n자인 한 줄(공백 없음: 끝은 마침표) */
const solid = (n: number, tag = '가') => tag.repeat(n - 1) + '.';
/** 정확히 n자이고 공백이 있는 한 줄(공백에서 나눌 수 있다) */
const spaced = (n: number) => {
  const text = '가나다 '.repeat(Math.ceil(n / 4)).slice(0, n);
  return text.endsWith(' ') ? text.slice(0, -1) + '라' : text;
};
const asSentences = (texts: string[]) =>
  texts.map((text, i) => ({ text, startMs: i, endMs: i + 1 }));
const pagesOf = (texts: string[], slides: unknown[] = [slide(0, texts.length)]) =>
  transcriptToPages(make({ sentences: asSentences(texts), slides }));
const lineCount = (p: { ocrText: string }) => p.ocrText.split('\n').length;

describe('transcriptToPages: 길이 상한(2400자)은 합치거나 나눈 뒤에도 모든 쪽이 지킨다', () => {
  it('Codex 예시: 한 슬라이드에 100자 문장 27개(2,726자)는 마지막 쪽까지 모두 상한 안이고 고르게 나뉜다', () => {
    const texts = Array.from({ length: 27 }, (_, i) => solid(100, String.fromCharCode(0xac00 + i)));
    const pages = pagesOf(texts);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) {
      expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
      expect(lineCount(p)).toBeGreaterThanOrEqual(RECORDING_MIN_LINES);
    }
    expect(textOf(pages)).toEqual(texts); // 순서 · 내용 그대로
    const sizes = pages.map((p) => p.ocrText.length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(200); // 짧은 조각이 남지 않는다
  });

  it.each([
    [2399, 1],
    [2400, 1],
    [2401, 2],
  ])('경계값: 글 길이 %i자는 %i쪽이고, 모든 쪽이 상한 안', (total, expectedPages) => {
    // 24줄: 줄 사이 줄바꿈 23개를 더해 정확히 total 자
    const base = Math.floor((total - 23) / 24);
    const extra = total - 23 - base * 24;
    const texts = Array.from({ length: 24 }, (_, i) => solid(base + (i < extra ? 1 : 0)));
    expect(texts.join('\n')).toHaveLength(total);
    const pages = pagesOf(texts);
    expect(pages).toHaveLength(expectedPages);
    for (const p of pages) expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
    expect(textOf(pages)).toEqual(texts);
  });

  it('5줄이 안 되는 짧은 슬라이드를 아주 긴 슬라이드와 합쳐도 모든 쪽이 상한 안이고 5줄 이상이다', () => {
    const short = [spaced(30), spaced(30), spaced(30)]; // 3줄 · 90자: 글이 부족해 뒤와 합친다
    const long = Array.from({ length: 60 }, () => solid(100));
    const pages = pagesOf([...short, ...long], [slide(0, 3), slide(3, 63)]);
    expect(textOf(pages)).toEqual([...short, ...long]);
    for (const p of pages) {
      expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
      expect(lineCount(p)).toBeGreaterThanOrEqual(RECORDING_MIN_LINES);
    }
  });

  it('긴 쪽 뒤에 짧은 꼬리가 남아도 앞 쪽에 붙여 넘치지 않고 고르게 나눈다', () => {
    const texts = [
      ...Array.from({ length: 23 }, () => solid(100)),
      ...[1, 2, 3].map(() => solid(20)),
    ];
    const pages = pagesOf(texts, [slide(0, 23), slide(23, 26)]);
    for (const p of pages) expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
    expect(textOf(pages)).toEqual(texts);
  });

  it('한 문장이 상한보다 길면(공백 있음) 공백에서 나눠 모든 쪽이 상한 안이고 내용은 그대로다', () => {
    const sentence = spaced(5000);
    const pages = pagesOf([sentence]);
    for (const p of pages) {
      expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
      expect(lineCount(p)).toBeGreaterThanOrEqual(RECORDING_MIN_LINES);
    }
    expect(textOf(pages).join(' ')).toBe(sentence);
  });

  it('한 문장이 상한보다 긴데 공백이 없으면 상한 글자에서 자른다(이어 붙이면 그대로)', () => {
    const sentence = solid(5000);
    const pages = pagesOf([sentence]);
    for (const p of pages) expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
    expect(textOf(pages).join('')).toBe(sentence);
  });

  it('같은 대본은 늘 같은 쪽이 나온다(길이 · 긴 문장이 섞여도)', () => {
    const texts = [
      spaced(5000),
      ...Array.from({ length: 27 }, () => solid(100)),
      spaced(700),
      spaced(650),
    ];
    const slides = [slide(0, 1), slide(1, 28), slide(28, 30)];
    expect(pagesOf(texts, slides)).toEqual(pagesOf(texts, slides));
  });
});

describe('transcriptToPages: 글이 충분한데 5줄이 안 되는 쪽은 긴 줄을 공백에서 나눠 5줄을 채운다', () => {
  it('"충분"은 글자 수 합이 5줄 × 40자 = 200자 이상이다(처리기에는 글자 수 기준이 없고 askable 은 줄 수뿐)', () => {
    expect(RECORDING_ENOUGH_CHARS).toBe(RECORDING_MIN_LINES * 40);
  });

  it.each([
    ['600자 문장 4개(한 쪽 2,403자라 두 쪽으로 나뉜다)', [600, 600, 600, 600]],
    ['500자 문장 4개', [500, 500, 500, 500]],
    ['300자 문장 2개', [300, 300]],
    ['3000자 문장 1개', [3000]],
  ])('%s: 모든 쪽이 5줄 이상 · 2400자 이하', (_name, sizes) => {
    const texts = sizes.map((n) => spaced(n));
    const pages = pagesOf(texts);
    expect(pages.length).toBeGreaterThan(0);
    for (const p of pages) {
      expect(lineCount(p)).toBeGreaterThanOrEqual(RECORDING_MIN_LINES);
      expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
    }
    // 글은 그대로(나눈 곳의 공백만 줄바꿈이 된다)
    expect(textOf(pages).join(' ')).toBe(texts.join(' '));
  });

  it('긴 문장 몇 개로만 된 여러 슬라이드 대본도 모든 쪽이 5줄 이상 · 2400자 이하', () => {
    const texts = Array.from({ length: 10 }, (_, i) => spaced(600 + i * 25));
    const pages = pagesOf(texts, [slide(0, 3), slide(3, 4), slide(4, 10)]);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) {
      expect(lineCount(p)).toBeGreaterThanOrEqual(RECORDING_MIN_LINES);
      expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
    }
    expect(textOf(pages).join(' ')).toBe(texts.join(' '));
  });

  it('슬라이드가 없는 대본(문장만)도 같다', () => {
    const texts = [spaced(700), spaced(650), spaced(720), spaced(680)];
    const pages = transcriptToPages(make({ sentences: asSentences(texts) }));
    for (const p of pages) expect(lineCount(p)).toBeGreaterThanOrEqual(RECORDING_MIN_LINES);
  });

  it(`글자 수 합이 ${RECORDING_ENOUGH_CHARS}자 이상이면 4줄도 5줄로 나누고, 그보다 적으면 지금처럼 둔다`, () => {
    const lines = (total: number) => [0, 1, 2, 3].map(() => spaced(total / 4));
    const enough = pagesOf(lines(RECORDING_ENOUGH_CHARS));
    expect(enough).toHaveLength(1);
    expect(lineCount(enough[0]!)).toBeGreaterThanOrEqual(RECORDING_MIN_LINES);

    const lessText = [spaced(50), spaced(50), spaced(50), spaced(49)]; // 199자
    const less = pagesOf(lessText);
    expect(less).toHaveLength(1);
    expect(textOf(less)).toEqual(lessText); // 나누지 않는다
    // 글 자체가 짧은 대본도 그대로
    const tiny = [spaced(40), spaced(40), spaced(40)];
    expect(textOf(pagesOf(tiny))).toEqual(tiny);
  });

  it('공백이 전혀 없는 긴 문장은 나눌 곳이 없어 줄 수를 늘리지 못한다(상한은 지킨다)', () => {
    const pages = pagesOf([solid(600), solid(600)]);
    for (const p of pages) expect(p.ocrText.length).toBeLessThanOrEqual(RECORDING_PAGE_MAX_CHARS);
    expect(textOf(pages).join('')).toBe(solid(600) + solid(600));
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
