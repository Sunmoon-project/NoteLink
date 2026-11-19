// 녹음 재생 아바타 입 모양: 한글 모음(중성) · 받침 ㅁㅂㅍ → 열림 · 너비
import { splitLines } from '../features/content/captions';
import { lipsAt, shapeOf } from '../features/tutor/lips';

describe('shapeOf', () => {
  it.each([
    ['가', 0.2, { open: 1, wide: 1.1 }],
    ['어', 0.2, { open: 0.7, wide: 1 }],
    ['우', 0.2, { open: 0.55, wide: 0.6 }],
    ['이', 0.2, { open: 0.25, wide: 1.25 }],
    ['밥', 0.2, { open: 1, wide: 1.1 }], // 받침 전은 모음 모양
    ['밥', 0.8, { open: 0, wide: 1 }], // 받침 ㅂ: 입을 다문다
    ['A', 0.2, { open: 0.6, wide: 1 }],
  ])('%s(%s) → %o', (s, phase, lips) => expect(shapeOf(s, phase)).toEqual(lips));
});

describe('lipsAt', () => {
  const lines = splitLines([
    {
      text: '아이 우',
      startSec: 0,
      endSec: 3,
      words: [
        { text: '아이', startSec: 0, endSec: 1 },
        { text: '우', startSec: 2, endSec: 3 },
      ],
    },
  ]);
  it('단어를 음절 수로 나눠 그 음절의 모양', () => {
    expect(lipsAt(lines, 0.25)).toEqual({ open: 1, wide: 1.1 });
    expect(lipsAt(lines, 0.75)).toEqual({ open: 0.25, wide: 1.25 });
    expect(lipsAt(lines, 2.5)).toEqual({ open: 0.55, wide: 0.6 });
  });
  it('단어 사이 쉼 · 문장 밖 · 빈 목록은 입을 다문다', () => {
    expect(lipsAt(lines, 1.5)).toEqual({ open: 0, wide: 1 });
    expect(lipsAt(lines, 9)).toEqual({ open: 0, wide: 1 });
    expect(lipsAt([], 1)).toEqual({ open: 0, wide: 1 });
  });
  it('단어 시각이 없는 옛 녹음은 문장 글자를 고르게 나눠 움직인다', () => {
    const plain = splitLines([{ text: '아 이', startSec: 0, endSec: 2 }]);
    expect(lipsAt(plain, 0.5)).toEqual({ open: 1, wide: 1.1 });
    expect(lipsAt(plain, 1.5)).toEqual({ open: 0.25, wide: 1.25 });
  });
});
