import { expect, it } from 'vitest';
import { diagramOf } from './diagram.js';
import { Diagram } from './schemas.js';

it('맞는 도식은 핵심어를 다듬어 그대로', () => {
  const d = diagramOf({ kind: 'sequence', terms: [' 수집 ', '정제'], relations: [[0, 1]] });
  expect(d).toEqual({ kind: 'sequence', terms: ['수집', '정제'], relations: [[0, 1]] });
  expect(Diagram.safeParse(d).success).toBe(true);
});

it('모르는 kind · 핵심어 부족 · 빈 핵심어 · 객체 아님은 null', () => {
  expect(diagramOf({ kind: 'venn', terms: ['a', 'b'], relations: [] })).toBeNull();
  expect(diagramOf({ kind: 'list', terms: ['a'], relations: [] })).toBeNull();
  expect(diagramOf({ kind: 'list', terms: [], relations: [] })).toBeNull();
  expect(diagramOf({ kind: 'list', terms: ['a', ' '], relations: [] })).toBeNull();
  expect(diagramOf({ kind: 'list', terms: ['a', 3], relations: [] })).toBeNull();
  expect(diagramOf(null)).toBeNull();
  expect(diagramOf('list')).toBeNull();
});

it('잘못된 관계만 뺀다(범위 밖 · 소수 · 자기 자신 · 중복 · 모양 틀림), relations 없으면 빈 목록', () => {
  const d = diagramOf({
    kind: 'cause',
    terms: ['a', 'b', 'c'],
    relations: [[0, 2], [0, 3], [-1, 1], [1.5, 2], [1, 1], [0, 2], [0], 'x', [1, 2]],
  });
  expect(d?.relations).toEqual([
    [0, 2],
    [1, 2],
  ]);
  expect(diagramOf({ kind: 'list', terms: ['a', 'b'] })?.relations).toEqual([]);
});
