import { mockApi } from './fixtures/api';
import { useNet } from '../stores/net';
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
beforeEach(() => {
  jest.useFakeTimers();
  useNet.setState({ state: 'ok' });
});
afterEach(() => {
  jest.useRealTimers();
  useNet.setState({ state: 'ok' });
});
async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await jest.runAllTimersAsync();
  const outcome = await result;
  if ('error' in outcome) throw outcome.error;
  return outcome.value;
}
it('오프라인 종료는 정산하지 않고 재시도·동시 종료는 한 번만 정산한다', async () => {
  const item = await settle(
    mockApi.study.addItem({ title: '정산 검증', subjectName: '수학', goalMin: null }),
  );
  const beforeSec = item.accumulatedSec;
  const balance = (await settle(mockApi.me.get())).pointBalance;
  const ledger = await settle(mockApi.shop.ledger());
  const session = await settle(
    mockApi.study.startSession({ studyItemId: item._id, mode: 'personal' }),
  );
  jest.advanceTimersByTime(601000);
  useNet.setState({ state: 'offline' });
  await expect(
    settle(mockApi.study.endSession(session._id, { endReason: 'manual', clientDurationSec: 601 })),
  ).rejects.toThrow();
  useNet.setState({ state: 'ok' });
  expect(
    (await settle(mockApi.study.today())).items.find((x) => x._id === item._id)?.accumulatedSec,
  ).toBe(beforeSec);
  expect((await settle(mockApi.me.get())).pointBalance).toBe(balance);
  const both = await settle(
    Promise.all([
      mockApi.study.endSession(session._id, { endReason: 'manual', clientDurationSec: 601 }),
      mockApi.study.endSession(session._id, { endReason: 'manual', clientDurationSec: 601 }),
    ]),
  );
  const again = await settle(
    mockApi.study.endSession(session._id, { endReason: 'manual', clientDurationSec: 601 }),
  );
  expect(both[0]).toEqual(both[1]);
  expect(again).toEqual(both[0]);
  expect(
    (await settle(mockApi.study.today())).items.find((x) => x._id === item._id)?.accumulatedSec,
  ).toBe(beforeSec + again.durationSec);
  expect((await settle(mockApi.me.get())).pointBalance).toBe(balance + 30);
  expect(await settle(mockApi.shop.ledger())).toHaveLength(ledger.length + 1);
});
it('퀴즈 완료의 실패·동시 요청·재진입은 포인트를 중복 지급하지 않는다', async () => {
  const attempt = await settle(mockApi.quiz.startAttempt('test-set'));
  const balance = (await settle(mockApi.me.get())).pointBalance;
  const ledger = await settle(mockApi.shop.ledger());
  useNet.setState({ state: 'offline' });
  await expect(settle(mockApi.quiz.finish(attempt._id))).rejects.toThrow();
  useNet.setState({ state: 'ok' });
  expect((await settle(mockApi.me.get())).pointBalance).toBe(balance);
  const done = await settle(
    Promise.all([mockApi.quiz.finish(attempt._id), mockApi.quiz.finish(attempt._id)]),
  );
  expect(done[0]).toEqual(done[1]);
  expect(await settle(mockApi.quiz.finish(attempt._id))).toEqual(done[0]);
  expect((await settle(mockApi.me.get())).pointBalance).toBe(balance + 120);
  expect(await settle(mockApi.shop.ledger())).toHaveLength(ledger.length + 1);
});
it('오프라인 플래시카드 저장은 데이터를 변경하지 않는다', async () => {
  const before = await settle(mockApi.quiz.flashcards());
  const payload = { front: '중복 방지', back: 'offline' };
  useNet.setState({ state: 'offline' });
  await expect(settle(mockApi.quiz.saveFlashcard(payload))).rejects.toThrow();
  useNet.setState({ state: 'ok' });
  expect(await settle(mockApi.quiz.flashcards())).toEqual(before);
  await settle(mockApi.quiz.saveFlashcard(payload));
  expect(await settle(mockApi.quiz.flashcards())).toHaveLength(before.length + 1);
});
