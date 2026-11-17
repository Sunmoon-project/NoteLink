import { describe, expect, it } from 'vitest';

import type { ConfigReader } from '../src/config/mongo.config.js';
import { createStorageConfig, DEFAULT_UPLOAD_CONTAINER } from '../src/config/storage.config.js';

const KEY = 'ZmFrZS1zdG9yYWdlLWtleS1mb3ItdGVzdHM=';
const CONNECTION = `DefaultEndpointsProtocol=https;AccountName=notelinktest;AccountKey=${KEY};EndpointSuffix=core.windows.net`;
const env = (values: Record<string, string>): ConfigReader => ({ get: (key) => values[key] });

describe('파일 저장소 설정', () => {
  it('연결 문자열이 없거나 비어 있으면 null이다 (서버는 뜬다)', () => {
    expect(createStorageConfig(env({}))).toBeNull();
    expect(createStorageConfig(env({ AZURE_STORAGE_CONNECTION_STRING: '  ' }))).toBeNull();
  });

  it('연결 문자열에서 계정 · 키 · Blob 주소를 읽고 컨테이너는 기본값을 쓴다', () => {
    expect(createStorageConfig(env({ AZURE_STORAGE_CONNECTION_STRING: CONNECTION }))).toEqual({
      accountName: 'notelinktest',
      accountKey: KEY,
      blobEndpoint: 'https://notelinktest.blob.core.windows.net',
      container: DEFAULT_UPLOAD_CONTAINER,
    });
  });

  it('키 끝의 = 를 자르지 않는다', () => {
    const key = 'YWJjZA==';
    const config = createStorageConfig(
      env({ AZURE_STORAGE_CONNECTION_STRING: `AccountName=a1;AccountKey=${key}` }),
    );
    expect(config?.accountKey).toBe(key);
  });

  it('BlobEndpoint가 있으면 그 주소를 쓰고 끝의 /는 뗀다 (로컬 에뮬레이터)', () => {
    const config = createStorageConfig(
      env({
        AZURE_STORAGE_CONNECTION_STRING: `AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1/`,
      }),
    );
    expect(config?.blobEndpoint).toBe('http://127.0.0.1:10000/devstoreaccount1');
  });

  it.each(['http://localhost:10000/devstoreaccount1', 'http://[::1]:10000/devstoreaccount1'])(
    'http는 로컬 에뮬레이터 주소 %s 만 받는다',
    (endpoint) => {
      const config = createStorageConfig(
        env({
          AZURE_STORAGE_CONNECTION_STRING: `AccountName=devstoreaccount1;AccountKey=${KEY};BlobEndpoint=${endpoint}`,
        }),
      );
      expect(config?.blobEndpoint).toBe(endpoint);
    },
  );

  it('컨테이너 이름을 환경변수로 바꿀 수 있다', () => {
    const config = createStorageConfig(
      env({
        AZURE_STORAGE_CONNECTION_STRING: CONNECTION,
        AZURE_BLOB_CONTAINER: 'uploads-dev',
      }),
    );
    expect(config?.container).toBe('uploads-dev');
  });

  it.each(['Ab', 'UPPER', 'a--b', '-abc', 'abc-', 'a/b'])(
    '컨테이너 이름 %s 는 받지 않는다',
    (container) => {
      expect(() =>
        createStorageConfig(
          env({
            AZURE_STORAGE_CONNECTION_STRING: CONNECTION,
            AZURE_BLOB_CONTAINER: container,
          }),
        ),
      ).toThrow('AZURE_BLOB_CONTAINER');
    },
  );

  it.each([
    ['계정 이름 없음', `AccountKey=${KEY}`],
    ['키 없음', 'AccountName=notelinktest'],
    ['Blob 주소가 주소가 아님', `AccountName=a1;AccountKey=${KEY};BlobEndpoint=not a url`],
    [
      'Blob 주소가 http(s)가 아님',
      `AccountName=a1;AccountKey=${KEY};BlobEndpoint=ftp://a1.example`,
    ],
    [
      '로컬이 아닌 http 주소',
      `AccountName=a1;AccountKey=${KEY};BlobEndpoint=http://a1.blob.core.windows.net`,
    ],
    [
      '프로토콜을 http로 둔 실제 계정',
      `DefaultEndpointsProtocol=http;AccountName=a1;AccountKey=${KEY}`,
    ],
    [
      'localhost로 시작하는 다른 주소',
      `AccountName=a1;AccountKey=${KEY};BlobEndpoint=http://localhost.example.com/a1`,
    ],
  ])('%s 이면 실패하고 오류 문구에 값을 넣지 않는다', (_name, value) => {
    let message = '';
    try {
      createStorageConfig(env({ AZURE_STORAGE_CONNECTION_STRING: value }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('AZURE_STORAGE_CONNECTION_STRING');
    expect(message).not.toContain(KEY);
  });
});
