// 녹음 재생 아바타 립싱크(FR-20): 단어 시각 + 한글 모음(중성)으로 입 모양을 정한다.
// Avatar3D 그리기 반복(30fps)이 프레임마다 동기로 부른다

import { lineAt, type Line } from '@/features/content/captions';

/** 입 열림(0 = 다묾, 1 = 크게) · 너비(1 = 기본) */
export type Lips = { open: number; wide: number };

export const CLOSED: Lips = { open: 0, wide: 1 };
const A: Lips = { open: 1, wide: 1.1 }; // ㅏ ㅑ ㅐ ㅒ ㅘ ㅙ
const E: Lips = { open: 0.7, wide: 1 }; // ㅓ ㅕ ㅔ ㅖ ㅝ ㅞ
const O: Lips = { open: 0.55, wide: 0.6 }; // ㅗ ㅛ ㅜ ㅠ ㅚ ㅟ
const I: Lips = { open: 0.25, wide: 1.25 }; // ㅡ ㅢ ㅣ
const OTHER: Lips = { open: 0.6, wide: 1 }; // 영문 · 숫자
/** 중성 번호(ㅏ=0 … ㅣ=20) → 입 모양 */
const VOWEL = [A, A, A, A, E, E, E, E, O, A, A, O, O, O, E, E, O, O, I, I, I];
/** 입술을 닫는 받침 ㅁ ㅂ ㅍ */
const LIP_CLOSE = new Set([16, 17, 26]);

/** 음절 하나의 입 모양. phase는 그 음절 안 진행(0~1) — 받침 ㅁㅂㅍ은 마지막 30%에 입을 다문다 */
export function shapeOf(syllable: string, phase: number): Lips {
  const code = syllable.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return OTHER;
  if (phase >= 0.7 && LIP_CLOSE.has(code % 28)) return CLOSED;
  return VOWEL[Math.floor((code % 588) / 28)]!;
}

const SPOKEN = /[\p{L}\p{N}]/u;

/** 지금(sec) 입 모양. 단어를 그 단어의 음절 수로 고르게 나눈다. 단어 시각이 없으면 문장을 한 단어로 */
export function lipsAt(lines: readonly Line[], sec: number): Lips {
  const line = lines[lineAt(lines, sec)];
  if (!line || sec < line.startSec || sec >= line.endSec) return CLOSED;
  const words = line.words.length ? line.words : [line];
  const w = words.find((x) => sec >= x.startSec && sec < x.endSec);
  if (!w) return CLOSED; // 단어 사이 쉼
  const syl = [...w.text].filter((c) => SPOKEN.test(c));
  if (!syl.length) return CLOSED;
  const at = ((sec - w.startSec) / (w.endSec - w.startSec)) * syl.length;
  const k = Math.min(Math.floor(at), syl.length - 1);
  return shapeOf(syl[k]!, at - k);
}
