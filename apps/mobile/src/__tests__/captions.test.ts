// 녹음 자막: 문장 나누기 · 지금 문장 · 채움 비율 · 재생 위치 이어 붙이기(순수 함수)
import { filled, lineAt, splitLines } from '../features/content/captions';
import { extrapolate } from '../features/content/clock';

const words = [
  { text: '안녕하세요.', startSec: 0, endSec: 1.2 },
  { text: '설명을', startSec: 1.6, endSec: 2.4 },
  { text: '시작하겠습니다.', startSec: 2.4, endSec: 4 },
];
const text = '안녕하세요. 설명을 시작하겠습니다.';

describe('splitLines', () => {
  it('여러 문장을 묶은 구간을 문장 끝에서 자르고, 경계 시각은 그 자리의 단어 시각으로', () => {
    const lines = splitLines([{ text, startSec: 0, endSec: 4, words }]);
    expect(lines.map((l) => l.text)).toEqual(['안녕하세요.', '설명을 시작하겠습니다.']);
    expect(lines[0]!.endSec).toBe(1.2);
    expect(lines[1]!.startSec).toBe(1.6);
    expect(lines[1]!.words).toHaveLength(2);
  });
  it('단어 시각이 없으면 글자 수 비례로 자른다', () => {
    const lines = splitLines([{ text, startSec: 0, endSec: 4 }]);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.startSec).toBeCloseTo((4 * 7) / 19, 2);
    expect(lines[1]!.words).toEqual([]);
  });
  it('소수점(1.5배)은 문장 끝이 아니다', () => {
    expect(splitLines([{ text: '1.5배 빠르게', startSec: 0, endSec: 2 }])).toHaveLength(1);
  });
});

describe('lineAt', () => {
  const lines = splitLines([
    { startSec: 0, endSec: 2, text: '처음 짧은 구간' },
    { startSec: 3, endSec: 5, text: '두 번째 짧은 구간' },
    { startSec: 40, endSec: 50, text: '현재 긴 구간' },
  ]);
  it.each([
    [42, 2],
    [20, 2], // 문장 사이 빈 구간은 다음 문장
    [60, 2], // 끝 뒤는 마지막
    [1, 0],
    [3, 1],
  ])('%s초 → %s번 문장', (sec, i) => expect(lineAt(lines, sec)).toBe(i));
  it('문장이 없으면 -1', () => expect(lineAt([], 3)).toBe(-1));
});

describe('filled', () => {
  const [line] = splitLines([
    {
      text: '가나 다라마바',
      startSec: 0,
      endSec: 2,
      words: [
        { text: '가나', startSec: 0, endSec: 1 },
        { text: '다라마바', startSec: 1, endSec: 2 },
      ],
    },
  ]);
  it.each([
    [-1, 0],
    [0.5, 1 / 6],
    [1.5, 4 / 6],
    [3, 1],
  ])('단어 시각으로 %s초 → %s', (sec, v) => expect(filled(line!, sec)).toBeCloseTo(v, 3));
  it('단어 시각이 없으면 문장 길이 비례', () => {
    const [plain] = splitLines([{ text: '가나다', startSec: 2, endSec: 6 }]);
    expect(filled(plain!, 3)).toBeCloseTo(0.25, 3);
    expect(filled(plain!, 9)).toBe(1);
  });
});

describe('extrapolate', () => {
  it('재생 중이면 경과 시간 × 배속만큼 앞으로', () =>
    expect(extrapolate({ pos: 10, at: 0, rate: 2, playing: true }, 500)).toBe(11));
  it('멈춰 있으면 그 자리', () =>
    expect(extrapolate({ pos: 10, at: 0, rate: 2, playing: false }, 500)).toBe(10));
  it('시계가 거꾸로 가면 그 자리', () =>
    expect(extrapolate({ pos: 10, at: 1000, rate: 1, playing: true }, 500)).toBe(10));
  it('상태가 1초 넘게 안 오면(끊김) 더 달리지 않는다', () =>
    expect(extrapolate({ pos: 10, at: 0, rate: 1, playing: true }, 5000)).toBe(11));
});
