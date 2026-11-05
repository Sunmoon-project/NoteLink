import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';

// 실제 기기 저장 계층을 메모리 파일로 돌린다 (앱을 다시 켜도 남는지까지 확인)
const mockFiles = new Map<string, string>();
let mockWriteFails = false;
const mockDropFile = jest.fn();
jest.mock('../lib/local/storage', () => ({
  readDb: (n: string) => (mockFiles.has(n) ? JSON.parse(mockFiles.get(n)!) : null),
  writeDb: (n: string, d: unknown) => {
    if (mockWriteFails) throw new Error('disk full');
    mockFiles.set(n, JSON.stringify(d));
  },
  dropDb: (n: string) => void mockFiles.delete(n),
  dropFile: (...a: unknown[]) => mockDropFile(...a),
  keptFilesIn: (d: unknown) => [
    ...new Set(JSON.stringify(d).match(/file:\/\/\/doc\/files\/[^"]+/g) ?? []),
  ],
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
async function signup(email: string) {
  await api.auth.emailSignup(email, 'pw12345678');
  return login(email);
}

beforeEach(() => {
  mockFiles.clear();
  mockWriteFails = false;
  mockDropFile.mockClear();
  useNet.setState({ state: 'ok' });
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

it('가입한 적 없거나 비밀번호가 다르면 로그인할 수 없고, 같은 이메일로 다시 가입할 수 없다', async () => {
  await expect(api.auth.emailLogin('none@test.com', 'pw12345678')).rejects.toThrow(/맞지 않아요/);
  await signup('a@test.com');
  await expect(api.auth.emailLogin('a@test.com', 'wrong-password')).rejects.toThrow(/맞지 않아요/);
  await expect(api.auth.emailSignup('A@test.com ', 'pw12345678')).rejects.toThrow(/이미 가입/);
  await expect(login('a@test.com')).resolves.toBeTruthy();
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

it('키체인 저장이 실패하면 계정을 남기지 않아 같은 이메일로 다시 가입할 수 있다', async () => {
  const SecureStore = jest.requireMock<typeof import('expo-secure-store')>('expo-secure-store');
  jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain'));
  await expect(api.auth.emailSignup('a@test.com', 'pw12345678')).rejects.toThrow(
    '저장하지 못했어요',
  );
  await expect(signup('a@test.com')).resolves.toBeTruthy();
});

it('DB 저장이 실패해도 계정과 비밀번호를 남기지 않는다', async () => {
  mockWriteFails = true;
  await expect(api.auth.emailSignup('a@test.com', 'pw12345678')).rejects.toThrow(
    '저장하지 못했어요',
  );
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

const addFolder = () => api.content.createFolder({ title: '수학', subjectName: '수학' } as never);
const material = (folderId: string, requestId = 'r1') => ({
  requestId,
  folderId,
  kind: 'document' as const,
  source: 'file' as const,
  title: '자료',
  blobUrls: ['file:///doc/files/a.pdf'],
});

describe('자료 저장 · 삭제 실패', () => {
  it('저장에 실패한 등록을 같은 키로 재시도하면 실제로 다시 만든다', async () => {
    await signup('a@test.com');
    const f = await addFolder();
    mockWriteFails = true;
    await expect(api.content.createMaterial(material(f._id))).rejects.toThrow('저장하지 못했어요');
    mockWriteFails = false;
    expect(await api.content.materials(f._id)).toEqual([]);
    const { material: created } = await api.content.createMaterial(material(f._id));
    expect((await api.content.materials(f._id)).map((m) => m._id)).toEqual([created._id]);
  });

  it('같은 키로 다시 보내면 자료를 또 만들지 않는다', async () => {
    await signup('a@test.com');
    const f = await addFolder();
    const first = await api.content.createMaterial(material(f._id));
    const again = await api.content.createMaterial(material(f._id));
    expect(again.material._id).toBe(first.material._id);
    expect(await api.content.materials(f._id)).toHaveLength(1);
  });

  it.each(['자료', '폴더'])('%s 삭제 저장이 실패하면 원본 파일을 지우지 않는다', async (what) => {
    await signup('a@test.com');
    const f = await addFolder();
    const { material: m } = await api.content.createMaterial(material(f._id));
    const remove = () =>
      what === '자료' ? api.content.deleteMaterial(m._id) : api.content.deleteFolder(f._id);
    mockWriteFails = true;
    await expect(remove()).rejects.toThrow('저장하지 못했어요');
    mockWriteFails = false;
    expect(mockDropFile).not.toHaveBeenCalled();
    expect(await api.content.materials(f._id)).toHaveLength(1);
    await remove();
    expect(mockDropFile).toHaveBeenCalledTimes(1);
  });
});

it('오프라인으로 실패한 변경은 연결이 돌아와도 남지 않는다', async () => {
  await signup('a@test.com');
  useNet.setState({ state: 'offline' });
  await expect(
    api.study.addItem({ title: '수학', subjectName: '수학', goalMin: null }),
  ).rejects.toThrow('offline');
  useNet.setState({ state: 'ok' });
  expect((await api.study.today()).items).toEqual([]);
});

it('같은 세션을 다시 끝내도 처음 정산을 돌려주고 포인트를 다시 주지 않는다', async () => {
  jest.useFakeTimers({
    now: Date.parse('2026-11-04T10:00:00+09:00'),
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'setTimeout', 'clearTimeout'],
  });
  await signup('a@test.com');
  const item = await api.study.addItem({ title: '수학', subjectName: '수학', goalMin: null });
  const s = await api.study.startSession({ studyItemId: item._id, mode: 'personal' });
  jest.setSystemTime(Date.parse('2026-11-04T11:00:00+09:00'));
  const first = await api.study.endSession(s._id, { clientDurationSec: 0, endReason: 'manual' });
  const balance = (await api.me.get()).pointBalance;
  expect(first.pointsEarned).toBeGreaterThan(0);
  jest.setSystemTime(Date.parse('2026-11-04T12:00:00+09:00'));
  const again = await api.study.endSession(s._id, { clientDurationSec: 0, endReason: 'manual' });
  expect(again).toEqual(first);
  expect((await api.me.get()).pointBalance).toBe(balance);
  expect((await api.study.today()).totalSec).toBe(3600);
  jest.useRealTimers();
});

it('방 타이머를 정하면 끝나는 시각을 계산해 소켓과 방 정보로 준다', async () => {
  await signup('a@test.com');
  const room = await api.rooms.create({ title: '방', categoryName: '수학', isPublic: true });
  const heard: { endsAt: string | null; phase: string }[] = [];
  const { localSocket } = jest.requireActual<typeof import('../lib/socket')>('../lib/socket');
  const push = jest
    .spyOn(localSocket, 'push')
    .mockImplementation((_ev: unknown, payload: unknown) => void heard.push(payload as never));
  await api.rooms.setTimer(room._id, {
    enabled: true,
    type: 'pomodoro',
    focusMin: 25,
    breakMin: 5,
    repeat: 4,
    periods: [],
  });
  push.mockRestore();
  expect(heard[0]?.phase).toBe('focus');
  expect(Date.parse(heard[0]!.endsAt!)).toBeGreaterThan(Date.now());
  expect((await api.rooms.get(room._id)).timerState?.phase).toBe('focus');
});

it('같은 키로 동시에 등록해도 자료는 하나만 만들고, 다른 내용이면 거절한다', async () => {
  await signup('a@test.com');
  const f = await addFolder();
  const [a, b] = await Promise.all([
    api.content.createMaterial(material(f._id)),
    api.content.createMaterial(material(f._id)),
  ]);
  expect(b.material._id).toBe(a.material._id);
  expect(await api.content.materials(f._id)).toHaveLength(1);
  const other = api.content.createMaterial({ ...material(f._id, 'r2'), title: '가' });
  await expect(
    api.content.createMaterial({ ...material(f._id, 'r2'), title: '나' }),
  ).rejects.toThrow('다른 자료');
  await other;
});

it('방 타이머 저장이 실패하면 참여자에게 알리지 않는다', async () => {
  await signup('a@test.com');
  const room = await api.rooms.create({ title: '방', categoryName: '수학', isPublic: true });
  const { localSocket } = jest.requireActual<typeof import('../lib/socket')>('../lib/socket');
  const push = jest.spyOn(localSocket, 'push').mockImplementation(() => {});
  const rule = {
    enabled: true,
    type: 'pomodoro' as const,
    focusMin: 25,
    breakMin: 5,
    repeat: 4,
    periods: [],
  };
  mockWriteFails = true;
  await expect(api.rooms.setTimer(room._id, rule)).rejects.toThrow('저장하지 못했어요');
  mockWriteFails = false;
  useNet.setState({ state: 'offline' });
  await expect(api.rooms.setTimer(room._id, rule)).rejects.toThrow('offline');
  useNet.setState({ state: 'ok' });
  expect(push).not.toHaveBeenCalled();
  await api.rooms.setTimer(room._id, rule);
  expect(push).toHaveBeenCalledTimes(1);
  push.mockRestore();
});

it('탈퇴하면 자료 원본과 프로필 사진을 모두 지운다', async () => {
  await signup('a@test.com');
  const f = await addFolder();
  await api.content.createMaterial(material(f._id));
  await api.me.generateProfile({
    photoBlobUrl: 'file:///doc/files/p.jpg',
    prompt: '사진',
    style: '수채화',
  });
  await api.me.withdraw();
  expect(mockDropFile.mock.calls.map(([u]) => u).sort()).toEqual([
    'file:///doc/files/a.pdf',
    'file:///doc/files/p.jpg',
  ]);
});

it('키체인 삭제가 실패해도 탈퇴를 마치고 파일을 지운다', async () => {
  await signup('a@test.com');
  const f = await addFolder();
  await api.content.createMaterial(material(f._id));
  const SecureStore = jest.requireMock<typeof import('expo-secure-store')>('expo-secure-store');
  jest.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error('keychain'));
  await expect(api.me.withdraw()).resolves.toBeUndefined();
  expect(mockDropFile).toHaveBeenCalledWith('file:///doc/files/a.pdf');
  await expect(api.auth.emailLogin('a@test.com', 'pw12345678')).rejects.toThrow('맞지 않아요');
});

it('프로필 생성 요청이 실패하면 방금 복사한 사진을 지운다', async () => {
  await signup('a@test.com');
  useNet.setState({ state: 'offline' });
  await expect(
    api.me.generateProfile({
      photoBlobUrl: 'file:///doc/files/p.jpg',
      prompt: '',
      style: '수채화',
    }),
  ).rejects.toThrow('offline');
  useNet.setState({ state: 'ok' });
  expect(mockDropFile).toHaveBeenCalledWith('file:///doc/files/p.jpg');
});
