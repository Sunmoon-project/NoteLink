// 실제 저장 계층을 메모리 파일 시스템으로 돌려 파일 교체 실패를 재현한다
const mockDisk = new Map<string, string>();
let mockFailMove: ((to: string) => boolean) | null = null;
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
      if (mockFailMove?.(to.uri)) throw new Error('move failed');
      // 실제 expo-file-system처럼 대상이 있으면 실패하고, 옮긴 뒤 객체의 경로도 바뀐다
      if (mockDisk.has(to.uri)) throw new Error('destination exists');
      mockDisk.set(to.uri, mockDisk.get(this.uri)!);
      mockDisk.delete(this.uri);
      this.uri = to.uri;
    }
  }
  return { File, Directory: class {}, Paths: { document: { uri: 'file:///doc/' } } };
});
jest.unmock('../lib/local/storage');
const { dropDb, dropFiles, keptFilesIn, readDb, rememberOrphans, writeDb } =
  jest.requireActual<typeof import('../lib/local/storage')>('../lib/local/storage');

beforeEach(() => {
  mockDisk.clear();
  mockFailMove = null;
  mockFailDelete = null;
});

it('새 파일로 바꿔 끼우지 못하면 실패를 알리고 이전 내용을 지키며, 임시 · 백업을 정리한다', () => {
  writeDb('u', { v: 1 });
  mockFailMove = (to) => to.endsWith('notelink-u.json');
  // 되돌리는 이동까지 막지 않도록 한 번만 실패시킨다
  let failed = false;
  const fail = mockFailMove;
  mockFailMove = (to) => {
    if (!failed && fail(to)) {
      failed = true;
      return true;
    }
    return false;
  };
  expect(() => writeDb('u', { v: 2 })).toThrow('move failed');
  mockFailMove = null;
  expect(readDb('u')).toEqual({ v: 1 });
});

it('같은 DB를 여러 번 저장해도 마지막 내용이 남고 백업 · 임시 파일이 남지 않는다', () => {
  writeDb('u', { v: 1 });
  writeDb('u', { v: 2 });
  writeDb('u', { v: 3 });
  expect(readDb('u')).toEqual({ v: 3 });
  expect([...mockDisk.keys()]).toEqual(['file:///doc/notelink-u.json']);
});

it('새 내용으로 바꾼 뒤 백업을 못 지워도 저장 실패로 알리지 않는다', () => {
  writeDb('u', { v: 1 });
  mockFailDelete = (uri) => uri.endsWith('.bak');
  expect(() => writeDb('u', { v: 2 })).not.toThrow();
  mockFailDelete = null;
  expect(readDb('u')).toEqual({ v: 2 });
  writeDb('u', { v: 3 });
  expect(readDb('u')).toEqual({ v: 3 });
  expect([...mockDisk.keys()]).toEqual(['file:///doc/notelink-u.json']);
});

it('탈퇴하면 남아 있던 백업 · 임시 파일까지 지워 다시 읽히지 않는다', () => {
  writeDb('u', { v: 1 });
  mockFailDelete = (uri) => uri.endsWith('.bak');
  writeDb('u', { v: 2 });
  mockFailDelete = null;
  mockDisk.set('file:///doc/notelink-u.json.tmp', '{}');
  dropDb('u');
  expect([...mockDisk.keys()]).toEqual([]);
  expect(readDb('u')).toBeNull();
});

it('백업을 지우지 못하면 실패를 알리고 본 파일은 남겨 다시 시도할 수 있다', () => {
  writeDb('u', { v: 1 });
  mockDisk.set('file:///doc/notelink-u.json.bak', '{"v":0}');
  mockFailDelete = (uri) => uri.endsWith('.bak');
  expect(() => dropDb('u')).toThrow('delete failed');
  mockFailDelete = null;
  expect(readDb('u')).toEqual({ v: 1 });
  dropDb('u');
  expect([...mockDisk.keys()]).toEqual([]);
});

it('DB에 적힌 값에서 앱 저장 공간의 파일만 모은다', () => {
  expect(
    keptFilesIn({
      materials: [{ files: [{ uri: 'file:///doc/files/a.pdf' }] }],
      jobs: [{ targetId: 'file:///doc/files/p.jpg' }, { targetId: 'file:///doc/files/a.pdf' }],
      other: 'file:///tmp/x.jpg',
    }),
  ).toEqual(['file:///doc/files/a.pdf', 'file:///doc/files/p.jpg']);
});

it('임시 파일에 쓰다 실패해도 이전 파일을 건드리지 않는다', () => {
  writeDb('u', { v: 1 });
  const original = jest.requireMock<{ File: { prototype: { write: unknown } } }>('expo-file-system')
    .File.prototype;
  const write = original.write;
  original.write = () => {
    throw new Error('disk full');
  };
  expect(() => writeDb('u', { v: 2 })).toThrow('disk full');
  original.write = write;
  expect(readDb('u')).toEqual({ v: 1 });
});

it('교체 중 앱이 꺼졌으면 다음 읽기에서 이전 파일로 되돌린다', () => {
  writeDb('u', { v: 1 });
  mockDisk.set('file:///doc/notelink-u.json.bak', mockDisk.get('file:///doc/notelink-u.json')!);
  mockDisk.delete('file:///doc/notelink-u.json');
  expect(readDb('u')).toEqual({ v: 1 });
});

it('앱 폴더 경로가 바뀌어도 파일 주소를 현재 경로로 읽는다', () => {
  writeDb('u', { uri: 'file:///doc/files/a.pdf' });
  expect(mockDisk.get('file:///doc/notelink-u.json')).not.toContain('file:///doc/');
  expect(readDb('u')).toEqual({ uri: 'file:///doc/files/a.pdf' });
});

it('탈퇴 때 지우지 못한 파일은 기기 목록에 남겼다가 다음 실행 때 로그인 없이 지운다', () => {
  mockDisk.set('file:///doc/files/a.pdf', 'a');
  mockDisk.set('file:///doc/files/b.jpg', 'b');
  mockFailDelete = (uri) => uri.endsWith('b.jpg');
  expect(dropFiles(['file:///doc/files/a.pdf', 'file:///doc/files/b.jpg'])).toEqual([
    'file:///doc/files/b.jpg',
  ]);
  expect(mockDisk.has('file:///doc/files/a.pdf')).toBe(false);
  expect(readDb('orphans')).toEqual(['file:///doc/files/b.jpg']);
  // 다음 실행: 계정 없이 목록만으로 다시 지우고, 다 지우면 목록도 없앤다
  mockFailDelete = null;
  expect(dropFiles([])).toEqual([]);
  expect(mockDisk.has('file:///doc/files/b.jpg')).toBe(false);
  expect(readDb('orphans')).toBeNull();
});

it('파일 삭제와 목록 갱신이 함께 실패해도, 먼저 적어 둔 목록으로 다음 실행 때 지운다', () => {
  mockDisk.set('file:///doc/files/a.pdf', 'a');
  rememberOrphans(['file:///doc/files/a.pdf']);
  const proto = jest.requireMock<{ File: { prototype: { write: unknown } } }>('expo-file-system')
    .File.prototype;
  const write = proto.write;
  proto.write = () => {
    throw new Error('disk full');
  };
  mockFailDelete = (uri) => uri.endsWith('a.pdf');
  expect(dropFiles(['file:///doc/files/a.pdf'])).toEqual(['file:///doc/files/a.pdf']);
  proto.write = write;
  mockFailDelete = null;
  expect(readDb('orphans')).toEqual(['file:///doc/files/a.pdf']);
  expect(dropFiles([])).toEqual([]);
  expect(mockDisk.has('file:///doc/files/a.pdf')).toBe(false);
});
