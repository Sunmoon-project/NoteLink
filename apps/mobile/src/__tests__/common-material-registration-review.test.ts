import { mockApi as api } from '../lib/mock/api';
import { httpApi } from '../lib/api/http-api';
import { PATHS } from '@notelink/shared';
import { useNet } from '../stores/net';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
const input = {
  folderId: 'fo1',
  kind: 'handwriting' as const,
  source: 'camera' as const,
  title: '중복 등록 검증',
  blobUrls: ['https://blob.example/unique-registration.jpg'],
  description: '',
};
beforeEach(() => {
  jest.useFakeTimers();
  useNet.setState({ state: 'ok' });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
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
it('동시 등록·응답 유실 뒤 재등록도 같은 자료와 AI 작업을 재사용한다', async () => {
  const requestId = 'registration-concurrent-replay';
  const both = await settle(
    Promise.all([
      api.content.createMaterial({ ...input, requestId }),
      api.content.createMaterial({ ...input, requestId }),
    ]),
  );
  const replay = await settle(api.content.createMaterial({ ...input, requestId }));
  expect(both[0].material._id).toBe(both[1].material._id);
  expect(replay.material._id).toBe(both[0].material._id);
  expect(replay.job._id).toBe(both[0].job._id);
  await settle(api.content.saveMaterial(replay.material._id));
  const materials = await settle(api.content.materials(input.folderId));
  expect(materials.filter((m) => m._id === replay.material._id)).toHaveLength(1);
});
it('같은 등록 키에 다른 내용이 오면 재사용하거나 중복 생성하지 않고 거부한다', async () => {
  const requestId = 'registration-conflict';
  const first = await settle(api.content.createMaterial({ ...input, requestId }));
  await expect(
    settle(api.content.createMaterial({ ...input, requestId, title: '다른 자료' })),
  ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
  expect((await settle(api.content.material(first.material._id))).title).toBe(input.title);
});
it('실서버 자료 등록에 동일한 Idempotency-Key를 헤더로 전달한다', async () => {
  const original = globalThis.fetch;
  const fetch = jest.fn().mockResolvedValue({ status: 204, ok: true });
  globalThis.fetch = fetch;
  try {
    await httpApi.content.createMaterial({ ...input, requestId: 'header-registration-key' });
    expect(fetch).toHaveBeenCalledWith(
      'http://api' + PATHS.materials,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': 'header-registration-key' }),
        body: JSON.stringify(input),
      }),
    );
  } finally {
    globalThis.fetch = original;
  }
});
