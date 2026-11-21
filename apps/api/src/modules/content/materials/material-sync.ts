import type { AppAiJob } from '../../../ai-jobs/ai-jobs.service.js';
import type { MaterialRow } from './material-view.js';
import { fitSections, type Section } from './summary-fit.js';

/** 문서 요약의 핵심 요약(points) 개수 상한 */
export const POINTS_MAX = 20;
/** 키워드 개수 상한 */
export const KEYWORDS_MAX = 30;
/** 흐린 글자 표시(OCR 낱말 앞 [?]). 쪽 글(ocrText)에만 남기고 요약 · 핵심 요약에서는 지운다 */
const UNCERTAIN = /\[\?\]\s*/g;
/** 쪽 · 문제 번호만 있는 줄(P.138 Q.8, 139.p Q: 5): 핵심 요약으로 쓰지 않는다 */
const REF_ONLY =
  /^[\s\d.,:;()[\]/#~-]*(?:(?:p{1,2}|page|q|no|쪽|페이지|문제|번)[\s\d.,:;()[\]/#~-]*)*$/i;
/** 이보다 글자(한글 · 영문)가 적은 제목은 핵심 요약으로 쓰지 않는다 */
const POINT_MIN_LETTERS = 2;

type Page = NonNullable<MaterialRow['pages']>[number];

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
/** 앞뒤 공백을 지운 글. 비었거나 글이 아니면 null */
export const text = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;
/** [?] 를 지운 글. 비면 null */
const clean = (v: unknown): string | null =>
  typeof v === 'string' ? text(v.replace(UNCERTAIN, '')) : null;

/**
 * 제목이 겹치지 않게 한다. 앱이 제목을 목록 키로 쓰므로(NoteBody) 같은 제목은 "(2)", "(3)"을 붙인다
 */
export function uniqueHeading(heading: string, used: Set<string>): string {
  let out = heading;
  for (let n = 2; used.has(out); n += 1) out = `${heading} (${n})`;
  used.add(out);
  return out;
}

/**
 * 노트 정리 결과의 조각(chunks: apps/ai services/note/models.py Chunk)을 요약 소제목 · 본문으로.
 * 조각의 제목(title)이 소제목이고, 없으면 AI 가 지은 소제목(headings: 문단 번호 → 소제목)을 쓴다.
 * 둘 다 없는 조각은 같은 쪽이면 앞 소제목 아래에 이어 붙이고, 쪽이 바뀌거나 앞 조각이 없으면
 * "n쪽"(쪽을 모르면 "내용 n")으로 새 소제목을 연다. embedding · 줄 위치 같은 값은 노트에 저장하지 않는다
 */
export function sectionsFromChunks(
  raw: unknown,
  headings: ReadonlyMap<number, string> = new Map(),
): { sections: Section[]; titles: string[] } {
  const chunks = (Array.isArray(raw) ? raw : []).filter(isRecord);
  const ordered = [...chunks].sort(
    (a, b) =>
      (typeof a['order'] === 'number' ? a['order'] : 0) -
      (typeof b['order'] === 'number' ? b['order'] : 0),
  );
  const sections: Section[] = [];
  const used = new Set<string>();
  const titles: string[] = [];
  let lastPage: number | null = null;
  for (const chunk of ordered) {
    const body = clean(chunk['text']);
    if (!body) continue;
    const title = clean(chunk['title']);
    if (title && !titles.includes(title)) titles.push(title);
    const order = chunk['order'];
    const heading = title ?? (typeof order === 'number' ? headings.get(order) : undefined);
    const page = firstPage(chunk);
    const last = sections[sections.length - 1];
    if (heading) {
      sections.push({ heading: uniqueHeading(heading, used), body });
    } else if (last && (page === null || page === lastPage)) {
      last.body = `${last.body}\n${body}`;
    } else {
      const name = page === null ? `내용 ${sections.length + 1}` : `${page}쪽`;
      sections.push({ heading: uniqueHeading(name, used), body });
    }
    if (page !== null) lastPage = page;
  }
  return { sections: fitSections(sections), titles };
}

/** 조각 첫 줄의 쪽 번호(lines[0].pageNo). 없으면 null */
function firstPage(chunk: Record<string, unknown>): number | null {
  const lines = chunk['lines'];
  const first: unknown = Array.isArray(lines) ? lines[0] : undefined;
  return isRecord(first) && isCount(first['pageNo']) ? first['pageNo'] : null;
}

/** 개념 태그(concept)에서 키워드. 퀴즈 처리기처럼 자동으로 붙인 것(conceptStatus === 'auto')만, 중복 없이 */
export function keywordsFromChunks(raw: unknown): string[] {
  const out: string[] = [];
  for (const chunk of (Array.isArray(raw) ? raw : []).filter(isRecord)) {
    const concept = text(chunk['concept']);
    if (concept && chunk['conceptStatus'] === 'auto' && !out.includes(concept)) out.push(concept);
    if (out.length >= KEYWORDS_MAX) break;
  }
  return out;
}

/** 조각 제목 중 핵심 요약으로 쓸 만한 것(쪽 · 문제 번호만 있거나 글자가 너무 적은 줄은 뺌) */
export function pointsFromTitles(titles: string[]): string[] {
  return titles
    .filter((t) => !REF_ONLY.test(t) && (t.match(/[가-힣a-z]/gi) ?? []).length >= POINT_MIN_LETTERS)
    .slice(0, POINTS_MAX);
}

/**
 * 노트 정리 결과의 요약(result.summary: {points, keywords, headings}, apps/ai services/note/summary.py).
 * 글이 아닌 값 · 빈 글 · 중복은 뺀다. 없거나 모양이 다르면 빈 목록. headings 는 문단 번호 → 소제목
 */
export function summaryFromResult(raw: unknown): {
  points: string[];
  keywords: string[];
  headings: Map<number, string>;
} {
  const list = (v: unknown, max: number) => {
    const out: string[] = [];
    for (const item of Array.isArray(v) ? v : []) {
      const value = clean(item);
      if (value && !out.includes(value)) out.push(value);
      if (out.length >= max) break;
    }
    return out;
  };
  const summary = isRecord(raw) ? raw : {};
  const headings = new Map<number, string>();
  for (const item of Array.isArray(summary['headings']) ? summary['headings'] : []) {
    if (!isRecord(item) || !isCount(item['order']) || headings.has(item['order'])) continue;
    const value = clean(item['text']);
    if (value) headings.set(item['order'], value);
  }
  return {
    points: list(summary['points'], POINTS_MAX),
    keywords: list(summary['keywords'], KEYWORDS_MAX),
    headings,
  };
}

/** 녹음 정리 결과의 슬라이드(apps/ai services/recording/models.py Slide)를 요약 소제목 · 본문으로 */
export function sectionsFromSlides(raw: unknown): Section[] {
  const sections: Section[] = [];
  const used = new Set<string>();
  for (const slide of (Array.isArray(raw) ? raw : []).filter(isRecord)) {
    const body = text(slide['summary']);
    if (!body) continue;
    const heading = text(slide['title']) ?? `내용 ${sections.length + 1}`;
    sections.push({ heading: uniqueHeading(heading, used), body });
  }
  return fitSections(sections);
}

/** 원본이 PDF 한 개인지(여러 쪽으로 펼쳐지는 경우) */
const isSinglePdf = (row: MaterialRow): boolean =>
  (row.blobUrls ?? []).length === 1 && row.blobUrls![0]!.toLowerCase().endsWith('.pdf');

/**
 * 결과의 쪽 글(result.pages: [{pageNo, ocrText}])을 노트의 쪽(pages)에 맞춘다. 맞출 수 없으면 null.
 * - 이미지: 업로드마다 한 쪽이라 번호가 1..업로드 수 그대로다. 글이 없는 쪽은 결과에 빠져도 되고(ocrText null),
 *   업로드 수를 넘는 번호가 오면 어긋난 결과라 null.
 * - PDF 한 개(문서): 처리기가 쪽 수만큼 번호를 차지한다. 노트의 쪽 하나를 결과의 쪽 수만큼 펼치고,
 *   펼친 쪽의 이미지 주소 · 크기는 그 PDF 의 것을 함께 쓴다
 */
export function matchPages(row: MaterialRow, raw: unknown): Page[] | null {
  const original = row.pages ?? [];
  const results = new Map<number, string>();
  for (const p of (Array.isArray(raw) ? raw : []).filter(isRecord)) {
    const pageNo = p['pageNo'];
    if (!isCount(pageNo) || typeof p['ocrText'] !== 'string' || results.has(pageNo)) return null;
    results.set(pageNo, p['ocrText']);
  }
  if (results.size === 0) return null;
  if (isSinglePdf(row) && original.length >= 1) {
    const pdf = original[0]!;
    return [...results.entries()]
      .sort(([a], [b]) => a - b)
      .map(([pageNo, ocrText]) => ({
        pageNo,
        imageUrl: pdf.imageUrl,
        sizeBytes: pdf.sizeBytes,
        ocrText,
        takenAt: null,
      }));
  }
  if ([...results.keys()].some((n) => n > original.length)) return null;
  return original.map((p) => ({ ...p, ocrText: results.get(p.pageNo) ?? null }));
}

/** 작업 상태 → 노트 처리 상태(packages/shared Material.processing.status) */
const PROCESSING_OF: Record<string, 'queued' | 'processing' | 'failed' | undefined> = {
  queued: 'queued',
  running: 'processing',
  failed: 'failed',
  canceled: 'failed',
};

/**
 * 작업 상태에 맞춰 노트에 고칠 값($set). 고칠 것이 없으면 null.
 * - 대기 · 처리 중: 처리 상태와 진행률(다시 시도한 작업이면 실패했던 노트도 다시 처리 중으로)
 * - 실패 · 취소: 처리 실패
 * - 성공: 노트 종류에 따라 결과를 옮겨 처리 완료. 쓸 결과가 없거나 어긋나면 처리 실패
 * 개념 이름 캐시(concepts)는 글이 바뀌므로 비운다(다음 퀴즈 때 처리기가 다시 뽑는다)
 */
export function syncFromJob(row: MaterialRow, job: AppAiJob): Record<string, unknown> | null {
  const current = row.processing.status;
  if (current === 'done') return null;
  const progress = row.processing.progress ?? 0;
  if (job.status !== 'succeeded') {
    const status = PROCESSING_OF[job.status];
    if (!status) return null;
    const next = status === 'failed' ? progress : job.progress;
    if (status === current && next === progress) return null;
    return { 'processing.status': status, 'processing.progress': next };
  }
  const done = { 'processing.status': 'done', 'processing.progress': 100, concepts: [] };
  const failed = { 'processing.status': 'failed', 'processing.progress': progress };
  const result = isRecord(job.result) ? job.result : {};

  if (row.kind === 'recording') {
    const sections = sectionsFromSlides(result['slides']);
    if (sections.length === 0) return failed;
    return { ...done, summary: { sections, points: [] }, keywords: [] };
  }

  const pages = matchPages(row, result['pages']);
  if (!pages) return failed;
  const made = summaryFromResult(result['summary']);
  const { sections, titles } = sectionsFromChunks(result['chunks'], made.headings);
  // AI 가 만든 핵심 요약이 없으면(예전 결과 · 요약 실패) 문서는 걸러낸 조각 제목으로 대신한다
  const points =
    made.points.length > 0 ? made.points : row.kind === 'document' ? pointsFromTitles(titles) : [];
  const keywords = [...new Set([...keywordsFromChunks(result['chunks']), ...made.keywords])];
  return {
    ...done,
    pages,
    summary: sections.length > 0 ? { sections, points } : null,
    keywords: keywords.slice(0, KEYWORDS_MAX),
  };
}
