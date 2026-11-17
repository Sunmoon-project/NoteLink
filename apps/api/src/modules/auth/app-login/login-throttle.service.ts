import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';

import { LoginAttempt, type LoginAttemptDocument } from '../schemas/login-attempt.schema.js';

/** 한 이메일에 로그인을 시도할 수 있는 횟수. 넘으면 잠긴다 */
export const LOGIN_MAX_ATTEMPTS = 5;
/** 마지막 시도로부터 이 시간이 지나면 횟수를 처음부터 센다(한도에 닿았다면 곧 잠금이 풀리는 시간이다) */
export const LOGIN_LOCK_MS = 15 * 60 * 1000;

/** Mongo 중복 키 오류 코드(이메일 유일 인덱스) */
const DUPLICATE_KEY = 11000;

export type ReserveResult =
  /** 시도 하나를 쓸 수 있다. 비밀번호를 확인해도 된다 */
  | { ok: true }
  /** 한도에 닿아 잠겼다. `retryAfterMs` 뒤에 다시 시도할 수 있다 */
  | { ok: false; retryAfterMs: number };

/**
 * 이메일 로그인 시도 횟수를 제한한다(비밀번호 무차별 대입 방어).
 *
 * **비밀번호를 확인하기 전에** 시도를 하나 먼저 쓴다. 확인한 뒤에 실패를 세면, 동시에 보낸 수백 개의 추측이
 * 모두 확인만 되고 횟수가 늘지 않는 틈이 생긴다. 먼저 쓰면 어떤 동시성에서도 확인은 한도 횟수까지만 일어난다.
 * 모든 제한은 "조건이 걸린 한 번의 업데이트"로 처리해서 읽고 → 판단하고 → 쓰는 사이에 다른 요청이 끼어들지 못한다.
 */
@Injectable()
export class LoginThrottleService {
  constructor(
    @InjectModel(LoginAttempt.name) private readonly attempts: Model<LoginAttemptDocument>,
  ) {}

  /** 시도 하나를 쓴다. 한도에 닿아 잠겼다면 쓰지 않고(기록을 건드리지 않고) 남은 시간을 알려 준다 */
  async reserve(email: string): Promise<ReserveResult> {
    const now = new Date();
    const stale = new Date(now.getTime() - LOGIN_LOCK_MS);
    const next = { lastAttemptAt: now, expiresAt: new Date(now.getTime() + LOGIN_LOCK_MS) };

    // 1. 마지막 시도로부터 시간이 충분히 지났으면 횟수를 처음부터 센다(잠금이 풀린 경우도 여기에 해당한다)
    const restarted = await this.attempts.updateOne(
      { email, lastAttemptAt: { $lte: stale } },
      { $set: { attempts: 1, ...next } },
    );
    if (restarted.matchedCount === 1) return { ok: true };

    // 2. 한도 안이면 횟수를 하나 올린다(한 번의 조건부 업데이트)
    if (await this.increment(email, stale, next)) return { ok: true };

    // 3. 처음 시도하는 이메일이면 새로 만든다
    const existing = await this.attempts.findOne({ email }).lean();
    if (!existing) {
      try {
        await this.attempts.create({ email, attempts: 1, ...next });
        return { ok: true };
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // 동시에 다른 요청이 먼저 만들었다. 그 뒤에 이어서 쓸 수 있는지 한 번 더 본다
        if (await this.increment(email, stale, next)) return { ok: true };
      }
    }

    // 4. 한도에 닿았다. 기록을 건드리지 않고(잠금을 늘리지 않고) 남은 시간만 알려 준다
    return { ok: false, retryAfterMs: await this.remaining(email, now) };
  }

  /** 로그인에 성공하면 횟수를 지운다(정상 사용자가 몇 번 틀리고 맞춘 경우) */
  async clear(email: string): Promise<void> {
    await this.attempts.deleteOne({ email });
  }

  private async increment(
    email: string,
    stale: Date,
    next: { lastAttemptAt: Date; expiresAt: Date },
  ): Promise<boolean> {
    const result = await this.attempts.updateOne(
      { email, lastAttemptAt: { $gt: stale }, attempts: { $lt: LOGIN_MAX_ATTEMPTS } },
      { $inc: { attempts: 1 }, $set: next },
    );
    return result.matchedCount === 1;
  }

  /** 잠금이 풀리기까지 남은 시간. 기록이 없어졌거나 이미 풀렸다면 0이다 */
  private async remaining(email: string, now: Date): Promise<number> {
    const doc = await this.attempts.findOne({ email }).lean();
    if (!doc) return 0;
    return Math.max(0, doc.lastAttemptAt.getTime() + LOGIN_LOCK_MS - now.getTime());
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}
