import { BadRequestException } from '@nestjs/common';
import { ERROR_CODES } from '@notelink/shared';
import { Types } from 'mongoose';

/** 폴더 노트 목록의 다음 페이지 위치: 목록 정렬 키(createdAt 내림차순, _id 내림차순)와 같다 */
export interface ListCursor {
  createdAt: Date;
  id: Types.ObjectId;
}

/** 다음 페이지 위치를 담아 보내는 응답 헤더 이름(본문은 어떤 경우에도 배열 그대로) */
export const NEXT_CURSOR_HEADER = 'X-Next-Cursor';
/** limit 허용 범위 */
export const LIST_LIMIT_MIN = 1;
export const LIST_LIMIT_MAX = 100;

const MAX_CURSOR_LENGTH = 200;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
/** JS Date 가 표현하는 최대 시각 */
const MAX_TIME = 8.64e15;

const invalid = (message: string) =>
  new BadRequestException({ code: ERROR_CODES.VALIDATION, message });

/** base64url(JSON [createdAt(ms), _id(hex)]). 앱은 뜻을 알 필요 없이 그대로 되돌려 보낸다 */
export function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.createdAt.getTime(), cursor.id.toHexString()]),
  ).toString('base64url');
}

/** 틀린 형식은 모두 400 VALIDATION_FAILED */
export function decodeCursor(raw: string): ListCursor {
  const bad = () => invalid('cursor 형식이 올바르지 않아요');
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH || !BASE64URL.test(raw)) throw bad();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) throw bad();
  const [ms, id] = parsed as [unknown, unknown];
  if (
    typeof ms !== 'number' ||
    !Number.isSafeInteger(ms) ||
    Math.abs(ms) > MAX_TIME ||
    typeof id !== 'string' ||
    !OBJECT_ID.test(id)
  )
    throw bad();
  return { createdAt: new Date(ms), id: new Types.ObjectId(id) };
}

/** 쿼리(limit · cursor)를 서비스가 쓰는 모양으로. 둘 다 없으면 {} — 전체 배열. cursor 만 있으면 400 */
export function parseListQuery(query: { limit?: number; cursor?: string }): {
  limit?: number;
  after?: ListCursor;
} {
  if (query.cursor !== undefined && query.limit === undefined)
    throw invalid('cursor 는 limit 과 함께 보내 주세요');
  return {
    ...(query.limit !== undefined ? { limit: query.limit } : {}),
    ...(query.cursor !== undefined ? { after: decodeCursor(query.cursor) } : {}),
  };
}
