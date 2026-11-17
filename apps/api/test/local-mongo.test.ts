import { describe, expect, it } from 'vitest';

import { isLocalMongoUri } from './support/local-mongo.js';

describe('진짜 DB 테스트의 접속 주소 검사', () => {
  it.each([
    'mongodb://localhost',
    'mongodb://localhost:27017',
    'mongodb://localhost:27017/',
    'mongodb://127.0.0.1:27117/?directConnection=true',
    'mongodb://localhost?directConnection=true',
    'mongodb://user:pw@localhost:27017/db',
  ])('이 PC 주소는 받는다: %s', (uri) => {
    expect(isLocalMongoUri(uri)).toBe(true);
  });

  it.each([
    undefined,
    '',
    'mongodb://localhost:27017,remote.example:27017/',
    'mongodb://localhost,remote.example/',
    'mongodb://127.0.0.1:27017,10.0.0.5:27017/?replicaSet=rs0',
    'mongodb://remote.example:27017/',
    'mongodb://localhost.remote.example/',
    'mongodb://localhost@remote.example/',
    'mongodb://remote.example,localhost@localhost/',
    'mongodb+srv://localhost/',
  ])('그 밖의 주소는 거부한다: %s', (uri) => {
    expect(isLocalMongoUri(uri)).toBe(false);
  });
});
