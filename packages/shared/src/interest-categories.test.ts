import { expect, it } from 'vitest';
import { INTEREST_CATEGORY_GROUPS } from './interest-categories.js';

it('공용 관심 분야 이름은 큰 분야 · 세부 분야를 통틀어 모두 다르다(스터디룸이 이름으로 찾음)', () => {
  const names = INTEREST_CATEGORY_GROUPS.flatMap((g) => [g.name, ...g.children]);
  expect(new Set(names).size).toBe(names.length);
});

it('앞의 여섯 큰 분야는 예전 목록과 같은 순서다(기기 저장 모드 id가 순서로 정해짐)', () => {
  expect(INTEREST_CATEGORY_GROUPS.slice(0, 6).map((g) => g.name)).toEqual([
    '자격증',
    '수능',
    '어학',
    '전공',
    '코딩',
    '공무원',
  ]);
});
