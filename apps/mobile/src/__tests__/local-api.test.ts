import { ERROR_CODES } from '@notelink/shared';
import { useAuth } from '../stores/auth';
import { useNet } from '../stores/net';

// 실제 기기 저장 계층을 메모리 파일로 돌린다 (앱을 다시 켜도 남는지까지 확인)
const mockFiles = new Map<string, string>();
let mockWriteFails = false;
let mockDropDbFails = false;
const mockDropFile = jest.fn();
jest.mock('../lib/local/storage', () => ({
  readDb: (n: string) => (mockFiles.has(n) ? JSON.parse(mockFiles.get(n)!) : null),
  writeDb: (n: string, d: unknown) => {
    if (mockWriteFails) throw new Error('disk full');
    mockFiles.set(n, JSON.stringify(d));
  },
  dropDb: (n: string) => {
    if (mockDropDbFails) throw new Error('delete failed');
    mockFiles.delete(n);
  },
  dropFile: (...a: unknown[]) => mockDropFile(...a),
  rememberOrphans: (owner: string, uris: string[]) => {
    if (mockWriteFails) throw new Error('disk full');
    mockFiles.set('orphans', JSON.stringify(uris.map((uri) => ({ uri, owner }))));
  },
  // 계정 DB가 없어진 항목만 지운다 (실제 동작은 local-storage · local-withdraw 테스트가 본다)
  dropFiles: () => {
    const list: { uri: string; owner: string }[] = JSON.parse(mockFiles.get('orphans') ?? '[]');
    const left = list.filter((o) => mockFiles.has(o.owner));
    for (const o of list) if (!mockFiles.has(o.owner)) mockDropFile(o.uri);
    if (left.length) mockFiles.set('orphans', JSON.stringify(left));
    else mockFiles.delete('orphans');
    return left.map((o) => o.uri);
  },
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
const {
  localApi: api,
  resetLocalForTests,
  seedQuizForTests,
} = jest.requireActual<typeof import('../lib/local/api')>('../lib/local/api');

async function login(email: string) {
  const r = await api.auth.emailLogin(email, 'pw12345678');
  useAuth.setState({ userId: r.user._id });
  return r.user;
}
/** 앱과 같은 세 단계로 가입한다(기기 저장 모드는 인증번호가 6자리 숫자면 통과) */
async function signup(email: string) {
  await api.auth.emailSendCode(email);
  const { verificationToken } = await api.auth.emailVerifyCode(email, '123456');
  await api.auth.emailSignup(verificationToken, 'pw12345678');
  return login(email);
}

beforeEach(() => {
  mockFiles.clear();
  mockWriteFails = false;
  mockDropDbFails = false;
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

describe('사용량', () => {
  it('자료를 올리면 파일 크기만큼 저장 공간이, 아바타에게 물을 때마다 AI 크레딧이 는다', async () => {
    const me = await signup('a@test.com');
    const f = await addFolder();
    const { material: m } = await api.content.createMaterial(material(f._id));
    expect((await api.me.get()).usage).toMatchObject({ storageBytes: 10, aiCredits: 0 });
    // 정리가 끝난 노트로 만든다(기기 저장 모드는 요약을 만들지 않는다)
    const key = `user-${me._id}`;
    const saved = JSON.parse(mockFiles.get(key)!);
    saved.materials.find((x: { _id: string }) => x._id === m._id).summary = {
      sections: [{ heading: '개요', body: '자료 설명.' }],
      points: ['핵심'],
    };
    mockFiles.set(key, JSON.stringify(saved));
    resetLocalForTests();
    await api.content.ask(m._id, { question: '핵심 알려 주세요', history: [] });
    await api.content.ask(m._id, { question: '오늘 날씨 알려 주세요', history: [] });
    expect((await api.me.get()).usage?.aiCredits).toBe(2);
    // 다시 켜도 남는다
    resetLocalForTests();
    expect((await api.me.get()).usage?.aiCredits).toBe(2);
  });
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

it('DB를 지우지 못하면 탈퇴 실패를 알리고, 로그인한 채로 다시 탈퇴할 수 있다', async () => {
  await signup('a@test.com');
  const f = await addFolder();
  await api.content.createMaterial(material(f._id));
  mockDropDbFails = true;
  await expect(api.me.withdraw()).rejects.toThrow('탈퇴를 마치지 못했어요');
  mockDropDbFails = false;
  expect(mockDropFile).not.toHaveBeenCalled();
  expect(await api.content.materials(f._id)).toHaveLength(1);
  await api.me.withdraw();
  expect(mockDropFile).toHaveBeenCalledWith('file:///doc/files/a.pdf');
  await expect(api.auth.emailLogin('a@test.com', 'pw12345678')).rejects.toThrow('맞지 않아요');
});

it('테마를 끼워도 장착한 아바타는 그대로이고, 같은 종류끼리만 바뀐다', async () => {
  const user = await signup('a@test.com');
  // 새 계정은 포인트가 0이라 저장된 DB에 포인트를 넣고 다시 읽는다
  const file = `user-${user._id}`;
  const saved = JSON.parse(mockFiles.get(file)!);
  saved.user.pointBalance = 100000;
  mockFiles.set(file, JSON.stringify(saved));
  resetLocalForTests();
  await login('a@test.com');
  const items = await api.shop.items({ sort: 'price' } as never);
  const theme = items.find((i) => i.category === 'theme')!;
  const avatar = items.find((i) => i.category === 'avatar' && i.price > 0)!;
  await api.shop.purchase(avatar._id);
  await api.shop.purchase(theme._id);
  const owned = await api.shop.myItems();
  const has = (id: string) => owned.some((u) => u.itemId === id && u.isOwned);
  expect(has(theme._id) && has(avatar._id)).toBe(true);
  await api.shop.equip(avatar._id);
  await api.shop.equip(theme._id);
  const after = await api.shop.myItems();
  const on = (id: string) => after.find((u) => u.itemId === id)?.isEquipped;
  expect(on(avatar._id)).toBe(true);
  expect(on(theme._id)).toBe(true);
  expect(after.filter((u) => u.isEquipped && u.itemCategory === 'avatar')).toHaveLength(1);
  await expect(api.shop.equip('없는-아이템')).rejects.toThrow('보유한');
});

it('구매한 아바타를 낀 뒤 기본 아바타로 돌아갈 수 있고, 테마는 그대로다', async () => {
  const user = await signup('a@test.com');
  const file = `user-${user._id}`;
  const saved = JSON.parse(mockFiles.get(file)!);
  saved.user.pointBalance = 100000;
  mockFiles.set(file, JSON.stringify(saved));
  resetLocalForTests();
  await login('a@test.com');
  const items = await api.shop.items({ sort: 'price' } as never);
  const theme = items.find((i) => i.category === 'theme')!;
  const avatar = items.find((i) => i.category === 'avatar' && i.price > 0)!;
  await api.shop.purchase(avatar._id);
  await api.shop.purchase(theme._id);
  await api.shop.equip(avatar._id);
  await api.shop.equip(theme._id);
  await expect(api.shop.equip('base')).resolves.toBeUndefined();
  const after = await api.shop.myItems();
  expect(after.filter((u) => u.isEquipped && u.itemCategory === 'avatar')).toHaveLength(0);
  expect(after.find((u) => u.itemId === theme._id)?.isEquipped).toBe(true);
});

it('저장한 아바타가 프로필에 보이고, 다시 켜도 남는다', async () => {
  await signup('a@test.com');
  await api.me.saveAvatar({ style: 'toon', gender: 'male', color: '#3b6e5b' });
  expect((await api.me.get()).avatarUrl).toBe('👨🏼‍🦱');
  resetLocalForTests();
  await login('a@test.com');
  expect((await api.me.get()).avatarUrl).toBe('👨🏼‍🦱');
});

it('지울 파일 목록을 적지 못하면 계정을 지우지 않고, 다시 탈퇴할 수 있다', async () => {
  await signup('a@test.com');
  const f = await addFolder();
  await api.content.createMaterial(material(f._id));
  mockWriteFails = true;
  await expect(api.me.withdraw()).rejects.toThrow('탈퇴를 마치지 못했어요');
  mockWriteFails = false;
  expect(mockDropFile).not.toHaveBeenCalled();
  expect(await api.content.materials(f._id)).toHaveLength(1);
  await api.me.withdraw();
  expect(mockDropFile).toHaveBeenCalledWith('file:///doc/files/a.pdf');
});

it('할 일에 지정한 시각이 생성 · 조회 · 다시 켠 뒤에도 남는다', async () => {
  await signup('a@test.com');
  const t = await api.calendar.addTodo({
    content: '영어 단어',
    todoType: 'general',
    dueDate: '2026-11-10',
    timeSlot: 'custom',
    dueTime: '19:30',
    subjectName: null,
  });
  expect(t.dueTime).toBe('19:30');
  const pick = async () =>
    (await api.calendar.todos('2026-11-10')).find((x) => x.content === '영어 단어')?.dueTime;
  expect(await pick()).toBe('19:30');
  resetLocalForTests();
  await login('a@test.com');
  expect(await pick()).toBe('19:30');
});

it('세션 포인트는 하루 2번까지만 준다 (포인트 기준)', async () => {
  jest.useFakeTimers({
    now: Date.parse('2026-11-04T09:00:00+09:00'),
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'setTimeout', 'clearTimeout'],
  });
  await signup('a@test.com');
  const item = await api.study.addItem({ title: '수학', subjectName: '수학', goalMin: null });
  const earned: number[] = [];
  for (let h = 0; h < 3; h++) {
    const s = await api.study.startSession({ studyItemId: item._id, mode: 'personal' });
    jest.setSystemTime(Date.parse(`2026-11-04T${String(10 + h * 2).padStart(2, '0')}:00:00+09:00`));
    earned.push(
      (await api.study.endSession(s._id, { clientDurationSec: 0, endReason: 'manual' }))
        .pointsEarned,
    );
    jest.setSystemTime(Date.parse(`2026-11-04T${String(11 + h * 2).padStart(2, '0')}:00:00+09:00`));
  }
  expect(earned).toEqual([20, 20, 0]);
  jest.useRealTimers();
});

it('퀴즈 포인트는 하루 40P까지 쌓이고(28 → 12 → 0), 서울 자정이 지나면 세션 · 퀴즈 한도가 다시 열린다', async () => {
  jest.useFakeTimers({
    now: Date.parse('2026-11-04T20:00:00+09:00'),
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask', 'setTimeout', 'clearTimeout'],
  });
  await signup('a@test.com');
  const set = seedQuizForTests(Array.from({ length: 10 }, (_, i) => `답${i}`));
  // 10문제 중 7개 맞히는 풀이 한 번의 포인트
  const solve = async () => {
    const a = await api.quiz.startAttempt(set._id);
    for (const [i, q] of set.questions.entries())
      await api.quiz.answer(a._id, q._id, i < 7 ? q.answer : '오답');
    return (await api.quiz.finish(a._id)).pointsEarned;
  };
  expect([await solve(), await solve(), await solve()]).toEqual([28, 12, 0]);

  const item = await api.study.addItem({ title: '수학', subjectName: '수학', goalMin: null });
  const session = async (startIso: string, endIso: string) => {
    jest.setSystemTime(Date.parse(startIso));
    const s = await api.study.startSession({ studyItemId: item._id, mode: 'personal' });
    jest.setSystemTime(Date.parse(endIso));
    return (await api.study.endSession(s._id, { clientDurationSec: 0, endReason: 'manual' }))
      .pointsEarned;
  };
  await session('2026-11-04T21:00:00+09:00', '2026-11-04T21:30:00+09:00');
  await session('2026-11-04T22:00:00+09:00', '2026-11-04T22:30:00+09:00');
  expect(await session('2026-11-04T23:00:00+09:00', '2026-11-04T23:30:00+09:00')).toBe(0);
  // 서울 자정 직후(00:10~00:40) — UTC로는 아직 11월 4일이라 서울 날짜 기준으로 한도가 열리는지 본다
  expect(await session('2026-11-05T00:10:00+09:00', '2026-11-05T00:40:00+09:00')).toBe(20);
  expect(await solve()).toBe(28);
  jest.useRealTimers();
});

it('기기 저장 모드 가입: 인증번호가 6자리 숫자가 아니면 EMAIL_CODE_INVALID, 이메일 형식이 틀리면 보내지 않는다', async () => {
  await expect(api.auth.emailVerifyCode('a@test.com', '12ab56')).rejects.toMatchObject({
    code: ERROR_CODES.EMAIL_CODE_INVALID,
    status: 400,
  });
  await expect(api.auth.emailSendCode('a@')).rejects.toMatchObject({
    code: ERROR_CODES.VALIDATION,
  });
});

describe('아이디 · 비밀번호 찾기(기기 저장 모드)', () => {
  it('닉네임으로 가입 이메일을 가려서 찾고, 인증번호 뒤 새 비밀번호로 로그인한다', async () => {
    await signup('student@example.com');
    await api.me.update({ nickname: '광합성왕' });
    expect(await api.auth.findEmail('광합성왕')).toEqual({ emails: ['st*****@example.com'] });
    expect(await api.auth.findEmail('없는사람')).toEqual({ emails: [] });

    await api.auth.passwordSendCode('student@example.com');
    await expect(
      api.auth.passwordReset('student@example.com', '12', 'newpass123'),
    ).rejects.toMatchObject({
      code: ERROR_CODES.EMAIL_CODE_INVALID,
    });
    await api.auth.passwordReset('student@example.com', '123456', 'newpass123');
    await expect(api.auth.emailLogin('student@example.com', 'pw12345678')).rejects.toBeTruthy();
    expect((await api.auth.emailLogin('student@example.com', 'newpass123')).user.email).toBe(
      'student@example.com',
    );
    await expect(
      api.auth.passwordReset('nobody@example.com', '123456', 'newpass123'),
    ).rejects.toBeTruthy();
  });
});
