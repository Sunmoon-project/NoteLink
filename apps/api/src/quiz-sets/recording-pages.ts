import type { Model, Types } from 'mongoose';

import type { AiJobDocument } from '../modules/quiz/schemas/ai-job.schema.js';

/**
 * 녹음 노트의 대본을 퀴즈 처리기 입력의 노트 글([{pageNo, ocrText}])로 바꾼다(FR-38).
 * 녹음 노트는 쪽(pages)이 없고, 대본은 녹음 정리 작업(recording_summary)의 결과(ai_jobs.result)에만 있다.
 * 처리기(apps/ai services/quiz/generate.py)가 쪽 글을 쓰는 방식에 맞춘다:
 *  - 5줄(MIN_LINES)보다 짧은 쪽은 묻지 않는다 → 짧은 슬라이드는 뒤 슬라이드와 합친다
 *  - 생성 모델은 쪽 글 앞 2500자(TEXT_CAP)만 본다 → 그보다 긴 쪽은 문장 경계에서 나눈다
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

/** 줄들을 RECORDING_PAGE_MAX_CHARS 안으로 나눈다. 마지막에 5줄보다 짧게 남은 조각은 앞 조각에 붙인다 */
function splitByChars(lines: string[]): string[][] {
  const chunks: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const line of lines) {
    if (cur.length > 0 && size + line.length + 1 > RECORDING_PAGE_MAX_CHARS) {
      chunks.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(line);
    size += line.length + 1;
  }
  if (cur.length > 0) {
    if (cur.length < RECORDING_MIN_LINES && chunks.length > 0)
      chunks[chunks.length - 1]!.push(...cur);
    else chunks.push(cur);
  }
  return chunks;
}

/**
 * 대본을 처리기 입력의 쪽으로 바꾼다. 같은 대본에서는 늘 같은 쪽이 나온다(미리 만든 결과를 다시 쓸 때
 * 넣었던 쪽과 비교하므로). 글이 없으면 []
 */
export function transcriptToPages(transcript: RecordingTranscript): RecordingPage[] {
  const hasSentences = transcript.sentences.some((s) => s !== '');
  const all = hasSentences ? transcript.sentences : sentencesFromTranscript(transcript.transcript);
  const ranges: [number, number][] = hasSentences
    ? segments(all.length, transcript.slides)
    : all.length > 0
      ? [[0, all.length]]
      : [];

  const pages: string[][] = [];
  let pending: string[] = []; // 5줄이 안 돼 뒤와 합칠 줄
  for (const [start, end] of ranges) {
    const lines = all.slice(start, end).filter((s) => s !== '');
    for (const chunk of splitByChars(lines)) {
      pending.push(...chunk);
      if (pending.length >= RECORDING_MIN_LINES) {
        pages.push(pending);
        pending = [];
      }
    }
  }
  if (pending.length > 0) {
    if (pages.length > 0) pages[pages.length - 1]!.push(...pending);
    else pages.push(pending);
  }
  return pages.map((lines, i) => ({ pageNo: i + 1, ocrText: lines.join('\n') }));
}
