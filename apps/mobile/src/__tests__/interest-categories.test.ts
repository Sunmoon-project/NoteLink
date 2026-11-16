import { interestLabels, interestSummary } from '../lib/interest-categories';

it('여러 깊이의 분야를 상위 경로와 함께 구분한다', () => {
  const labels = interestLabels([
    { _id: 'parent', name: '코딩', parentId: null },
    { _id: 'child', name: '웹', parentId: 'parent' },
    { _id: 'grandchild', name: '기초', parentId: 'child' },
  ]);
  expect(labels.get('parent')).toBe('코딩');
  expect(labels.get('grandchild')).toBe('코딩 › 웹 › 기초');
});

it('부모 데이터가 없거나 순환해도 무한 반복하지 않는다', () => {
  const labels = interestLabels([
    { _id: 'orphan', name: '기초', parentId: 'missing' },
    { _id: 'a', name: 'A', parentId: 'b' },
    { _id: 'b', name: 'B', parentId: 'a' },
  ]);
  expect(labels.get('orphan')).toBe('기초');
  expect(labels.get('a')).toBe('B › A');
});

it('관심 분야 요약은 사라진 분야를 「사용할 수 없는 분야 N개」 하나로 묶는다', () => {
  const labels = new Map([['a', '어학']]);
  expect(interestSummary(['a', 'x', 'y'], labels)).toBe('어학 · 사용할 수 없는 분야 2개');
  expect(interestSummary(['a'], labels)).toBe('어학');
  expect(interestSummary(['x'], labels)).toBe('사용할 수 없는 분야 1개');
});
