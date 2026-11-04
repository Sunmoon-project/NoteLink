import { Directory, File, Paths } from 'expo-file-system';

// 기기 저장: DB는 앱 문서 폴더의 JSON 파일 하나, 사용자가 고른 파일은 files/ 폴더에 복사해 둔다.
// 서버(MongoDB · Blob)가 붙으면 이 계층 대신 http-api가 쓰인다.

const FILES_DIR = 'files';
const dbFile = (name: string) => `notelink-${name}.json`;
// iOS는 앱을 업데이트하면 문서 폴더의 절대 경로가 바뀐다. DB에는 경로 앞부분을 빼고 저장한다
const DOC_TOKEN = 'notelink-doc://';

/** 저장된 JSON을 읽는다(계정 목록 'accounts' · 계정별 DB 'user-<id>'). 처음이면 null */
export function readDb(name: string): unknown | null {
  try {
    const f = new File(Paths.document, dbFile(name));
    if (!f.exists) return null;
    return JSON.parse(f.textSync().replaceAll(DOC_TOKEN, Paths.document.uri));
  } catch {
    return null; // 깨진 파일은 새로 시작한다
  }
}

/** DB 전체를 쓴다 (임시 파일에 쓰고 바꿔 끼워 중간에 꺼져도 이전 내용이 남게) */
export function writeDb(name: string, data: unknown) {
  try {
    const tmp = new File(Paths.document, `${dbFile(name)}.tmp`);
    if (tmp.exists) tmp.delete();
    tmp.create();
    tmp.write(JSON.stringify(data).replaceAll(Paths.document.uri, DOC_TOKEN));
    const target = new File(Paths.document, dbFile(name));
    if (target.exists) target.delete();
    tmp.move(target);
  } catch {
    // 테스트 · 웹처럼 파일 시스템이 없으면 메모리에만 둔다
  }
}

const filesDir = () => {
  const d = new Directory(Paths.document, FILES_DIR);
  if (!d.exists) d.create({ intermediates: true });
  return d;
};

/** 고른 파일(갤러리 · 파일 앱 · 카메라 · 녹음)을 앱 저장 공간에 복사하고 주소 · 크기를 돌려준다 */
export function keepFile(uri: string, name: string): { uri: string; size: number } {
  // 원래 이름을 뒤에 붙여 둔다: <시각+난수>_<원래 이름>
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(-80) || 'file';
  const dest = new File(
    filesDir(),
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}_${safe}`,
  );
  new File(uri).copy(dest);
  return { uri: dest.uri, size: dest.size ?? 0 };
}

/** 앱 저장 공간의 파일을 지운다 (자료 삭제 · 탈퇴) */
export function dropFile(uri: string) {
  try {
    const f = new File(uri);
    if (f.exists && f.uri.includes(`/${FILES_DIR}/`)) f.delete();
  } catch {
    // 이미 없으면 그만
  }
}

/** 탈퇴: 그 계정의 DB 파일을 지운다 (자료 파일은 dropFile로 하나씩 지운다) */
export function dropDb(name: string) {
  try {
    const f = new File(Paths.document, dbFile(name));
    if (f.exists) f.delete();
  } catch {
    // 없으면 그만
  }
}

/** 복사해 둔 파일의 원래 이름 · 크기 */
export function fileInfo(uri: string): { name: string; size: number } {
  const base = decodeURIComponent(uri.split('/').pop() ?? '');
  const name = base.includes('_') ? base.slice(base.indexOf('_') + 1) : base;
  try {
    return { name, size: new File(uri).size ?? 0 };
  } catch {
    return { name, size: 0 };
  }
}
