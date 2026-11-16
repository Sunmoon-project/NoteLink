import { ERROR_CODES } from '@notelink/shared';
import { request } from '../lib/api/http';
import { UploadError, uploadToBlob } from '../lib/upload';
import { useAuth } from '../stores/auth';
import { useSession } from '../stores/session';

const mockApi = {
  study: {
    startSession: jest.fn(),
    endSession: jest.fn(async () => ({ durationSec: 0, pointsEarned: 0 })),
  },
  upload: {
    getSas: jest.fn(async () => ({
      uploadUrl: 'https://blob/sas',
      blobUrl: 'https://blob/a',
      headers: {},
    })),
  },
};
const mockUpload = jest.fn();
const mockStore = new Map<string, string>();
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/env', () => ({ env: { apiUrl: 'http://api', localData: false } }));
jest.mock('expo-file-system', () => ({
  UploadType: { BINARY_CONTENT: 0 },
  File: jest.fn().mockImplementation(() => ({
    size: 10,
    createUploadTask: () => ({ uploadAsync: mockUpload }),
  })),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

const res = (status: number, body: unknown) =>
  ({ ok: status < 400, status, json: async () => body }) as Response;
const tick = () => new Promise((r) => setTimeout(r, 0));
const A = { accessToken: 'a', refreshToken: 'a-r' };
const B = { accessToken: 'b', refreshToken: 'b-r' };

// PR #31 리뷰: 늦게 온 응답이 다른 계정 · 다른 측정에 섞이지 않게
describe('http: 요청을 보낸 계정 기준으로만 갱신 · 재전송', () => {
  beforeEach(() => useAuth.setState({ tokens: A, userId: 'u-a', expired: false }));

  it('A 요청의 401이 B로 바뀐 뒤 오면 B 토큰으로 다시 보내지 않는다', async () => {
    let answer!: (r: Response) => void;
    const calls: string[] = [];
    globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${url} ${(init?.headers as Record<string, string>)?.Authorization ?? ''}`);
      if (url.endsWith('/purchases')) return new Promise<Response>((r) => (answer = r));
      return res(200, { data: { accessToken: 'b2', refreshToken: 'b-r2' } });
    }) as unknown as typeof fetch;
    const p = request('POST', '/purchases', {}).catch((e) => e);
    await tick();
    useAuth.setState({ tokens: B, userId: 'u-b' });
    answer(res(401, { code: ERROR_CODES.TOKEN_EXPIRED, message: '만료' }));
    expect(await p).toMatchObject({ code: ERROR_CODES.TOKEN_EXPIRED });
    expect(calls).toEqual(['http://api/purchases Bearer a']);
    expect(useAuth.getState()).toMatchObject({ tokens: B, expired: false });
  });

  it('같은 계정이면 갱신한 토큰으로 한 번 다시 보낸다', async () => {
    let n = 0;
    globalThis.fetch = jest.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh'))
        return res(200, { data: { accessToken: 'a2', refreshToken: 'a-r2' } });
      return ++n === 1
        ? res(401, { code: ERROR_CODES.TOKEN_EXPIRED, message: '만료' })
        : res(200, { data: 'ok' });
    }) as unknown as typeof fetch;
    expect(await request('GET', '/users/me')).toBe('ok');
    expect(useAuth.getState().tokens?.accessToken).toBe('a2');
  });
});

describe('upload: Blob 응답 확인', () => {
  it('Blob이 403을 주면 성공 주소를 돌려주지 않는다', async () => {
    mockUpload.mockResolvedValueOnce({ status: 403, body: 'AuthenticationFailed' });
    await expect(
      uploadToBlob('image', { uri: 'f', name: 'a.jpg', size: 10 }),
    ).rejects.toBeInstanceOf(UploadError);
  });
  it('올릴 수 없는 형식은 SAS를 받기 전에 막는다', async () => {
    mockApi.upload.getSas.mockClear();
    await expect(
      uploadToBlob('image', { uri: 'f', name: 'a.exe', size: 10 }),
    ).rejects.toBeInstanceOf(UploadError);
    expect(mockApi.upload.getSas).not.toHaveBeenCalled();
  });
  it('2xx면 blobUrl을 돌려준다', async () => {
    mockUpload.mockResolvedValueOnce({ status: 201, body: '' });
    await expect(uploadToBlob('image', { uri: 'f', name: 'a.jpg', size: 10 })).resolves.toBe(
      'https://blob/a',
    );
  });
});

describe('session: 늦게 온 시작 응답', () => {
  beforeEach(() => {
    useSession.getState().reset();
    mockApi.study.endSession.mockClear();
  });
  const pending = () => {
    let done!: (v: { _id: string }) => void;
    mockApi.study.startSession.mockReturnValueOnce(new Promise((r) => (done = r)));
    return (id: string) => done({ _id: id });
  };

  it('로그아웃 · 계정 전환 뒤 온 응답은 버린다', async () => {
    const answer = pending();
    const p = useSession.getState().start('i1');
    useSession.getState().reset();
    answer('s-old');
    await p;
    expect(useSession.getState()).toMatchObject({ itemId: null, sessionId: null });
    expect(mockApi.study.endSession).not.toHaveBeenCalled();
  });

  it('기다리는 사이 종료했으면 서버에 남은 세션을 닫는다', async () => {
    const answer = pending();
    const p = useSession.getState().start('i1');
    await useSession.getState().end('manual');
    answer('s-orphan');
    await p;
    expect(useSession.getState().sessionId).toBeNull();
    expect(mockApi.study.endSession).toHaveBeenCalledWith(
      's-orphan',
      expect.objectContaining({ endReason: 'cancelled' }),
    );
  });

  it('서버가 세션을 못 만들면 기기 타이머를 되돌린다', async () => {
    mockApi.study.startSession.mockRejectedValueOnce(new Error('network'));
    await expect(useSession.getState().start('i1')).rejects.toThrow();
    expect(useSession.getState()).toMatchObject({ itemId: null, since: null });
  });
});

describe('auth: 깨진 저장 값', () => {
  it('JSON이 깨졌으면 로그아웃 상태로 시작한다', async () => {
    mockStore.set('notelink.auth', '{broken');
    await useAuth.getState().load();
    expect(useAuth.getState()).toMatchObject({ ready: true, tokens: null });
    expect(mockStore.has('notelink.auth')).toBe(false);
  });
});
