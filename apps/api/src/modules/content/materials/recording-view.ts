import type { Recording } from '@notelink/shared';

import { isRecord, text, uniqueHeading } from './material-sync.js';

type Playback = Pick<Recording, 'durationSec' | 'transcript' | 'slides'>;

const ms = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** 아직 정리 결과가 없을 때: 원본만 재생한다(앱이 "아직 대본이 없어요"를 보인다). 응답마다 새 값 */
export const emptyPlayback = (): Playback => ({
  durationSec: 0,
  transcript: { text: '', segments: [] },
  slides: [],
});

/** 요약 2~3문장을 슬라이드 글머리로. 문장 끝(. ! ? 。) 뒤 공백에서 나누고, 같은 글은 한 번만(앱이 글을 목록 키로 쓴다) */
export function bulletsOf(summary: string): string[] {
  const out: string[] = [];
  for (const part of summary.split(/(?<=[.!?。])\s+/)) {
    const line = part.trim();
    if (line && !out.includes(line)) out.push(line);
  }
  return out;
}

/** [startMs, endMs) 가 길이 있는 구간이면 초로. 아니면 null(길이 0 구간은 플레이어가 고를 수 없다: pos >= start && pos < end) */
function span(item: Record<string, unknown>): { startSec: number; endSec: number } | null {
  const start = ms(item['startMs']);
  const end = ms(item['endMs']);
  if (start === null || end === null || end <= start) return null;
  return { startSec: start / 1000, endSec: end / 1000 };
}

/** 문장의 단어 시각(처리기 SentenceWord {text, startMs, endMs})을 초로. 구간이 틀리거나 글이 빈 단어는 뺀다 */
function wordsOf(v: unknown): { text: string; startSec: number; endSec: number }[] {
  return (Array.isArray(v) ? v : []).filter(isRecord).flatMap((w) => {
    const at = span(w);
    const word = text(w['text']);
    return at && word ? [{ text: word, ...at }] : [];
  });
}

/**
 * 녹음 정리 결과(apps/ai services/recording/models.py RecordingResult)를 재생 화면 값(packages/shared
 * Recording 의 길이 · 대본 · 슬라이드)으로. 문장(sentences)은 대본 구간(segments, 단어 시각이 있으면 words 도), 슬라이드는 제목 + 요약 문장
 * 글머리로 바꾼다. 형식이 틀린 항목은 빼고, 요약이 빈 슬라이드도 노트 요약(material-sync sectionsFromSlides)처럼
 * 빼며 같은 제목은 노트 요약처럼 "(2)"를 붙인다. 시간 구간이 틀린 슬라이드는 재생 화면에서만 빠진다(노트 요약에는
 * 남는다). 결과 자체가 없거나 틀리면 빈 값
 */
export function playbackFromResult(result: unknown): Playback {
  if (!isRecord(result)) return emptyPlayback();
  const durationMs = ms(result['durationMs']);
  const segments = (Array.isArray(result['sentences']) ? result['sentences'] : [])
    .filter(isRecord)
    .flatMap((s) => {
      const at = span(s);
      const line = text(s['text']);
      if (!at || !line) return [];
      const words = wordsOf(s['words']);
      return [words.length ? { ...at, text: line, words } : { ...at, text: line }];
    });
  const used = new Set<string>();
  const slides = (Array.isArray(result['slides']) ? result['slides'] : [])
    .filter(isRecord)
    .flatMap((s) => {
      const at = span(s);
      const summary = text(s['summary']);
      return at && summary ? [{ title: text(s['title']), summary, at }] : [];
    })
    .map(({ title, summary, at }, index) => ({
      index,
      title: uniqueHeading(title ?? `내용 ${index + 1}`, used),
      bullets: bulletsOf(summary),
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
