import { interestLabels } from '../lib/interest-categories';

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
