import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model, Types } from 'mongoose';

import { UploadQuota, type UploadQuotaDocument } from './schemas/upload-quota.schema.js';

/** 한 사용자가 한 구간에 받을 수 있는 주소 수. 노트 하나가 50장까지라 그보다 넉넉히 둔다 */
export const UPLOAD_ISSUE_LIMIT = 100;
/** 구간 길이. 시각을 이 길이로 끊어 센다(구간이 바뀌는 앞뒤로는 잠깐 한도의 두 배까지 받을 수 있다) */
export const UPLOAD_ISSUE_WINDOW_MS = 10 * 60_000;

/** Mongo 중복 키 오류 코드(사용자 · 구간 유일 색인) */
const DUPLICATE_KEY = 11000;
const isDuplicateKey = (error: unknown) => (error as { code?: unknown }).code === DUPLICATE_KEY;

export type ReserveResult = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * 올리기 주소 발급 횟수를 사용자별로 제한한다.
 * 세고 → 판단하고 → 쓰는 대신 "한도 안일 때만 하나 올리는" 한 번의 업데이트로 처리해, 동시에 온 요청도 한도를 넘지 못한다.
 */
@Injectable()
export class UploadQuotaService {
  constructor(@InjectModel(UploadQuota.name) private readonly quotas: Model<UploadQuotaDocument>) {}

  /** 주소 하나를 쓴다. 한도에 닿았으면 쓰지 않고 구간이 끝날 때까지 남은 시간을 알려 준다 */
  async reserve(userId: string, now: Date = new Date()): Promise<ReserveResult> {
    const start = Math.floor(now.getTime() / UPLOAD_ISSUE_WINDOW_MS) * UPLOAD_ISSUE_WINDOW_MS;
    const end = start + UPLOAD_ISSUE_WINDOW_MS;
    const key = { ownerId: new Types.ObjectId(userId), windowStart: new Date(start) };

    // 문서가 없으면 만들고, 한도 안이면 하나 올린다. 한도에 닿은 문서는 조건에 맞지 않아 새로 만들려다 유일 색인에 걸린다.
    // 처음 만드는 요청이 겹쳐도 같은 오류가 나므로 한 번 더 해 본다(그때는 이미 만들어진 문서를 올린다)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.quotas.updateOne(
          { ...key, count: { $lt: UPLOAD_ISSUE_LIMIT } },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(end) } },
          { upsert: true },
        );
        return { ok: true };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
      }
    }
    return { ok: false, retryAfterMs: Math.max(1000, end - now.getTime()) };
  }
}
