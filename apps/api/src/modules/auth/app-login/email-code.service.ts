import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

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
/**
 * 목적별 발송 한도. 계정 찾기(비밀번호 재설정까지 이어짐)는 가입보다 훨씬 좁게 둔다:
 * 인증번호를 계속 다시 받아 맞혀 보는 공격은 「구간당 발송 수 × 인증번호당 시도 수」번까지만 추측할 수 있다.
 * 가입(1시간 5번)이면 하루 600번이지만, 계정 찾기(하루 3번)는 하루 15번이다.
 */
export const EMAIL_CODE_SEND_POLICY: Record<
  AuthCodePurpose,
  { windowMs: number; maxSends: number }
> = {
  signup: { windowMs: EMAIL_CODE_SEND_WINDOW_MS, maxSends: EMAIL_CODE_MAX_SENDS_PER_WINDOW },
  recovery: { windowMs: 24 * 60 * 60 * 1000, maxSends: 3 },
};
/**
 * 인증에 성공한 뒤 가입을 끝낼 수 있는 시간(인증 증표의 수명). 이 시간 동안은 인증번호 기록이 남아 있어야 하므로,
 * 인증에 성공하면 기록의 보관 기한(retainUntil)이 이보다 일찍 끝나지 않게 늘린다.
 */
export const EMAIL_PROOF_TTL_MS = 10 * 60 * 1000;

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
  /** 성공. `verifiedAt`은 인증에 성공한 시각이며, 인증 증표에 담겨 가입 때 이 인증을 특정하는 데 쓰인다 */
  | { ok: true; verifiedAt: Date }
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
 * 문서에는 서로 다른 시각이 세 개 있다. 섞어 쓰면 안 된다.
 * - `expiresAt`: 인증번호를 쓸 수 있는 마지막 시각(발송 + 10분)
 * - `windowEndsAt`: 발송 횟수를 세는 제한 구간의 끝(구간 시작 + 1시간). 재발송해도 늘어나지 않는다
 * - `retainUntil`: MongoDB가 문서를 지우는 시각. 위 둘과 인증 증표 수명 중 가장 늦은 때까지 문서를 남긴다
 *
 * 발송할 때마다 `issueId`가 새로 정해진다. 확인(verify)이 비교를 끝내고 "썼다"고 표시하기 전에
 * 재발급이 끼어들면, 표시 조건의 `issueId`가 달라져 이전 발급의 확인이 새 발급을 쓴 것으로 만들지 못한다.
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
      issueId: randomUUID(),
      codeHash: this.hash(email, purpose, code),
      attempts: 0,
      expiresAt: new Date(now.getTime() + EMAIL_CODE_TTL_MS),
      usedAt: null,
      consumedAt: null,
      lastSentAt: now,
    };
    const key = { email, purpose };
    const cooledDown = { $lte: new Date(now.getTime() - EMAIL_CODE_RESEND_COOLDOWN_MS) };
    const policy = EMAIL_CODE_SEND_POLICY[purpose];
    const newWindowEnd = new Date(now.getTime() + policy.windowMs);

    // 1. 제한 구간이 끝났으면 횟수를 처음부터 센다. 구간이 끝났어도 마지막 발송 뒤 간격은 지켜야 한다
    //    (구간 끝 직전에 보낸 직후 새 구간으로 넘어가며 간격 제한을 피하지 못하게 한다)
    const restarted = await this.codes.updateOne(
      { ...key, windowEndsAt: { $lte: now }, lastSentAt: cooledDown },
      {
        $set: {
          ...fresh,
          sendCount: 1,
          windowEndsAt: newWindowEnd,
          // 새 구간의 끝이 번호 만료(10분 뒤)보다 늦으므로 보관 기한은 구간 끝과 같다
          retainUntil: newWindowEnd,
        },
      },
    );
    if (restarted.matchedCount === 1) return { ok: true, code };

    // 2. 구간 안이면, 간격과 횟수 한도를 지켰을 때만 횟수를 올리며 덮어쓴다(한 번의 조건부 업데이트)
    //    구간 끝(windowEndsAt)은 그대로 두고, 늘어난 번호 만료 시각까지 문서가 남도록 보관 기한만 늘린다
    const resent = await this.codes.updateOne(
      {
        ...key,
        windowEndsAt: { $gt: now },
        lastSentAt: cooledDown,
        sendCount: { $lt: policy.maxSends },
      },
      { $set: fresh, $inc: { sendCount: 1 }, $max: { retainUntil: fresh.expiresAt } },
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
          windowEndsAt: newWindowEnd,
          retainUntil: newWindowEnd,
        });
        return { ok: true, code };
      } catch (error) {
        // 동시에 다른 요청이 먼저 만들었다. 그 요청이 방금 보냈으니 간격 제한에 걸린 것으로 본다
        if (!isDuplicateKey(error)) throw error;
        return { ok: false, reason: 'cooldown', retryAfterMs: EMAIL_CODE_RESEND_COOLDOWN_MS };
      }
    }

    // 4. 제한에 걸렸다. 무엇에 걸렸는지, 언제 다시 할 수 있는지 알려 준다
    return this.blocked(existing, now, policy.maxSends);
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
    // 비교한 그 발급(issueId)일 때만 표시한다: 비교와 표시 사이에 재발급이 끼어들었다면 이미 새 발급이므로
    // 이전 번호의 성공이 새 번호를 쓴 것으로 만들면 안 된다
    // 가입을 끝낼 때까지 기록이 지워지지 않도록 보관 기한도 함께 늘린다($max: 더 늦은 쪽만 반영)
    const used = await this.codes.updateOne(
      { _id: claimed._id, issueId: claimed.issueId, usedAt: null },
      {
        $set: { usedAt: now },
        $max: { retainUntil: new Date(now.getTime() + EMAIL_PROOF_TTL_MS) },
      },
    );
    return used.matchedCount === 1
      ? { ok: true, verifiedAt: now }
      : { ok: false, reason: 'invalid' };
  }

  /**
   * 인증 증표를 써서 가입을 끝낸 것으로 표시한다. 한 인증에 대해 한 번만 성공한다.
   * 증표가 가리키는 인증(`verifiedAt`)이 가장 최근의 인증이고 아직 쓰지 않았을 때만 성공하므로,
   * 인증번호를 다시 받았다면(새 인증으로 덮어쓰임) 이전 증표는 쓸 수 없다.
   */
  async consume(email: string, purpose: AuthCodePurpose, verifiedAt: Date): Promise<boolean> {
    const result = await this.codes.updateOne(
      { email, purpose, usedAt: verifiedAt, consumedAt: null },
      { $set: { consumedAt: new Date() } },
    );
    return result.matchedCount === 1;
  }

  private blocked(
    existing: { lastSentAt: Date; sendCount: number; windowEndsAt: Date },
    now: Date,
    maxSends: number,
  ): IssueResult {
    const cooldownEndsAt = existing.lastSentAt.getTime() + EMAIL_CODE_RESEND_COOLDOWN_MS;
    // 구간이 이미 끝났다면 횟수 한도는 더 이상 적용되지 않는다. 남은 건 마지막 발송 뒤 간격뿐이다
    const windowActive = existing.windowEndsAt.getTime() > now.getTime();
    if (windowActive && existing.sendCount >= maxSends) {
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
