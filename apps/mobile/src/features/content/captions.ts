// 녹음 자막(FR-20): 대본을 한 문장씩 나누고, 재생 위치로 지금 문장 · 채움 비율을 계산한다.
// lineAt · filled는 UI 스레드(Reanimated)에서도 돈다

export type Word = { text: string; startSec: number; endSec: number };
/** 화면에 한 번에 띄우는 문장 하나. words는 STT 단어 시각(없으면 빈 배열 → 글자 비례) */
export type Line = { text: string; startSec: number; endSec: number; words: Word[] };

type Segment = { text: string; startSec: number; endSec: number; words?: Word[] };

/** 문장 끝(. ? ! 뒤 공백). 「1.5배」처럼 공백이 없으면 자르지 않는다 */
const END = /[.?!]+\s+/g;
const tokens = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * STT 구간(phrase)이 두세 문장을 묶을 때가 있어 문장 끝에서 다시 자른다. 자른 자리의 시각은
 * 그 자리의 단어 시각(띄어쓰기 단위로 셈, 수가 안 맞으면 비율), 단어가 없으면 글자 비례
 */
export function splitLines(segments: readonly Segment[]): Line[] {
  const out: Line[] = [];
  for (const seg of segments) {
    const words = seg.words ?? [];
    const cuts = [0];
    for (const m of seg.text.matchAll(END)) cuts.push(m.index + m[0].length);
    if (cuts.at(-1)! >= seg.text.length) cuts.pop();
    cuts.push(seg.text.length);
    const total = tokens(seg.text) || 1;
    const span = seg.endSec - seg.startSec;
    let w = 0;
    for (let k = 0; k + 1 < cuts.length; k++) {
      const from = cuts[k]!;
      const to = cuts[k + 1]!;
      const text = seg.text.slice(from, to).trim();
      if (!text) continue;
      const last = k + 2 === cuts.length;
      const wEnd = last
        ? words.length
        : Math.round((tokens(seg.text.slice(0, to)) * words.length) / total);
      const mine = words.slice(w, wEnd);
      w = wEnd;
      out.push(
        mine.length
          ? {
              text,
              startSec: k === 0 ? seg.startSec : mine[0]!.startSec,
              endSec: last ? seg.endSec : mine.at(-1)!.endSec,
              words: mine,
            }
          : {
              text,
              startSec: seg.startSec + (span * from) / seg.text.length,
              endSec: seg.startSec + (span * to) / seg.text.length,
              words: [],
            },
      );
    }
  }
  return out;
}

/**
 * 지금 보일 문장 번호. 문장 사이(또는 첫 문장 전) 빈 구간이면 다음 문장, 끝 뒤면 마지막, 없으면 -1.
 * 긴 녹음은 문장이 수백 개라 이분 탐색
 */
export function lineAt(lines: readonly Line[], sec: number): number {
  'worklet';
  if (!lines.length) return -1;
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1; // startSec <= sec 인 마지막 문장
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid]!.startSec <= sec) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (found < 0) return 0;
  if (sec < lines[found]!.endSec) return found;
  return Math.min(found + 1, lines.length - 1);
}

const clamp01 = (v: number) => {
  'worklet';
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

/**
 * 문장을 얼마나 읽었는지(0~1). 단어 시각이 있으면 다 말한 단어 글자 수 + 지금 단어의 진행분 ÷ 전체 글자 수
 * (화면 글자와 단어 글자를 짝짓지 않고 비율로 옮겨 문장부호 · 숫자 표기가 달라도 깨지지 않는다)
 */
export function filled(line: Line, sec: number): number {
  'worklet';
  if (sec <= line.startSec) return 0;
  if (sec >= line.endSec) return 1;
  const ws = line.words;
  if (!ws.length) return clamp01((sec - line.startSec) / (line.endSec - line.startSec || 1));
  let total = 0;
  let said = 0;
  for (const w of ws) {
    const n = w.text.length;
    total += n;
    if (sec >= w.endSec) said += n;
    else if (sec > w.startSec) said += (n * (sec - w.startSec)) / (w.endSec - w.startSec || 1);
  }
  return total ? clamp01(said / total) : 0;
}
