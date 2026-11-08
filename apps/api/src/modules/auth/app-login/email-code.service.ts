import { createHmac, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type Model } from 'mongoose';

import {
  type AuthCodeDocument,
  type AuthCodePurpose,
  AuthCode,
} from '../schemas/auth-code.schema.js';
import { JWT_CONFIG } from '../token.service.js';
import { generateNumericCode, type RandomInt } from '../../../common/numeric-code.js';
import { type JwtConfig } from '../../../config/jwt.config.js';
import { EMAIL_CODE_LENGTH } from './app-login-input.js';

/** 인증번호가 유효한 시간 */
export const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
/** 한 인증번호에 틀리게 입력할 수 있는 횟수. 6자리는 100만 가지뿐이라 이 한도가 무차별 대입을 막는 핵심이다 */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** 다시 보내기까지 기다려야 하는 시간 */
export const EMAIL_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
/** 발송 횟수를 세는 구간과, 그 구간에 보낼 수 있는 횟수 */
export const EMAIL_CODE_SEND_WINDOW_MS = 60 * 60 * 1000;
export const EMAIL_CODE_MAX_SENDS_PER_WINDOW = 5;

/** Mongo 중복 키 오류 코드(이메일 + 목적 유일 인덱스) */
const DUPLICATE_KEY = 11000;

export type IssueResult =
  /** 인증번호를 만들었다. `code`는 메일로 보낼 원문이며 이 값은 저장되지 않는다 */
  | { ok: true; code: string }
  /** 너무 빨리 다시 보내려 했다 */
  | { ok: false; reason: 'cooldown'; retryAfterMs: number }
  /** 구간 안에서 보낼 수 있는 횟수를 넘었다 */
  | { ok: false; reason: 'limit'; retryAfterMs: number };

export type VerifyResult =
  | { ok: true }
  /** 인증번호가 틀렸다. 남은 시도 횟수를 알려 준다 */
  | { ok: false; reason: 'wrong'; attemptsLeft: number }
  /** 틀리게 입력할 수 있는 횟수를 모두 썼다. 새 인증번호를 받아야 한다 */
  | { ok: false; reason: 'locked' }
  /** 인증번호가 없거나, 만료됐거나, 이미 썼다(셋을 구분해서 알려 주지 않는다) */
  | { ok: false; reason: 'invalid' };

/** 난수 생성기를 바꿔 끼울 때 쓰는 주입 이름. 서버에서는 등록하지 않으므로 공통 기본 구현이 쓰인다 */
export const EMAIL_CODE_RANDOM = 'EMAIL_CODE_RANDOM';

/**
 * 이메일 인증번호를 만들고 확인한다. 메일 발송은 하지 않는다(발송은 호출하는 쪽의 몫이다).
 *
 * 동시에 요청이 몰려도 한도가 지켜지도록, 모든 제한은 "조건이 걸린 한 번의 업데이트"로 처리한다.
 * (읽고 → 판단하고 → 쓰는 식으로 나누면 그 사이에 다른 요청이 끼어들어 한도를 넘길 수 있다)
 */
@Injectable()
export class EmailCodeService {
  private readonly key: Buffer;

  constructor(
    @InjectModel(AuthCode.name) private readonly codes: Model<AuthCodeDocument>,
    @Inject(JWT_CONFIG) config: JwtConfig,
    // 함수 타입은 Nest가 주입 대상으로 알 수 없으므로 이름표를 달고, 등록하지 않아도 되게(Optional) 한다
    @Optional()
    @Inject(EMAIL_CODE_RANDOM)
    private readonly random?: RandomInt,
  ) {
    // JWT 서명 비밀값에서 인증번호 전용 키를 따로 만든다(용도를 섞어 쓰지 않는다)
    this.key = createHmac('sha256', config.accessSecret).update('notelink:email-code:v1').digest();
  }

  /** 인증번호를 새로 만들어 저장한다. 이전 인증번호는 즉시 무효가 된다 */
  async issue(email: string, purpose: AuthCodePurpose): Promise<IssueResult> {
    const now = new Date();
    const code = generateNumericCode(EMAIL_CODE_LENGTH, this.random);
    const fresh = {
      codeHash: this.hash(email, purpose, code),
      attempts: 0,
      expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
      usedAt: null,
      lastSentAt: now,
    };
    const key = { email, purpose };

    // 1. 제한 구간이 끝났으면 횟수를 처음부터 센다
    const restarted = await this.codes.updateOne(
      { ...key, windowEndsAt: { $lte: now } },
      {
        $set: {
          ...fresh,
          sendCount: 1,
          windowEndsAt: new Date(now.getTime() + EMAIL_CODE_SEND_WINDOW_MS),
        },
      },
    );
    if (restarted.matchedCount === 1) return { ok: true, code };

    // 2. 구간 안이면, 간격과 횟수 한도를 지켰을 때만 횟수를 올리며 덮어쓴다(한 번의 조건부 업데이트)
    const resent = await this.codes.updateOne(
      {
        ...key,
        windowEndsAt: { $gt: now },
        lastSentAt: { $lte: new Date(now.getTime() - EMAIL_CODE_RESEND_COOLDOWN_MS) },
        sendCount: { $lt: EMAIL_CODE_MAX_SENDS_PER_WINDOW },
      },
      { $set: fresh, $inc: { sendCount: 1 } },
    );
    if (resent.matchedCount === 1) return { ok: true, code };

    // 3. 처음 보내는 경우 새 문서를 만든다
    const existing = await this.codes.findOne(key).lean();
    if (!existing) {
      try {
        await this.codes.create({
          ...key,
          ...fresh,
          sendCount: 1,
          windowEndsAt: new Date(now.getTime() + EMAIL_CODE_SEND_WINDOW_MS),
        });
        return { ok: true, code };
      } catch (error) {
        // 동시에 다른 요청이 먼저 만들었다. 그 요청이 방금 보냈으니 간격 제한에 걸린 것으로 본다
        if (!isDuplicateKey(error)) throw error;
        return { ok: false, reason: 'cooldown', retryAfterMs: EMAIL_CODE_RESEND_COOLDOWN_MS };
      }
    }

    // 4. 제한에 걸렸다. 무엇에 걸렸는지, 언제 다시 할 수 있는지 알려 준다
    return this.blocked(existing, now);
  }

  /**
   * 입력한 인증번호를 확인한다. 성공하면 그 인증번호는 즉시 쓴 것으로 처리되어 다시 쓸 수 없다.
   *
   * 틀린 횟수를 **비교하기 전에** 먼저 올린다. 비교한 뒤에 올리면 동시에 보낸 추측들이 모두 비교만 되고
   * 횟수가 올라가지 않는 틈이 생긴다. 먼저 올리면 어떤 동시성에서도 비교는 한도 횟수까지만 일어난다.
   */
  async verify(email: string, purpose: AuthCodePurpose, input: string): Promise<VerifyResult> {
    const now = new Date();
    const key = { email, purpose };

    // 시도할 자격을 얻는다: 쓰지 않았고, 만료 전이고, 한도 안인 인증번호의 시도 횟수를 하나 올린다
    const claimed = await this.codes
      .findOneAndUpdate(
        {
          ...key,
          usedAt: null,
          expiresAt: { $gt: now },
          attempts: { $lt: EMAIL_CODE_MAX_ATTEMPTS },
        },
        { $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      )
      .lean();

    if (!claimed) {
      // 자격을 못 얻은 이유가 "한도를 다 씀"인지, 아니면 없음 · 만료 · 이미 씀인지 가린다
      const existing = await this.codes.findOne(key).lean();
      const locked =
        existing !== null &&
        existing.usedAt === null &&
        existing.expiresAt > now &&
        existing.attempts >= EMAIL_CODE_MAX_ATTEMPTS;
      return locked ? { ok: false, reason: 'locked' } : { ok: false, reason: 'invalid' };
    }

    if (!this.matches(email, purpose, input, claimed.codeHash)) {
      const attemptsLeft = Math.max(0, EMAIL_CODE_MAX_ATTEMPTS - claimed.attempts);
      return attemptsLeft === 0
        ? { ok: false, reason: 'locked' }
        : { ok: false, reason: 'wrong', attemptsLeft };
    }

    // 맞았다. 쓴 것으로 표시한다. 같은 인증번호로 동시에 두 번 성공하더라도 한 요청만 통과한다
    const used = await this.codes.updateOne(
      { _id: claimed._id, usedAt: null },
      { $set: { usedAt: now } },
    );
    return used.matchedCount === 1 ? { ok: true } : { ok: false, reason: 'invalid' };
  }

  private blocked(
    existing: { lastSentAt: Date; sendCount: number; windowEndsAt: Date },
    now: Date,
  ): IssueResult {
    const cooldownEndsAt = existing.lastSentAt.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS;
    if (existing.sendCount >= EMAIL_CODE_MAX_SENDS_PER_WINDOW) {
      return {
        ok: false,
        reason: 'limit',
        retryAfterMs: Math.max(0, existing.windowEndsAt.getTime() - now.getTime()),
      };
    }
    return {
      ok: false,
      reason: 'cooldown',
      retryAfterMs: Math.max(0, cooldownEndsAt - now.getTime()),
    };
  }

  /** 이메일과 목적까지 묶어 서명한다: 다른 사람의 인증번호 해시를 내 계정에 옮겨 놓아도 통하지 않는다 */
  private hash(email: string, purpose: AuthCodePurpose, code: string): string {
    return createHmac('sha256', this.key).update(`${purpose}\n${email}\n${code}`).digest('hex');
  }

  /** 시간이 일정한 비교(어디까지 맞았는지가 응답 시간으로 새지 않게 한다) */
  private matches(email: string, purpose: AuthCodePurpose, input: string, storedHash: string) {
    const actual = Buffer.from(this.hash(email, purpose, input), 'hex');
    const expected = Buffer.from(storedHash, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === DUPLICATE_KEY
  );
}
