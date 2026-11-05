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
  const failure = await api.auth.emailSignup('a@test.com', '12345678').catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(ApiError);
  expect(failure).toMatchObject({ code: 'EMAIL_TAKEN', status: 409 });
  expect(fetchMock.mock.calls[0]![0]).toBe(`https://api.test/api/v1${PATHS.emailSignup}`);
});

it('EXPO_PUBLIC_USE_LOCAL_DATA=true일 때만 서버를 부르지 않는다', async () => {
  const { api } = load('true');
  await api.auth.emailLogin('none@test.com', '12345678').catch(() => {});
  expect(fetchMock).not.toHaveBeenCalled();
});
