import type { Recording } from '@notelink/shared';

type Segment = Recording['transcript']['segments'][number];
type Slide = Recording['slides'][number];

/** 대본 한 문단: 슬라이드 하나(title 있음) 또는 슬라이드 사이 빈 구간(title 없음)의 문장들 */
export type TranscriptParagraph = {
  key: string;
  title: string | null;
  startSec: number;
  segments: Segment[];
};

const byStart = <T extends { startSec: number }>(xs: readonly T[]) =>
  [...xs].sort((a, b) => a.startSec - b.startSec);

/**
 * 재생 위치가 속한 구간 [lo, hi). 슬라이드 안이면 그 슬라이드 구간, 슬라이드 사이(또는 앞 · 뒤)면
 * 앞 슬라이드 끝 ~ 다음 슬라이드 시작. 요약 화면 아래 대본은 이 구간의 문장만 보여 준다
 */
export function rangeAt(slides: readonly Slide[], pos: number): { lo: number; hi: number } {
  const sorted = byStart(slides);
  const on = sorted.find((s) => pos >= s.startSec && pos < s.endSec);
  if (on) return { lo: on.startSec, hi: on.endSec };
  const before = sorted.filter((s) => s.endSec <= pos);
  const after = sorted.find((s) => s.startSec > pos);
  return {
    lo: before.length ? Math.max(...before.map((s) => s.endSec)) : 0,
    hi: after ? after.startSec : Number.POSITIVE_INFINITY,
  };
}

/** 문장은 시작 시각으로 구간에 넣는다(구간 경계에 걸친 문장이 두 번 나오지 않게) */
export function segmentsIn(segments: readonly Segment[], lo: number, hi: number): Segment[] {
  return segments.filter((s) => s.startSec >= lo && s.startSec < hi);
}

/**
 * 전체 대본을 슬라이드별 문단으로. 슬라이드에 들지 않는 문장(슬라이드 앞 · 사이 · 뒤)은 제목 없는 문단으로
 * 시간 순서대로 끼운다. 슬라이드가 없으면 문단 하나
 */
export function paragraphs(
  slides: readonly Slide[],
  segments: readonly Segment[],
): TranscriptParagraph[] {
  const out: TranscriptParagraph[] = [];
  let gap: Segment[] = [];
  const flushGap = () => {
    if (gap.length)
      out.push({
        key: `gap-${gap[0]!.startSec}`,
        title: null,
        startSec: gap[0]!.startSec,
        segments: gap,
      });
    gap = [];
  };
  const sortedSlides = byStart(slides);
  const slideOf = (seg: Segment) =>
    sortedSlides.find((s) => seg.startSec >= s.startSec && seg.startSec < s.endSec);
  let current: TranscriptParagraph | null = null;
  for (const seg of byStart(segments)) {
    const slide = slideOf(seg);
    if (!slide) {
      current = null;
      gap.push(seg);
      continue;
    }
    if (current?.key !== `slide-${slide.index}`) {
      flushGap();
      current = {
        key: `slide-${slide.index}`,
        title: slide.title,
        startSec: slide.startSec,
        segments: [],
      };
      out.push(current);
    }
    current.segments.push(seg);
  }
  flushGap();
  return out;
}
