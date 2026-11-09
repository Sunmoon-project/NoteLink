import { createHmac } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { type JwtConfig } from '../../../config/jwt.config.js';
import { AUTH_CODE_PURPOSES, type AuthCodePurpose } from '../schemas/auth-code.schema.js';
import { JWT_CONFIG } from '../token.service.js';
import { EMAIL_PROOF_TTL_MS } from './email-code.service.js';

/** 증표의 용도 표시(aud). access · refresh 토큰에는 이 값이 없어 서로 대신 쓸 수 없다 */
export const EMAIL_PROOF_AUDIENCE = 'notelink:email-proof';

/** 증표의 서명 알고리즘. 검증할 때도 이것만 허용한다(알고리즘을 바꿔치는 공격과 `none`을 막는다) */
const ALGORITHM = 'HS256';

/** 증표가 담고 있는 내용 */
export interface EmailProofClaims {
  email: string;
  purpose: AuthCodePurpose;
  /** 인증번호 확인에 성공한 시각. 가입 때 "어느 인증"인지 특정하는 데 쓴다(`EmailCodeService.consume`) */
  verifiedAt: Date;
}

export type EmailProofResult =
  | ({ ok: true } & EmailProofClaims)
  /** 수명(10분)이 지났다. 사용자에게 "다시 인증해 달라"고 안내할 수 있다 */
  | { ok: false; reason: 'expired' }
  /** 서명 · 형식 · 용도가 맞지 않는다(위조, 다른 종류의 토큰, 깨진 값) */
  | { ok: false; reason: 'invalid' };

interface RawPayload {
  email?: unknown;
  purpose?: unknown;
  vat?: unknown;
  iat?: unknown;
  exp?: unknown;
}

/**
 * "이 이메일의 주인임을 방금 확인했다"를 증명하는 단기 증표(JWT)를 만들고 검증한다.
 *
 * 인증번호 확인(verify-code)과 가입(signup)은 서로 다른 요청이라, 앞 단계의 결과를 뒷 단계가 믿을 근거가 필요하다.
 * 서명된 증표를 쓰면 클라이언트가 "인증했다"고 주장하는 것이 아니라 서버가 서명한 사실만 전달된다.
 *
 * access · refresh 토큰과 서로 대신 쓸 수 없도록 세 겹으로 나눈다:
 *  1. 서명 키가 다르다(access 비밀값에서 파생한 증표 전용 키)
 *  2. `aud`(용도)를 검증한다
 *  3. `sub`가 없다(access 토큰 검증은 `sub`를 사용자 id로 요구한다)
 */
@Injectable()
export class EmailProofService {
  private readonly secret: string;

  constructor(
    private readonly jwt: JwtService,
    @Inject(JWT_CONFIG) config: JwtConfig,
  ) {
    // 서명 키를 용도별로 파생한다. JWT 라이브러리에는 문자열 비밀값으로 넘긴다
    this.secret = createHmac('sha256', config.accessSecret)
      .update('notelink:email-proof:v1')
      .digest('hex');
  }

  /** 인증에 성공한 이메일의 증표를 만든다. 수명은 10분이다 */
  async issue(claims: EmailProofClaims): Promise<{ token: string; expiresInSeconds: number }> {
    const expiresInSeconds = EMAIL_PROOF_TTL_MS / 1000;
    const token = await this.jwt.signAsync(
      {
        email: claims.email,
        purpose: claims.purpose,
        vat: claims.verifiedAt.getTime(),
      },
      {
        secret: this.secret,
        algorithm: ALGORITHM,
        audience: EMAIL_PROOF_AUDIENCE,
        expiresIn: expiresInSeconds,
      },
    );
    return { token, expiresInSeconds };
  }

  /**
   * 증표를 검증한다. 서명 · 수명 · 용도 · 내용 모양이 모두 맞아야 통과한다.
   * 이 검증은 DB를 읽지 않는다. 한 번만 쓰이게 하는 것은 `EmailCodeService.consume`이 맡는다.
   */
  async verify(token: string): Promise<EmailProofResult> {
    let payload: RawPayload;
    try {
      payload = await this.jwt.verifyAsync<RawPayload>(token, {
        secret: this.secret,
        algorithms: [ALGORITHM],
        audience: EMAIL_PROOF_AUDIENCE,
      });
    } catch (error) {
      return { ok: false, reason: isExpired(error) ? 'expired' : 'invalid' };
    }
    const { email, purpose, vat, iat, exp } = payload;
    // jsonwebtoken은 exp가 없으면 "만료 없음"으로 통과시킨다. 영원히 유효한 증표를 막으려고 수명을 직접 확인한다:
    // 발급 시각(iat)과 만료 시각(exp)이 있어야 하고, 그 간격이 서버가 발급하는 수명(10분)을 넘으면 안 된다
    if (
      typeof iat !== 'number' ||
      typeof exp !== 'number' ||
      !Number.isFinite(iat) ||
      !Number.isFinite(exp) ||
      exp - iat > EMAIL_PROOF_TTL_MS / 1000
    ) {
      return { ok: false, reason: 'invalid' };
    }
    if (
      typeof email !== 'string' ||
      email === '' ||
      typeof purpose !== 'string' ||
      !(AUTH_CODE_PURPOSES as readonly string[]).includes(purpose) ||
      typeof vat !== 'number' ||
      !Number.isSafeInteger(vat) ||
      vat <= 0
    ) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: true, email, purpose: purpose as AuthCodePurpose, verifiedAt: new Date(vat) };
  }
}

/** jsonwebtoken의 만료 오류(TokenExpiredError)인지 본다 */
function isExpired(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'TokenExpiredError'
  );
}
