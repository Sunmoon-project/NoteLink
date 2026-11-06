import { mockApi as api } from './fixtures/api';
import { useMockFlags } from './fixtures/flags';
import { useNet } from '../stores/net';
import type { AiJob } from '@notelink/shared';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
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
beforeEach(() => {
  jest.useFakeTimers();
  useNet.setState({ state: 'ok' });
  useMockFlags.getState().reset();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  useMockFlags.getState().reset();
});
async function retry(job: AiJob) {
  expect(await settle(api.ai.job(job._id))).toMatchObject({ status: 'failed' });
  const retried = await settle(api.ai.retry(job._id));
  expect(retried._id).not.toBe(job._id);
  expect(await settle(api.ai.job(retried._id))).toMatchObject({
    status: 'succeeded',
    progress: 100,
  });
  return retried;
}
it('실패한 프로필 생성을 재시도하면 프로필 사진과 결과를 함께 갱신한다', async () => {
  const before = (await settle(api.me.get())).avatarUrl;
  useMockFlags.setState({ llmFail: true });
  const job = await settle(
    api.me.generateProfile({
      photoBlobUrl: 'https://example.test/retried-profile.png',
      prompt: '',
      style: null,
    }),
  );
  expect((await settle(api.me.get())).avatarUrl).toBe(before);
  const retried = await retry(job);
  const completed = await settle(api.ai.job(retried._id));
  expect(completed.result).toEqual({ avatarUrl: 'https://example.test/retried-profile.png' });
  expect((await settle(api.me.get())).avatarUrl).toBe('https://example.test/retried-profile.png');
});
it('실패한 퀴즈 생성을 재시도하면 같은 세트가 ready로 바뀐다', async () => {
  useMockFlags.setState({ llmFail: true });
  const created = await settle(api.quiz.createSet('retry-material'));
  await retry(created.job);
  expect(await settle(api.quiz.set(created.quizSet._id))).toMatchObject({
    status: 'ready',
    progress: 100,
  });
});
it('실패한 자료 생성을 재시도하면 같은 자료의 처리가 완료된다', async () => {
  useMockFlags.setState({ llmFail: true });
  const created = await settle(
    api.content.createMaterial({
      folderId: 'fo1',
      kind: 'handwriting',
      source: 'camera',
      title: '재시도 자료',
      blobUrls: [],
    }),
  );
  await retry(created.job);
  expect(await settle(api.content.material(created.material._id))).toMatchObject({
    processing: { status: 'done', progress: 100 },
  });
});
it('존재하지 않는 작업 재시도는 NOT_FOUND를 반환한다', async () => {
  await expect(settle(api.ai.retry('missing-retry-job'))).rejects.toMatchObject({
    code: 'NOT_FOUND',
  });
});
