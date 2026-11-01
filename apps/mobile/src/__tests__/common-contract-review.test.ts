import { ERROR_CODES } from '@notelink/shared';
import { mockApi } from '../lib/mock/api';
import { useMockFlags } from '../lib/mock/flags';
import { useNet } from '../stores/net';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

async function response<T>(promise: Promise<T>): Promise<T> {
  await jest.advanceTimersByTimeAsync(220);
  return promise;
}
beforeEach(() => {
  jest.useFakeTimers();
  useMockFlags.getState().reset();
  useNet.getState().set('ok');
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('없는 AI 작업 ID는 성공처럼 반환하지 않고 NOT_FOUND 404를 반환한다', async () => {
  await expect(mockApi.ai.job('job-that-has-never-existed-contract-review')).rejects.toMatchObject({
    code: ERROR_CODES.NOT_FOUND,
    status: 404,
  });
});

it('ID 없는 반복 목표를 연속 생성하면 각각 새 ID를 발급하고 기존 항목을 보존한다', async () => {
  const before = await response(mockApi.study.recurringGoals());
  const first = await response(
    mockApi.study.saveRecurringGoal({
      _id: undefined,
      name: '새 반복 목표 A',
      days: [1],
      targetMin: 25,
    }),
  );
  const second = await response(
    mockApi.study.saveRecurringGoal({
      _id: undefined,
      name: '새 반복 목표 B',
      days: [3],
      targetMin: 40,
    }),
  );
  expect(first._id).toEqual(expect.any(String));
  expect(first._id.length).toBeGreaterThan(0);
  expect(second._id).toEqual(expect.any(String));
  expect(second._id).not.toBe(first._id);
  const after = await response(mockApi.study.recurringGoals());
  expect(after).toHaveLength(before.length + 2);
  expect(after.find((goal) => goal._id === first._id)).toMatchObject({
    name: '새 반복 목표 A',
    days: [1],
    targetMin: 25,
  });
  expect(after.find((goal) => goal._id === second._id)).toMatchObject({
    name: '새 반복 목표 B',
    days: [3],
    targetMin: 40,
  });
  expect(after.filter((goal) => goal._id !== first._id && goal._id !== second._id)).toEqual(before);
});

it('기존 ID로 반복 목표를 수정하면 같은 ID를 유지하고 새 목표를 추가하지 않는다', async () => {
  const before = await response(mockApi.study.recurringGoals());
  expect(before[0]).toBeDefined();
  const original = before[0]!;
  const updated = await response(
    mockApi.study.saveRecurringGoal({
      ...original,
      name: '수정한 반복 목표',
      targetMin: original.targetMin + 15,
    }),
  );
  expect(updated._id).toBe(original._id);
  const after = await response(mockApi.study.recurringGoals());
  expect(after).toHaveLength(before.length);
  expect(after.find((goal) => goal._id === original._id)).toMatchObject({
    _id: original._id,
    name: '수정한 반복 목표',
    targetMin: original.targetMin + 15,
  });
  expect(after.filter((goal) => goal._id !== original._id)).toEqual(
    before.filter((goal) => goal._id !== original._id),
  );
});
