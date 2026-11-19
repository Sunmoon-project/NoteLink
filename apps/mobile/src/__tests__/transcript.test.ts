import { paragraphs, rangeAt, segmentsIn } from '../lib/transcript';

const slide = (index: number, startSec: number, endSec: number) => ({
  index,
  title: `슬라이드 ${index + 1}`,
  bullets: [],
  startSec,
  endSec,
});
const seg = (startSec: number, text: string) => ({ startSec, endSec: startSec + 5, text });

const slides = [slide(1, 60, 120), slide(0, 10, 60)]; // 순서가 섞여 와도 시간 순으로 본다
const segs = [
  seg(0, '인사'),
  seg(10, 'A1'),
  seg(40, 'A2'),
  seg(60, 'B1'),
  seg(118, 'B2'),
  seg(130, '끝'),
];

describe('rangeAt', () => {
  it('슬라이드 안이면 그 슬라이드 구간', () => {
    expect(rangeAt(slides, 42)).toEqual({ lo: 10, hi: 60 });
    expect(rangeAt(slides, 60)).toEqual({ lo: 60, hi: 120 });
  });
  it('첫 슬라이드 앞 · 마지막 뒤 · 슬라이드가 없으면 빈 구간', () => {
    expect(rangeAt(slides, 3)).toEqual({ lo: 0, hi: 10 });
    expect(rangeAt(slides, 150)).toEqual({ lo: 120, hi: Number.POSITIVE_INFINITY });
    expect(rangeAt([], 5)).toEqual({ lo: 0, hi: Number.POSITIVE_INFINITY });
  });
});

describe('segmentsIn', () => {
  it('시작 시각으로 넣어 경계에 걸친 문장이 두 구간에 나오지 않는다', () => {
    expect(segmentsIn(segs, 10, 60).map((s) => s.text)).toEqual(['A1', 'A2']);
    expect(segmentsIn(segs, 60, 120).map((s) => s.text)).toEqual(['B1', 'B2']);
  });
});

describe('paragraphs', () => {
  it('슬라이드별 문단 · 슬라이드 밖 문장은 제목 없는 문단으로 시간 순서대로', () => {
    expect(
      paragraphs(slides, segs).map((p) => [p.title, p.startSec, p.segments.map((s) => s.text)]),
    ).toEqual([
      [null, 0, ['인사']],
      ['슬라이드 1', 10, ['A1', 'A2']],
      ['슬라이드 2', 60, ['B1', 'B2']],
      [null, 130, ['끝']],
    ]);
  });
  it('슬라이드가 없으면 문단 하나', () => {
    expect(paragraphs([], segs)).toHaveLength(1);
  });
  it('문단 key는 서로 다르다', () => {
    const keys = paragraphs(slides, segs).map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
