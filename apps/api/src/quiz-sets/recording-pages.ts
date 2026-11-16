import type { Model, Types } from 'mongoose';

import type { AiJobDocument } from '../modules/quiz/schemas/ai-job.schema.js';

/**
 * 녹음 노트의 대본을 퀴즈 처리기 입력의 노트 글([{pageNo, ocrText}])로 바꾼다(FR-38).
 * 녹음 노트는 쪽(pages)이 없고, 대본은 녹음 정리 작업(recording_summary)의 결과(ai_jobs.result)에만 있다.
 * 처리기(apps/ai services/quiz/generate.py)가 쪽 글을 쓰는 방식에 맞춘다:
 *  - 5줄(MIN_LINES)보다 짧은 쪽은 묻지 않는다 → 글이 부족한 짧은 슬라이드는 뒤 슬라이드와 합치고, 글은 충분한데 5줄이 안
 *    되는 쪽(긴 문장 몇 개)은 긴 줄을 공백에서 나눠 5줄을 채운다
 *  - 생성 모델은 쪽 글 앞 2500자(TEXT_CAP)만 본다 → 합친 뒤에도 모든 쪽이 2400자 안이 되게 길이 기준으로 고르게 나눈다.
 *    길이 상한이 5줄 규칙보다 우선한다(둘이 부딪히면 짧은 쪽을 허용한다)
 *  - 쪽마다 문제 수를 나누므로 쪽은 주제 단위(슬라이드)로 둔다
 * 앱은 문제의 쪽 번호를 화면에 쓰지 않으므로(처리기 안에서만 쓰임) 번호는 1부터 차례로만 붙인다.
 */

/** 처리기 입력의 노트 글 한 쪽 */
export interface RecordingPage {
  pageNo: number;
  ocrText: string;
}

/** 녹음 정리 작업 종류(apps/ai worker/handlers.py) */
export const RECORDING_JOB_TYPE = 'recording_summary';
/** 처리기가 문제를 내는 쪽의 최소 줄 수(apps/ai services/quiz/generate.py MIN_LINES) */
export const RECORDING_MIN_LINES = 5;
/** 한 쪽 글의 길이 한도. 처리기가 생성 모델에 보여 주는 길이(TEXT_CAP 2500자)보다 조금 짧게 둔다 */
export const RECORDING_PAGE_MAX_CHARS = 2400;
/**
 * 5줄이 안 돼도 글이 "충분"하다고 보는 글자 수(줄바꿈 뺀 글자 수 합): 5줄 × 줄당 40자. 처리기(generate.py askable)에는
 * 글자 수 기준이 없고 줄 수(5줄 이상)만 보므로, 한 줄이 한 문장으로 읽히는 길이(약 40자)로 정했다.
 * 이만큼 글이 있는 쪽은 긴 줄을 공백에서 나눠 5줄을 채우고, 그보다 짧은 글은 나누지 않고 그대로 둔다
 */
export const RECORDING_ENOUGH_CHARS = RECORDING_MIN_LINES * 40;

/**
 * 작업에서 읽는 필드. 대본에 필요한 것만 읽는다: 단어 시각(sentences.words) · 조각 embedding(chunks) ·
 * 슬라이드 요약 · 도식은 크고 쓰지 않는다. 상태는 성공 여부를 확인하는 데 쓴다
 */
export const RECORDING_JOB_PROJECTION = {
  status: 1,
  'result.transcript': 1,
  'result.sentences.text': 1,
  'result.slides.sentenceStart': 1,
  'result.slides.sentenceEnd': 1,
};

/** 작업 결과에서 읽은 대본 */
export interface RecordingTranscript {
  /** 문장 글(결과의 sentences 순서 그대로, 글이 아닌 항목은 빈 글). 슬라이드가 위치로 가리키므로 순서를 바꾸지 않는다 */
  sentences: string[];
  /** 슬라이드가 가리키는 문장 범위 [start, end) */
  slides: { start: number; end: number }[];
  /** 전체 대본(문장이 없을 때만 쓴다) */
  transcript: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 녹음 정리 결과(RecordingResult)에서 대본만 꺼낸다. 객체가 아니면 null */
export function recordingTranscriptOf(result: unknown): RecordingTranscript | null {
  if (!isRecord(result)) return null;
  const sentences = (Array.isArray(result['sentences']) ? result['sentences'] : []).map((s) =>
    isRecord(s) && typeof s['text'] === 'string' ? s['text'].trim() : '',
  );
  const slides = (Array.isArray(result['slides']) ? result['slides'] : []).flatMap((s) =>
    isRecord(s) && Number.isInteger(s['sentenceStart']) && Number.isInteger(s['sentenceEnd'])
      ? [{ start: s['sentenceStart'] as number, end: s['sentenceEnd'] as number }]
      : [],
  );
  const transcript = typeof result['transcript'] === 'string' ? result['transcript'].trim() : '';
  return { sentences, slides, transcript };
}

/**
 * 성공한 녹음 정리 작업에서 대본을 읽는다. 이 사용자의 recording_summary 이고 succeeded 일 때만 돌려주고,
 * 그 밖(없음 · 진행 중 · 실패 · 취소 · 남의 작업)은 null. 여러 곳에서 가져다 쓴다
 */
export async function loadRecordingTranscript(
  jobs: Model<AiJobDocument>,
  ownerId: Types.ObjectId,
  jobId: Types.ObjectId | null | undefined,
): Promise<RecordingTranscript | null> {
  if (!jobId) return null;
  const job = await jobs
    .findOne(
      { _id: jobId, userId: ownerId, type: RECORDING_JOB_TYPE, status: 'succeeded' },
      RECORDING_JOB_PROJECTION,
    )
    .lean<{ result?: unknown } | null>();
  return job ? recordingTranscriptOf(job.result) : null;
}

/** 문장 목록을 줄로 나눈다(전체 대본만 있을 때): 줄바꿈과 문장 부호 뒤 공백에서 */
function sentencesFromTranscript(transcript: string): string[] {
  return transcript
    .split(/\n+|(?<=[.!?。…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 문장 범위를 나눈다: 슬라이드 범위를 쓰고, 모양이 틀리거나 겹친 슬라이드는 건너뛰고, 덮지 못한 문장은 따로 둔다 */
function segments(length: number, slides: RecordingTranscript['slides']): [number, number][] {
  const out: [number, number][] = [];
  let cursor = 0;
  const sorted = [...slides].sort((a, b) => a.start - b.start);
  for (const { start, end } of sorted) {
    if (start < cursor || end <= start || end > length) continue;
    if (start > cursor) out.push([cursor, start]);
    out.push([start, end]);
    cursor = end;
  }
  if (cursor < length) out.push([cursor, length]);
  return out;
}

/** 줄들을 쪽 글로 이었을 때의 길이(줄 사이 줄바꿈 포함 = ocrText.length) */
const textLength = (lines: string[]): number =>
  lines.reduce((n, line) => n + line.length, 0) + Math.max(0, lines.length - 1);

/** 줄바꿈을 뺀 글자 수 합 */
const charCount = (lines: string[]): number => lines.reduce((n, line) => n + line.length, 0);

/** 처리기가 이 묶음을 쪽으로 물을 만큼의 글이 있는지: 5줄 이상이거나, 5줄로 나눌 만큼(RECORDING_ENOUGH_CHARS) 글이 있다 */
const enough = (lines: string[]): boolean =>
  lines.length >= RECORDING_MIN_LINES || charCount(lines) >= RECORDING_ENOUGH_CHARS;

const WHITESPACE = /\s/;

/** 한 줄을 가운데에 가장 가까운 공백에서 둘로 나눈다(같은 거리면 앞쪽 공백). 나눌 공백이 없으면 null */
function splitAtSpace(line: string): [string, string] | null {
  const mid = Math.floor(line.length / 2);
  for (let d = 0; d < line.length; d++) {
    for (const i of d === 0 ? [mid] : [mid - d, mid + d]) {
      if (i < 1 || i >= line.length - 1 || !WHITESPACE.test(line[i]!)) continue;
      const left = line.slice(0, i).trimEnd();
      const right = line.slice(i + 1).trimStart();
      if (left && right) return [left, right];
    }
  }
  return null;
}

/**
 * 한 문장이 쪽 상한(RECORDING_PAGE_MAX_CHARS)보다 길면 상한 안의 마지막 공백에서 자른다(공백이 없으면 상한 글자에서).
 * 그대로 두면 그 문장만으로 상한을 넘어 처리기가 앞 2500자만 보고 뒷부분은 출제에서 빠진다
 */
function fragments(line: string): string[] {
  const out: string[] = [];
  let rest = line;
  while (rest.length > RECORDING_PAGE_MAX_CHARS) {
    let cut = -1;
    for (let i = RECORDING_PAGE_MAX_CHARS; i >= 1; i--) {
      if (WHITESPACE.test(rest[i]!)) {
        cut = i;
        break;
      }
    }
    let head: string;
    if (cut > 0) {
      head = rest.slice(0, cut).trimEnd();
      rest = rest.slice(cut + 1).trimStart();
    } else {
      // 공백이 없으면 상한 글자에서 자른다(문자 한 개를 둘로 가르지 않게 앞 절반 서로게이트는 피한다)
      let end = RECORDING_PAGE_MAX_CHARS;
      const code = rest.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
      head = rest.slice(0, end);
      rest = rest.slice(end);
    }
    if (head) out.push(head);
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * 줄들을 k 쪽으로 길이가 비슷하게 나눈다(줄 순서 그대로). 각 쪽은 목표 길이(전체 / k)에 가장 가깝게 닫고,
 * 마지막 쪽이 나머지를 받는다
 */
function balanced(lines: string[], k: number): string[][] {
  const target = textLength(lines) / k;
  const parts: string[][] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (cur.length > 0 && parts.length < k - 1) {
      const now = textLength(cur);
      const next = now + 1 + line.length;
      // 이 줄을 더하면 목표에서 더 멀어질 때 닫는다
      if (Math.abs(next - target) > Math.abs(now - target)) {
        parts.push(cur);
        cur = [];
      }
    }
    cur.push(line);
  }
  parts.push(cur);
  return parts;
}

/**
 * 한 묶음을 모든 쪽이 상한 안에 들어가게 나눈다. 상한 안이면 그대로 한 쪽이고, 넘으면 쪽 수를 ceil(길이 / 상한)에서
 * 시작해 균등하게 나누고, 어느 쪽이 상한을 넘으면 쪽 수를 하나씩 늘린다. 한 줄은 이미 상한 이하이므로(fragments)
 * 늦어도 줄마다 한 쪽이면 끝난다. 균등하게 나누므로 짧은 마지막 조각이 남지 않는다
 */
function pack(lines: string[]): string[][] {
  const total = textLength(lines);
  if (total <= RECORDING_PAGE_MAX_CHARS) return [lines];
  for (let k = Math.ceil(total / RECORDING_PAGE_MAX_CHARS); k < lines.length; k++) {
    const parts = balanced(lines, k);
    if (parts.every((part) => textLength(part) <= RECORDING_PAGE_MAX_CHARS)) return parts;
  }
  return lines.map((line) => [line]);
}

/**
 * 글은 충분한데 5줄이 안 되는 쪽(긴 문장 몇 개)은 가장 긴 줄(같으면 앞쪽)부터 공백에서 나눠 5줄을 채운다. 나눌 공백이 없으면
 * 거기서 멈춘다. 글이 부족한 쪽은 나누지 않는다. 글자 수 합은 그대로라(공백이 줄바꿈이 된다) 길이 상한은 그대로 지킨다
 */
function fillLines(lines: string[]): string[] {
  if (lines.length >= RECORDING_MIN_LINES || charCount(lines) < RECORDING_ENOUGH_CHARS)
    return lines;
  const out = [...lines];
  while (out.length < RECORDING_MIN_LINES) {
    let best = -1;
    let bestSplit: [string, string] | null = null;
    for (let i = 0; i < out.length; i++) {
      if (best >= 0 && out[i]!.length <= out[best]!.length) continue;
      const split = splitAtSpace(out[i]!);
      if (split) {
        best = i;
        bestSplit = split;
      }
    }
    if (best < 0 || !bestSplit) break;
    out.splice(best, 1, bestSplit[0], bestSplit[1]);
  }
  return out;
}

/**
 * 대본을 처리기 입력의 쪽으로 바꾼다. 같은 대본에서는 늘 같은 쪽이 나온다(미리 만든 결과를 다시 쓸 때
 * 넣었던 쪽과 비교하므로: 난수 · 시계 없이 정해진 순서로만 계산한다). 글이 없으면 []
 */
export function transcriptToPages(transcript: RecordingTranscript): RecordingPage[] {
  const hasSentences = transcript.sentences.some((s) => s !== '');
  const all = hasSentences ? transcript.sentences : sentencesFromTranscript(transcript.transcript);
  const ranges: [number, number][] = hasSentences
    ? segments(all.length, transcript.slides)
    : all.length > 0
      ? [[0, all.length]]
      : [];

  // 1. 글이 부족한 짧은 슬라이드는 뒤 슬라이드와 합쳐 묶음으로 만든다(마지막 부족한 부분은 앞 묶음에 붙인다)
  const groups: string[][] = [];
  let pending: string[] = [];
  for (const [start, end] of ranges) {
    for (const line of all.slice(start, end)) if (line !== '') pending.push(...fragments(line));
    if (enough(pending)) {
      groups.push(pending);
      pending = [];
    }
  }
  if (pending.length > 0) {
    if (groups.length > 0) groups[groups.length - 1]!.push(...pending);
    else groups.push(pending);
  }
  // 2. 묶음마다 모든 쪽이 상한 안이 되게 고르게 나누고, 5줄이 안 되는 쪽은 긴 줄을 나눠 채운다
  const pages = groups.flatMap((group) => pack(group).map(fillLines));
  return pages.map((lines, i) => ({ pageNo: i + 1, ocrText: lines.join('\n') }));
}
