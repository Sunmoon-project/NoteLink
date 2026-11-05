// 실제 저장 계층(storage) + 실제 기기 저장 API(localApi)를 메모리 파일 시스템으로 돌려
// "정리 목록 저장 성공 → 계정 DB 삭제 실패 → 앱 재시작" 뒤에도 자료 원본이 남는지 본다

const mockDisk = new Map<string, string>();
let mockFailDelete: ((uri: string) => boolean) | null = null;
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(base: { uri: string } | string, name?: string) {
      this.uri = typeof base === 'string' ? base : `${base.uri}${name}`;
    }
    get exists() {
      return mockDisk.has(this.uri);
    }
    get size() {
      return (mockDisk.get(this.uri) ?? '').length;
    }
    create() {
      mockDisk.set(this.uri, '');
    }
    delete() {
      if (mockFailDelete?.(this.uri)) throw new Error('delete failed');
      mockDisk.delete(this.uri);
    }
    write(v: string) {
      mockDisk.set(this.uri, v);
    }
    textSync() {
      return mockDisk.get(this.uri)!;
    }
    move(to: File) {
      if (mockDisk.has(to.uri)) throw new Error('destination exists');
      mockDisk.set(to.uri, mockDisk.get(this.uri)!);
      mockDisk.delete(this.uri);
      this.uri = to.uri;
    }
  }
  class Directory {
    uri: string;
    constructor(base: { uri: string }, name: string) {
      this.uri = `${base.uri}${name}/`;
    }
    get exists() {
      return true;
    }
    create() {}
  }
  return { File, Directory, Paths: { document: { uri: 'file:///doc/' } } };
});
jest.unmock('../lib/local/storage');
const mockKeychain = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (k: string) => mockKeychain.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockKeychain.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockKeychain.delete(k)),
}));

/** 앱을 새로 켠 것처럼 모듈을 다시 읽는다 (읽을 때 남은 파일 정리가 돈다) */
const boot = () => {
  let m!: {
    api: (typeof import('../lib/local/api'))['localApi'];
    login: (email: string) => Promise<{ _id: string }>;
  };
  jest.isolateModules(() => {
    const { localApi } = jest.requireActual<typeof import('../lib/local/api')>('../lib/local/api');
    const { useAuth } = jest.requireActual<typeof import('../stores/auth')>('../stores/auth');
    const { useNet } = jest.requireActual<typeof import('../stores/net')>('../stores/net');
    useNet.setState({ state: 'ok' });
    m = {
      api: localApi,
      login: async (email) => {
        const r = await localApi.auth.emailLogin(email, 'pw12345678');
        useAuth.setState({ userId: r.user._id });
        return r.user;
      },
    };
  });
  return m;
};

beforeEach(() => {
  mockDisk.clear();
  mockKeychain.clear();
  mockFailDelete = null;
});

it('탈퇴가 DB 삭제에서 실패한 뒤 앱을 다시 켜도 자료 원본은 남고, 다시 탈퇴하면 지운다', async () => {
  let { api, login } = boot();
  await api.auth.emailSignup('a@test.com', 'pw12345678');
  const user = await login('a@test.com');
  const folder = await api.content.createFolder({ title: '수학', subjectName: '수학' } as never);
  mockDisk.set('file:///doc/files/a.pdf', '원본');
  await api.content.createMaterial({
    requestId: 'r1',
    folderId: folder._id,
    kind: 'document',
    source: 'file',
    title: '자료',
    blobUrls: ['file:///doc/files/a.pdf'],
  });

  // 정리 목록은 적었지만 계정 DB 본 파일을 지우지 못한다
  mockFailDelete = (uri) => uri === `file:///doc/notelink-user-${user._id}.json`;
  await expect(api.me.withdraw()).rejects.toThrow('탈퇴를 마치지 못했어요');
  mockFailDelete = null;
  expect(mockDisk.has('file:///doc/notelink-orphans.json')).toBe(true);

  // 재시도하지 않고 앱만 다시 켠다 → 살아 있는 계정의 원본은 지우지 않는다
  ({ api, login } = boot());
  expect(mockDisk.get('file:///doc/files/a.pdf')).toBe('원본');
  await login('a@test.com');
  expect(await api.content.materials(folder._id)).toHaveLength(1);

  // 다시 탈퇴하면 그때 지운다
  await api.me.withdraw();
  expect(mockDisk.has('file:///doc/files/a.pdf')).toBe(false);
  expect(mockDisk.has('file:///doc/notelink-orphans.json')).toBe(false);
});
