import { BadRequestException } from '@nestjs/common';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  decodeCursor,
  encodeCursor,
  parseListQuery,
} from '../src/modules/content/materials/list-cursor.js';

const id = new Types.ObjectId('507f1f77bcf86cd799439011');
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BadRequestException);
    return (e as BadRequestException).getResponse() as { code: string };
  }
  throw new Error('예외가 나야 해요');
};

describe('폴더 노트 목록 cursor', () => {
  it('정렬 키(createdAt ms, _id)를 담았다가 그대로 되돌린다', () => {
    const cursor = { createdAt: new Date('2026-11-14T03:00:00.123Z'), id };
    const text = encodeCursor(cursor);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/); // 주소 쿼리에 그대로 넣어도 되는 글자만
    const back = decodeCursor(text);
    expect(back.createdAt.toISOString()).toBe('2026-11-14T03:00:00.123Z');
    expect(back.id.toHexString()).toBe(id.toHexString());
  });

  it.each([
    ['빈 글자', ''],
    ['base64url 이 아닌 글자', 'not valid!'],
    ['JSON 이 아님', Buffer.from('hello').toString('base64url')],
    ['배열이 아님', b64({ a: 1 })],
    ['길이가 2가 아님', b64([1])],
    ['길이가 3', b64([1, id.toHexString(), 'x'])],
    ['시각이 글자', b64(['1', id.toHexString()])],
    ['시각이 소수', b64([1.5, id.toHexString()])],
    ['시각이 범위 밖', b64([1e20, id.toHexString()])],
    ['id 가 글자가 아님', b64([1, 5])],
    ['id 형식이 아님', b64([1, 'zzzzzzzzzzzzzzzzzzzzzzzz'])],
    ['id 가 짧음', b64([1, '507f1f77'])],
    ['너무 김', 'a'.repeat(201)],
  ])('틀린 형식은 400 VALIDATION_FAILED: %s', (_name, raw) => {
    expect(code(() => decodeCursor(raw))).toEqual({
      code: 'VALIDATION_FAILED',
      message: expect.any(String),
    });
  });

  it('쿼리 해석: 둘 다 없으면 {} (전체), limit 만 있으면 limit, 둘 다 있으면 위치까지', () => {
    expect(parseListQuery({})).toEqual({});
    expect(parseListQuery({ limit: 10 })).toEqual({ limit: 10 });
    const text = encodeCursor({ createdAt: new Date(5), id });
    const parsed = parseListQuery({ limit: 10, cursor: text });
    expect(parsed.limit).toBe(10);
    expect(parsed.after?.createdAt.getTime()).toBe(5);
  });

  it('cursor 만 있고 limit 이 없으면 400 VALIDATION_FAILED, 틀린 cursor 도 400', () => {
    const text = encodeCursor({ createdAt: new Date(5), id });
    expect(code(() => parseListQuery({ cursor: text })).code).toBe('VALIDATION_FAILED');
    expect(code(() => parseListQuery({ limit: 5, cursor: 'x!' })).code).toBe('VALIDATION_FAILED');
  });
});
