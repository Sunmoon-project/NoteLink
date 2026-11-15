import type { Recording } from '@notelink/shared';

type Playback = Pick<Recording, 'durationSec' | 'transcript' | 'slides'>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const ms = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** 아직 정리 결과가 없을 때: 원본만 재생한다(앱이 "아직 대본이 없어요"를 보인다) */
export const EMPTY_PLAYBACK: Playback = {
  durationSec: 0,
  transcript: { text: '', segments: [] },
  slides: [],
};

/** 요약 2~3문장을 슬라이드 글머리로. 문장 끝(. ! ? 。) 뒤 공백에서 나누고, 같은 글은 한 번만(앱이 글을 목록 키로 쓴다) */
export function bulletsOf(summary: string): string[] {
  const out: string[] = [];
  for (const part of summary.split(/(?<=[.!?。])\s+/)) {
    const line = part.trim();
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

/** [startMs, endMs] 가 맞는 구간이면 초로. 아니면 null */
function span(item: Record<string, unknown>): { startSec: number; endSec: number } | null {
  const start = ms(item['startMs']);
  const end = ms(item['endMs']);
  if (start === null || end === null || end < start) return null;
  return { startSec: start / 1000, endSec: end / 1000 };
}

/**
 * 녹음 정리 결과(apps/ai services/recording/models.py RecordingResult)를 재생 화면 값(packages/shared
 * Recording 의 길이 · 대본 · 슬라이드)으로. 문장(sentences)은 대본 구간(segments), 슬라이드는 제목 + 요약 문장
 * 글머리로 바꾼다. 형식이 틀린 항목은 빼고, 결과 자체가 없거나 틀리면 빈 값(EMPTY_PLAYBACK)
 */
export function playbackFromResult(result: unknown): Playback {
  if (!isRecord(result)) return EMPTY_PLAYBACK;
  const durationMs = ms(result['durationMs']);
  const segments = (Array.isArray(result['sentences']) ? result['sentences'] : [])
    .filter(isRecord)
    .flatMap((s) => {
      const at = span(s);
      const line = text(s['text']);
      return at && line ? [{ ...at, text: line }] : [];
    });
  const slides = (Array.isArray(result['slides']) ? result['slides'] : [])
    .filter(isRecord)
    .flatMap((s) => {
      const at = span(s);
      return at ? [{ s, at }] : [];
    })
    .map(({ s, at }, index) => ({
      index,
      title: text(s['title']) ?? `내용 ${index + 1}`,
      bullets: bulletsOf(text(s['summary']) ?? ''),
      ...at,
    }));
  return {
    durationSec: durationMs === null ? 0 : durationMs / 1000,
    transcript: {
      text: text(result['transcript']) ?? segments.map((s) => s.text).join(' '),
      segments,
    },
    slides,
  };
}
