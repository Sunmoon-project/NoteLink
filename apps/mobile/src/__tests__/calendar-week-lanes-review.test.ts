import { laneBlocks } from '../features/progress/record';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

it('같은 시간의 수업과 스터디룸은 다른 칸에 놓고, 겹치지 않으면 같은 칸을 쓴다', () => {
  const lanes = (blocks: { top: number; h: number }[]) =>
    laneBlocks(blocks).map((b) => [b.lane, b.lanes]);
  expect(
    lanes([
      { top: 0, h: 1 },
      { top: 0, h: 1 },
    ]),
  ).toEqual([
    [0, 2],
    [1, 2],
  ]);
  expect(
    lanes([
      { top: 0, h: 1 },
      { top: 1, h: 1 },
    ]),
  ).toEqual([
    [0, 1],
    [0, 1],
  ]);
});
