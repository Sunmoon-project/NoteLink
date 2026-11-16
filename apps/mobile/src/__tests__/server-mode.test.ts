import { PATHS } from '@notelink/shared';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const USER = { _id: 'u1', email: 'a@test.com', nickname: '한결' };
const fetchMock = jest.fn();

function load(localFlag?: string) {
  if (localFlag === undefined) delete process.env.EXPO_PUBLIC_USE_LOCAL_DATA;
  else process.env.EXPO_PUBLIC_USE_LOCAL_DATA = localFlag;
  process.env.EXPO_PUBLIC_API_URL = 'https://api.test/api/v1';
  let mod!: typeof import('../lib/api');
  jest.isolateModules(() => {
    mod = jest.requireActual<typeof import('../lib/api')>('../lib/api');
  });
  return mod;
}

const respond = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(body),
  json: async () => body,
});

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as never;
});
afterAll(() => {
  process.env.EXPO_PUBLIC_USE_LOCAL_DATA = 'true';
});

it('설정이 없으면 기기 저장이 아니라 메인 API로 요청한다', async () => {
  fetchMock.mockResolvedValue(
    respond(200, { data: { accessToken: 'a', refreshToken: 'r', user: USER } }),
  );
  const { api } = load();
  const r = await api.auth.emailLogin('a@test.com', '12345678');
  expect(r.accessToken).toBe('a');
  const [url, init] = fetchMock.mock.calls[0]!;
  expect(url).toBe(`https://api.test/api/v1${PATHS.emailLogin}`);
  expect(init.method).toBe('POST');
  expect(JSON.parse(init.body)).toEqual({ email: 'a@test.com', password: '12345678' });
});

it('가입도 공용 계약의 주소로 보내고, 서버 오류는 code · message로 받는다', async () => {
  fetchMock.mockResolvedValue(
    respond(409, { code: 'EMAIL_TAKEN', message: '이미 가입한 이메일이에요' }),
  );
  const { api, ApiError } = load();
  const failure = await api.auth.emailSignup('proof-1', '12345678').catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ code: 'EMAIL_TAKEN', status: 409 });
  expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.test/api/v1${PATHS.emailSignup}`);
});

// 서버 가입은 세 단계(apps/api app-login.controller): 이메일 · 인증번호 · 증표 + 비밀번호를 각 주소로 보낸다
it('가입은 인증번호 보내기 → 확인(증표 받기) → 증표와 비밀번호로 가입 순서로 서버 계약대로 보낸다', async () => {
  fetchMock
    .mockResolvedValueOnce(respond(204, {}))
    .mockResolvedValueOnce(
      respond(200, { data: { verificationToken: 'proof-1', expiresInSeconds: 600 } }),
    )
    .mockResolvedValueOnce(respond(204, {}));
  const { api } = load();
  await api.auth.emailSendCode('a@test.com');
  const proof = await api.auth.emailVerifyCode('a@test.com', '123456');
  await api.auth.emailSignup(proof.verificationToken, 'abcd1234');
  const sent = fetchMock.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]);
  const base = 'https://api.test/api/v1';
  expect(sent).toEqual([
    [`${base}${PATHS.emailSendCode}`, { email: 'a@test.com' }],
    [`${base}${PATHS.emailVerifyCode}`, { email: 'a@test.com', code: '123456' }],
    // 서버는 이메일을 받지 않고 증표 안의 값만 쓴다
    [`${base}${PATHS.emailSignup}`, { verificationToken: 'proof-1', password: 'abcd1234' }],
  ]);
});

it('EXPO_PUBLIC_USE_LOCAL_DATA=true일 때만 서버를 부르지 않는다', async () => {
  const { api } = load('true');
  await api.auth.emailLogin('none@test.com', '12345678').catch(() => {});
  expect(fetchMock).not.toHaveBeenCalled();
});
