import type { ConfigReader } from './mongo.config.js';

export const DEFAULT_UPLOAD_CONTAINER = 'raw';
/** Azure 컨테이너 이름 규칙: 소문자 · 숫자 · 하이픈 3~63자, 하이픈은 연달아 쓰지 않고 양 끝에 두지 않는다 */
const CONTAINER_PATTERN = /^(?=.{3,63}$)[a-z0-9]+(-[a-z0-9]+)*$/;
/** http를 받는 주소: 이 컴퓨터에서 도는 에뮬레이터뿐 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface StorageConfig {
  accountName: string;
  accountKey: string;
  /** Blob 서비스 주소. 끝에 '/'가 없다 */
  blobEndpoint: string;
  container: string;
}

/**
 * 파일 저장소 설정을 만든다. `AZURE_STORAGE_CONNECTION_STRING`이 없으면 null(서버는 뜨고 올리기만 막힌다).
 * 값이 있는데 모양이 틀리면 바로 실패한다. 오류 문구에는 값을 넣지 않는다(키가 들어 있다).
 * Blob 주소는 https만 받는다. http는 로컬 에뮬레이터(localhost)일 때만 받는다.
 */
export function createStorageConfig(config: ConfigReader): StorageConfig | null {
  const raw = config.get('AZURE_STORAGE_CONNECTION_STRING')?.trim();
  if (!raw) return null;

  const parts = new Map<string, string>();
  for (const piece of raw.split(';')) {
    const eq = piece.indexOf('=');
    if (eq > 0) parts.set(piece.slice(0, eq).trim().toLowerCase(), piece.slice(eq + 1).trim());
  }
  const accountName = parts.get('accountname');
  const accountKey = parts.get('accountkey');
  if (!accountName || !accountKey) {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING에 AccountName · AccountKey가 있어야 합니다');
  }

  const protocol = parts.get('defaultendpointsprotocol') || 'https';
  const suffix = parts.get('endpointsuffix') || 'core.windows.net';
  const endpoint = parts.get('blobendpoint') || `${protocol}://${accountName}.blob.${suffix}`;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error('AZURE_STORAGE_CONNECTION_STRING의 Blob 주소가 올바르지 않습니다');
  }
  const localHttp = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(
      'AZURE_STORAGE_CONNECTION_STRING의 Blob 주소는 https여야 합니다(http는 로컬 에뮬레이터만)',
    );
  }

  const container = config.get('AZURE_BLOB_CONTAINER')?.trim() || DEFAULT_UPLOAD_CONTAINER;
  if (!CONTAINER_PATTERN.test(container)) {
    throw new Error('AZURE_BLOB_CONTAINER는 소문자 · 숫자 · 하이픈 3~63자여야 합니다');
  }

  return {
    accountName,
    accountKey,
    blobEndpoint: `${url.origin}${url.pathname}`.replace(/\/+$/, ''),
    container,
  };
}
