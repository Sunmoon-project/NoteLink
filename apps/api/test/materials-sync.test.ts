import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import type { AppAiJob } from '../src/ai-jobs/ai-jobs.service.js';
import {
  keywordsFromChunks,
  matchPages,
  sectionsFromChunks,
  sectionsFromSlides,
  syncFromJob,
} from '../src/modules/content/materials/material-sync.js';
import type { MaterialRow } from '../src/modules/content/materials/material-view.js';

const page = (pageNo: number, imageUrl = `https://b/c/${pageNo}.jpg`) => ({
  pageNo,
  imageUrl,
  sizeBytes: 100 + pageNo,
  ocrText: null,
  takenAt: null,
});

const row = (over: Partial<MaterialRow> = {}): MaterialRow => ({
  _id: new Types.ObjectId(),
  ownerId: new Types.ObjectId(),
  folderId: new Types.ObjectId(),
  kind: 'handwriting',
  source: 'camera',
  title: '필기',
  processing: { status: 'queued', progress: 0, jobId: new Types.ObjectId() },
  pages: [page(1), page(2)],
  blobUrls: ['https://b/c/1.jpg', 'https://b/c/2.jpg'],
  createdAt: new Date(),
  ...over,
});

const job = (status: string, over: Partial<AppAiJob> = {}): AppAiJob => ({
  _id: new Types.ObjectId().toString(),
  type: 'handwriting_summary',
  status,
  targetType: 'material',
  targetId: new Types.ObjectId().toString(),
  progress: 0,
  attempts: 1,
  result: null,
  error: null,
  createdAt: '2026-11-15T00:00:00.000Z',
  updatedAt: '2026-11-15T00:00:00.000Z',
  ...over,
});

const chunk = (order: number, title: string | null, text: string, extra = {}) => ({
  order,
  title,
  path: [],
  text,
  lines: [{ pageNo: 1 }],
  embedding: [0.1, 0.2],
  ...extra,
});

describe('chunks → 요약 소제목 · 본문', () => {
  it('order 순으로 제목 · 본문을 옮기고 embedding 같은 값은 버린다', () => {
    const { sections, titles } = sectionsFromChunks([chunk(2, '둘째', 'b'), chunk(1, '첫째', 'a')]);
    expect(sections).toEqual([
      { heading: '첫째', body: 'a' },
      { heading: '둘째', body: 'b' },
    ]);
    expect(titles).toEqual(['첫째', '둘째']);
  });

  it('제목 없는 조각은 이전 조각의 소제목 아래에 이어 붙이고, 앞 조각이 없으면 "내용 n"', () => {
    const { sections } = sectionsFromChunks([
      chunk(1, null, '머리말'),
      chunk(2, null, '이어서'),
      chunk(3, '개념', '정의'),
      chunk(4, null, '예시'),
    ]);
    expect(sections).toEqual([
      { heading: '내용 1', body: '머리말\n이어서' },
      { heading: '개념', body: '정의\n예시' },
    ]);
  });

  it('같은 제목이 겹치면 번호를 붙이고, 빈 본문 · 모양이 틀린 조각은 건너뛴다', () => {
    const { sections } = sectionsFromChunks([
      chunk(1, '개념', 'a'),
      chunk(2, '개념', 'b'),
      chunk(3, '빈 글', '   '),
      'x',
      null,
    ]);
    expect(sections.map((s) => s.heading)).toEqual(['개념', '개념 (2)']);
    expect(sectionsFromChunks(undefined).sections).toEqual([]);
  });

  it('키워드는 자동으로 붙인 개념(auto)만, 중복 없이', () => {
    expect(
      keywordsFromChunks([
        chunk(1, 'a', 'x', { concept: '미분', conceptStatus: 'auto' }),
        chunk(2, 'b', 'x', { concept: '미분', conceptStatus: 'auto' }),
        chunk(3, 'c', 'x', { concept: '적분', conceptStatus: 'review' }),
        chunk(4, 'd', 'x', { concept: '  ', conceptStatus: 'auto' }),
        chunk(5, 'e', 'x', { concept: '극한', conceptStatus: 'auto' }),
      ]),
    ).toEqual(['미분', '극한']);
  });

  it('슬라이드는 제목 → 소제목, 설명 → 본문', () => {
    expect(
      sectionsFromSlides([
        { title: '도입', summary: '시작', diagram: null },
        { title: ' ', summary: '제목 없음' },
        { title: '빈 설명', summary: '' },
      ]),
    ).toEqual([
      { heading: '도입', body: '시작' },
      { heading: '내용 2', body: '제목 없음' },
    ]);
  });
});

describe('결과 쪽 글 → 노트의 쪽', () => {
  it('이미지: 번호대로 ocrText 를 채우고 글이 없는 쪽은 null, 나머지 값은 그대로', () => {
    const r = row();
    const pages = matchPages(r, [{ pageNo: 2, ocrText: '둘째 쪽' }])!;
    expect(pages).toEqual([
      { ...page(1), ocrText: null },
      { ...page(2), ocrText: '둘째 쪽' },
    ]);
  });

  it('이미지: 업로드 수를 넘는 번호 · 겹친 번호 · 빈 결과 · 잘못된 모양은 null', () => {
    const r = row();
    expect(matchPages(r, [{ pageNo: 3, ocrText: 'x' }])).toBeNull();
    expect(
      matchPages(r, [
        { pageNo: 1, ocrText: 'a' },
        { pageNo: 1, ocrText: 'b' },
      ]),
    ).toBeNull();
    expect(matchPages(r, [])).toBeNull();
    expect(matchPages(r, undefined)).toBeNull();
    expect(matchPages(r, [{ pageNo: 0, ocrText: 'x' }])).toBeNull();
    expect(matchPages(r, [{ pageNo: 1, ocrText: 5 }])).toBeNull();
  });

  it('PDF 한 개: 결과의 쪽 수만큼 펼치고 이미지 주소 · 크기는 그 PDF 것', () => {
    const pdf = row({
      kind: 'document',
      pages: [page(1, 'https://b/c/doc.pdf')],
      blobUrls: ['https://b/c/doc.pdf'],
    });
    const pages = matchPages(pdf, [
      { pageNo: 3, ocrText: 'c' },
      { pageNo: 1, ocrText: 'a' },
      { pageNo: 2, ocrText: 'b' },
    ])!;
    expect(pages.map((p) => [p.pageNo, p.ocrText, p.imageUrl, p.sizeBytes])).toEqual([
      [1, 'a', 'https://b/c/doc.pdf', 101],
      [2, 'b', 'https://b/c/doc.pdf', 101],
      [3, 'c', 'https://b/c/doc.pdf', 101],
    ]);
  });
});

describe('작업 상태 → 노트 (syncFromJob)', () => {
  it('대기 · 처리 중: 처리 상태와 진행률만. 같으면 null', () => {
    expect(syncFromJob(row(), job('running', { progress: 40 }))).toEqual({
      'processing.status': 'processing',
      'processing.progress': 40,
    });
    expect(syncFromJob(row(), job('queued'))).toBeNull();
    const running = row({ processing: { status: 'processing', progress: 40 } });
    expect(syncFromJob(running, job('running', { progress: 40 }))).toBeNull();
    expect(syncFromJob(running, job('running', { progress: 55 }))).toMatchObject({
      'processing.progress': 55,
    });
  });

  it('실패 · 취소: 처리 실패. 다시 시도한 작업이면 실패했던 노트가 처리 중으로 돌아온다', () => {
    for (const status of ['failed', 'canceled']) {
      expect(syncFromJob(row(), job(status))).toEqual({
        'processing.status': 'failed',
        'processing.progress': 0,
      });
    }
    const failed = row({ processing: { status: 'failed', progress: 30 } });
    expect(syncFromJob(failed, job('failed'))).toBeNull();
    expect(syncFromJob(failed, job('running', { progress: 5 }))).toEqual({
      'processing.status': 'processing',
      'processing.progress': 5,
    });
  });

  it('이미 끝난 노트는 건드리지 않는다', () => {
    const done = row({ processing: { status: 'done', progress: 100 } });
    for (const status of ['queued', 'running', 'succeeded', 'failed']) {
      expect(syncFromJob(done, job(status))).toBeNull();
    }
  });

  it('필기 성공: 쪽 글 · 소제목 · 키워드를 채우고 완료, 개념 캐시는 비운다. points 는 비어 있다', () => {
    const update = syncFromJob(
      row(),
      job('succeeded', {
        result: {
          pages: [
            { pageNo: 1, ocrText: '첫 쪽' },
            { pageNo: 2, ocrText: '둘째 쪽' },
          ],
          lineResults: [{ big: 'x' }],
          warnings: [],
          chunks: [chunk(1, '미분', '정의', { concept: '미분', conceptStatus: 'auto' })],
        },
      }),
    )!;
    expect(update).toMatchObject({
      'processing.status': 'done',
      'processing.progress': 100,
      concepts: [],
      keywords: ['미분'],
      summary: { sections: [{ heading: '미분', body: '정의' }], points: [] },
    });
    expect((update['pages'] as { ocrText: string }[]).map((p) => p.ocrText)).toEqual([
      '첫 쪽',
      '둘째 쪽',
    ]);
    // 큰 값(embedding · lineResults)은 노트에 옮기지 않는다
    expect(JSON.stringify(update)).not.toContain('embedding');
    expect(JSON.stringify(update)).not.toContain('lineResults');
  });

  it('문서 성공: 조각 제목이 핵심 요약(points)이 된다(중복 없이)', () => {
    const update = syncFromJob(
      row({ kind: 'document' }),
      job('succeeded', {
        result: {
          pages: [{ pageNo: 1, ocrText: 'a' }],
          chunks: [chunk(1, '서론', 'a'), chunk(2, '본론', 'b'), chunk(3, '서론', 'c')],
        },
      }),
    )!;
    expect(update['summary']).toMatchObject({ points: ['서론', '본론'] });
    expect(
      (update['summary'] as { sections: { heading: string }[] }).sections.map((s) => s.heading),
    ).toEqual(['서론', '본론', '서론 (2)']);
  });

  it('AI 가 만든 핵심 요약 · 키워드가 있으면 그것을 쓴다(필기도, 개념 키워드 뒤에 중복 없이)', () => {
    for (const kind of ['document', 'handwriting'] as const) {
      const update = syncFromJob(
        row({ kind }),
        job('succeeded', {
          result: {
            pages: [{ pageNo: 1, ocrText: 'a' }],
            chunks: [chunk(1, 'P.138 Q.8', 'a', { concept: '미분', conceptStatus: 'auto' })],
            summary: {
              points: ['미분은 순간 변화율이다.', ' [?]적분은 넓이다. ', '미분은 순간 변화율이다.'],
              keywords: ['적분', '미분', 3, ''],
            },
          },
        }),
      )!;
      expect(update['summary']).toMatchObject({
        points: ['미분은 순간 변화율이다.', '적분은 넓이다.'],
      });
      expect(update['keywords']).toEqual(['미분', '적분']);
    }
  });

  it('핵심 요약이 없으면 문서는 쪽 · 문제 번호만 있거나 글자가 적은 제목을 빼고 쓴다', () => {
    const titles = [
      'P- 137 Q. 7',
      'P.138 Q.8',
      '139.p [?]Q: 5',
      '5)',
      '요구 / 요청 V',
      '보기) 영사 5',
    ];
    const update = syncFromJob(
      row({ kind: 'document' }),
      job('succeeded', {
        result: {
          pages: [{ pageNo: 1, ocrText: 'a' }],
          chunks: titles.map((t, i) => chunk(i + 1, t, `본문 ${i}`)),
          summary: null,
        },
      }),
    )!;
    expect(update['summary']).toMatchObject({ points: ['요구 / 요청 V', '보기) 영사 5'] });
  });

  it('요약 소제목 · 본문의 [?] 는 지우고 쪽 글에는 남긴다', () => {
    const update = syncFromJob(
      row({ pages: [page(1)], blobUrls: ['https://b/c/1.jpg'] }),
      job('succeeded', {
        result: {
          pages: [{ pageNo: 1, ocrText: '[?]미분 정의' }],
          chunks: [chunk(1, '[?]미분', '[?]정의 [?] 끝')],
        },
      }),
    )!;
    expect(update['summary']).toMatchObject({ sections: [{ heading: '미분', body: '정의 끝' }] });
    expect((update['pages'] as { ocrText: string }[])[0]!.ocrText).toBe('[?]미분 정의');
  });

  it('조각이 없으면 요약은 null 이지만 쪽 글이 있으면 완료', () => {
    const update = syncFromJob(
      row(),
      job('succeeded', { result: { pages: [{ pageNo: 1, ocrText: 'a' }], chunks: [] } }),
    )!;
    expect(update).toMatchObject({ 'processing.status': 'done', summary: null, keywords: [] });
  });

  it('성공했지만 쓸 결과가 없거나 쪽이 어긋나면 실패', () => {
    expect(syncFromJob(row(), job('succeeded', { result: null }))).toMatchObject({
      'processing.status': 'failed',
    });
    expect(
      syncFromJob(row(), job('succeeded', { result: { pages: [{ pageNo: 9, ocrText: 'x' }] } })),
    ).toMatchObject({ 'processing.status': 'failed' });
  });

  it('녹음 성공: 슬라이드를 소제목 · 본문으로, 쪽은 건드리지 않는다. 슬라이드가 없으면 실패', () => {
    const rec = row({ kind: 'recording', source: 'audio_file', pages: [] });
    const update = syncFromJob(
      rec,
      job('succeeded', {
        type: 'recording_summary',
        result: {
          durationMs: 1,
          transcript: 'x'.repeat(10),
          slides: [{ title: '도입', summary: '시작', startMs: 0, endMs: 1 }],
        },
      }),
    )!;
    expect(update).toMatchObject({
      'processing.status': 'done',
      summary: { sections: [{ heading: '도입', body: '시작' }], points: [] },
      keywords: [],
      concepts: [],
    });
    expect(update).not.toHaveProperty('pages');
    expect(syncFromJob(rec, job('succeeded', { result: { slides: [] } }))).toMatchObject({
      'processing.status': 'failed',
    });
  });
});
