import { useAuth } from '../stores/auth';

// 실제 기기 저장 계층을 메모리 파일로 돌린다 (앱을 다시 켜도 남는지까지 확인)
const mockFiles = new Map<string, string>();
jest.mock('../lib/local/storage', () => ({
  readDb: (n: string) => (mockFiles.has(n) ? JSON.parse(mockFiles.get(n)!) : null),
  writeDb: (n: string, d: unknown) => void mockFiles.set(n, JSON.stringify(d)),
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

async function signup(email: string) {
  const r = await api.auth.emailSignup(email, 'pw12345678');
  useAuth.setState({ userId: r.user._id });
  return r.user;
}
async function login(email: string) {
  const r = await api.auth.emailLogin(email, 'pw12345678');
  useAuth.setState({ userId: r.user._id });
  return r.user;
}

beforeEach(() => {
  mockFiles.clear();
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
  await new Promise((r) => setTimeout(r, 900));
  await signup('b@test.com');
  expect((await api.study.today()).items).toEqual([]);
  // 앱을 다시 켠 것처럼 메모리를 비워도 파일에서 다시 읽는다
  resetLocalForTests();
  await login('a@test.com');
  expect((await api.study.today()).items.map((i) => i.title)).toEqual(['수학']);
});

it('가입한 적 없거나 비밀번호가 다르면 로그인할 수 없고, 같은 이메일로 다시 가입할 수 없다', async () => {
  await expect(api.auth.emailLogin('none@test.com', 'pw12345678')).rejects.toThrow(/맞지 않아요/);
  await signup('a@test.com');
  await expect(api.auth.emailLogin('a@test.com', 'wrong-password')).rejects.toThrow(/맞지 않아요/);
  await expect(api.auth.emailSignup('A@test.com ', 'pw12345678')).rejects.toThrow(/이미 가입/);
  await expect(login('a@test.com')).resolves.toBeTruthy();
});
