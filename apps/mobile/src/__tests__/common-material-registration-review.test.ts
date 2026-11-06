import { mockApi as api } from './fixtures/api';
import { httpApi } from '../lib/api/http-api';
import { PATHS } from '@notelink/shared';
import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
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
  const fetch = jest.fn().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({
      data: { material: { _id: 'header-material' }, job: { _id: 'header-job' } },
    }),
  });
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

it('실서버 등록 응답이 유실되면 같은 키의 동시 요청·재시도는 POST를 다시 보내지 않는다', async () => {
  const original = globalThis.fetch;
  const fetch = jest.fn().mockRejectedValue(new Error('서버 처리 후 응답 유실'));
  globalThis.fetch = fetch;
  const request = { ...input, requestId: 'real-http-lost-reply-key' };
  try {
    const first = await Promise.allSettled([
      httpApi.content.createMaterial(request),
      httpApi.content.createMaterial(request),
    ]);
    expect(first).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'MATERIAL_REGISTRATION_UNCERTAIN' }),
      }),
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'MATERIAL_REGISTRATION_UNCERTAIN' }),
      }),
    ]);
    await expect(httpApi.content.createMaterial(request)).rejects.toMatchObject({
      code: 'MATERIAL_REGISTRATION_UNCERTAIN',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.fetch = original;
    useNet.setState({ state: 'ok' });
  }
});

it('실서버가 헤더를 지원하지 않아도 성공한 같은 등록 키는 한 번만 POST한다', async () => {
  const original = globalThis.fetch;
  const fetch = jest.fn().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({
      data: { material: { _id: 'http-material' }, job: { _id: 'http-job' } },
    }),
  });
  globalThis.fetch = fetch;
  const request = { ...input, requestId: 'real-http-success-key' };
  try {
    const [first, second] = await Promise.all([
      httpApi.content.createMaterial(request),
      httpApi.content.createMaterial(request),
    ]);
    const replay = await httpApi.content.createMaterial(request);
    expect(first.material._id).toBe(second.material._id);
    expect(replay.job._id).toBe(first.job._id);
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      httpApi.content.createMaterial({ ...request, title: '바뀐 자료' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.fetch = original;
  }
});

it('명확한 4xx 거부는 같은 키로 수정된 서버에 재요청할 수 있다', async () => {
  const original = globalThis.fetch;
  const fetch = jest
    .fn()
    .mockResolvedValueOnce({
      status: 400,
      ok: false,
      json: async () => ({ code: 'BAD_REQUEST', message: '등록 거부' }),
    })
    .mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({
        data: { material: { _id: 'retry-material' }, job: { _id: 'retry-job' } },
      }),
    });
  globalThis.fetch = fetch;
  const request = { ...input, requestId: 'real-http-definitive-rejection' };
  try {
    await expect(httpApi.content.createMaterial(request)).rejects.toMatchObject({ status: 400 });
    expect((await httpApi.content.createMaterial(request)).material._id).toBe('retry-material');
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    globalThis.fetch = original;
  }
});

it('서로 다른 계정은 같은 요청 키의 응답을 공유하지 않는다', async () => {
  const original = globalThis.fetch;
  const owner = useAuth.getState().userId;
  const fetch = jest
    .fn()
    .mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({
        data: { material: { _id: 'owner-a-material' }, job: { _id: 'owner-a-job' } },
      }),
    })
    .mockResolvedValueOnce({
      status: 200,
      ok: true,
      json: async () => ({
        data: { material: { _id: 'owner-b-material' }, job: { _id: 'owner-b-job' } },
      }),
    });
  globalThis.fetch = fetch;
  const request = { ...input, requestId: 'same-key-different-owner' };
  try {
    useAuth.setState({ userId: 'owner-a' });
    const first = await httpApi.content.createMaterial(request);
    useAuth.setState({ userId: 'owner-b' });
    const second = await httpApi.content.createMaterial(request);
    expect(first.material._id).toBe('owner-a-material');
    expect(second.material._id).toBe('owner-b-material');
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    globalThis.fetch = original;
    useAuth.setState({ userId: owner });
  }
});

it('성공 상태여도 등록 결과가 누락되면 불명확한 응답으로 안내하고 POST를 반복하지 않는다', async () => {
  const original = globalThis.fetch;
  const fetch = jest.fn().mockResolvedValue({ status: 204, ok: true });
  globalThis.fetch = fetch;
  const request = { ...input, requestId: 'real-http-missing-result' };
  try {
    await expect(httpApi.content.createMaterial(request)).rejects.toMatchObject({
      code: 'MATERIAL_REGISTRATION_UNCERTAIN',
    });
    await expect(httpApi.content.createMaterial(request)).rejects.toMatchObject({
      code: 'MATERIAL_REGISTRATION_UNCERTAIN',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    globalThis.fetch = original;
  }
});
