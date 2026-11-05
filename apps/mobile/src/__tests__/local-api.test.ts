import { useAuth } from '../stores/auth';

// 실제 기기 저장 계층을 메모리 파일로 돌린다 (앱을 다시 켜도 남는지까지 확인)
const mockFiles = new Map<string, string>();
let mockWriteFails = false;
jest.mock('../lib/local/storage', () => ({
  readDb: (n: string) => (mockFiles.has(n) ? JSON.parse(mockFiles.get(n)!) : null),
  writeDb: (n: string, d: unknown) => {
    if (mockWriteFails) throw new Error('disk full');
    mockFiles.set(n, JSON.stringify(d));
  },
  dropDb: (n: string) => void mockFiles.delete(n),
  dropFile: jest.fn(),
  fileInfo: () => ({ name: 'a.pdf', size: 10 }),
  keepFile: (uri: string) => ({ uri, size: 10 }),
}));
const mockKeychain = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockKeychain.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockKeychain.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockKeychain.delete(k)),
}));
const { localApi: api, resetLocalForTests } =
  jest.requireActual<typeof import('../lib/local/api')>('../lib/local/api');

async function login(email: string) {
  const r = await api.auth.emailLogin(email, 'pw12345678');
  useAuth.setState({ userId: r.user._id });
  return r.user;
}
const signup = login;

beforeEach(() => {
  mockFiles.clear();
  mockWriteFails = false;
  mockKeychain.clear();
  resetLocalForTests();
});

it('새 계정은 시드 없이 빈 상태로 시작한다', async () => {
  await signup('a@test.com');
  expect(await api.content.folders()).toEqual(expect.any(Array));
  expect((await api.study.today()).items).toEqual([]);
  expect(await api.quiz.sets()).toEqual([]);
});

it('계정끼리 데이터가 섞이지 않고 다시 켜도 남는다', async () => {
  await signup('a@test.com');
  await api.study.addItem({ title: '수학', subjectName: '수학', goalMin: null });
  await signup('b@test.com');
  expect((await api.study.today()).items).toEqual([]);
  // 앱을 다시 켠 것처럼 메모리를 비워도 파일에서 다시 읽는다
  resetLocalForTests();
  await login('a@test.com');
  expect((await api.study.today()).items.map((i) => i.title)).toEqual(['수학']);
});

it('처음 쓰는 이메일은 계정이 만들어지고, 다음부터는 그 비밀번호가 맞아야 한다', async () => {
  await signup('a@test.com');
  await expect(api.auth.emailLogin('a@test.com', 'wrong-password')).rejects.toThrow(/맞지 않아요/);
  await expect(login('A@test.com ')).resolves.toBeTruthy();
});

it('성공 응답을 받은 변경은 곧바로 앱을 다시 켜도 남는다', async () => {
  await signup('a@test.com');
  await api.study.addItem({ title: '수학', subjectName: '수학', goalMin: null });
  resetLocalForTests();
  await login('a@test.com');
  expect((await api.study.today()).items.map((i) => i.title)).toEqual(['수학']);
});

it('파일에 쓰지 못하면 실패로 알리고, 그 변경을 남기지 않는다', async () => {
  await signup('a@test.com');
  mockWriteFails = true;
  await expect(
    api.study.addItem({ title: '수학', subjectName: '수학', goalMin: null }),
  ).rejects.toThrow('저장하지 못했어요');
  mockWriteFails = false;
  expect((await api.study.today()).items).toEqual([]);
});

it('키체인 저장이 실패하면 계정을 남기지 않아 같은 이메일로 다시 시도할 수 있다', async () => {
  const SecureStore = jest.requireMock<typeof import('expo-secure-store')>('expo-secure-store');
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain'));
  await expect(login('a@test.com')).rejects.toThrow('저장하지 못했어요');
  await expect(signup('a@test.com')).resolves.toBeTruthy();
});

it('DB 저장이 실패해도 계정과 비밀번호를 남기지 않는다', async () => {
  mockWriteFails = true;
  await expect(login('a@test.com')).rejects.toThrow('저장하지 못했어요');
  mockWriteFails = false;
  expect(mockKeychain.size).toBe(0);
  await expect(signup('a@test.com')).resolves.toBeTruthy();
});

describe('자정을 넘긴 세션', () => {
  afterEach(() => jest.useRealTimers());
  const fake = (iso: string) =>
    jest.useFakeTimers({
      now: Date.parse(iso),
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'setTimeout', 'clearTimeout'],
    });

  it('서울 23:59 시작 → 00:01 종료면 각 날짜에 60초씩 쌓인다', async () => {
    fake('2026-11-04T23:59:00+09:00');
    await signup('a@test.com');
    const item = await api.study.addItem({ title: '수학', subjectName: '수학', goalMin: null });
    const s = await api.study.startSession({ studyItemId: item._id, mode: 'personal' });
    jest.setSystemTime(Date.parse('2026-11-05T00:01:00+09:00'));
    const r = await api.study.endSession(s._id, { clientDurationSec: 120, endReason: 'manual' });
    expect(r.durationSec).toBe(120);
    const today = await api.study.today();
    expect(today.totalSec).toBe(60);
    expect(today.items[0]!.accumulatedSec).toBe(60);
    jest.setSystemTime(Date.parse('2026-11-04T12:00:00+09:00'));
    expect((await api.study.today()).totalSec).toBe(60);
  });

  it('쉬는 시간은 어느 날짜에도 더하지 않는다', async () => {
    fake('2026-11-04T23:59:00+09:00');
    await signup('a@test.com');
    const item = await api.study.addItem({ title: '수학', subjectName: '수학', goalMin: null });
    const s = await api.study.startSession({ studyItemId: item._id, mode: 'personal' });
    jest.setSystemTime(Date.parse('2026-11-04T23:59:30+09:00'));
    await api.study.pauseSession(s._id);
    jest.setSystemTime(Date.parse('2026-11-05T00:00:30+09:00'));
    await api.study.resumeSession(s._id);
    jest.setSystemTime(Date.parse('2026-11-05T00:01:00+09:00'));
    const r = await api.study.endSession(s._id, { clientDurationSec: 0, endReason: 'manual' });
    expect(r.durationSec).toBe(60);
    expect((await api.study.today()).totalSec).toBe(30);
  });
});

it('서버 없이는 캘린더 공유 링크를 만들지 않는다', async () => {
  await signup('a@test.com');
  await expect(
    api.calendar.createShare({
      rangeStart: '2026-11-01',
      rangeEnd: '2026-11-30',
      expiresInDays: 7,
    }),
  ).rejects.toThrow('서버 연결 후');
  expect(await api.calendar.shares()).toEqual([]);
});
