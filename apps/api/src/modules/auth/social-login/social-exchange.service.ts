import { createHash, timingSafeEqual } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  SocialLoginAttempt,
  type SocialLoginAttemptDocument,
} from '../schemas/social-login-attempt.schema.js';
import { User, type UserDocument } from '../schemas/user.schema.js';
import { type AppUser, toAppUser } from '../to-app-user.js';
import { TokenService } from '../token.service.js';
import type { SocialExchangeParams } from './social-exchange-body.js';
import { NOT_FOUND } from './social-login.constants.js';
import { hashCode } from './social-login.service.js';
import { SocialProviderRegistry } from './social-provider-registry.js';
import { VALIDATION_FAILED } from './social-start-query.js';

/** 이메일이 겹쳐 합치지 못할 때의 오류 코드. 앱이 다음 단계(합칠까요?)에서 이 코드로 분기한다 */
export const ACCOUNT_EXISTS = 'ACCOUNT_EXISTS';

/**
 * 계정이 있는지 단정하지 않고, 이메일 주소와 가입 방법도 알려 주지 않는 문구.
 * 로그인에 성공한 본인에게만 보이지만 가입 여부를 확정해 주지 않도록 조건문으로 쓴다.
 */
export const ACCOUNT_EXISTS_MESSAGE =
  '이 이메일로 가입한 계정이 있다면 처음 가입한 방법으로 로그인해 주세요';

/** 코드가 없는 이유(없음 · 만료 · 이미 씀 · PKCE 불일치)를 구분하지 않고 같은 응답을 준다 */
const INVALID_CODE_MESSAGE = '간편 로그인을 마치지 못했어요. 다시 시도해 주세요';

/** 로그인 응답: `{ data }` 로 감싸기 전의 내용(packages/shared AuthTokens) */
export interface SocialLoginResult {
  accessToken: string;
  refreshToken: string;
  user: AppUser;
}

/** PKCE(S256): SHA-256(codeVerifier)의 base64url 이 로그인을 시작할 때 보낸 code_challenge 와 같아야 한다 */
export function matchesChallenge(codeVerifier: string, codeChallenge: string): boolean {
  const actual = Buffer.from(createHash('sha256').update(codeVerifier).digest('base64url'));
  const expected = Buffer.from(codeChallenge);
  // 길이가 다르면 timingSafeEqual 이 던지므로 먼저 거른다. 비교 시간으로 값을 추측하지 못하게 일정 시간 비교를 쓴다
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** 앱이 들고 온 1회용 코드를 토큰으로 바꾼다(소셜 로그인의 마지막 단계) */
@Injectable()
export class SocialExchangeService {
  constructor(
    private readonly providers: SocialProviderRegistry,
    @InjectModel(SocialLoginAttempt.name)
    private readonly attempts: Model<SocialLoginAttemptDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly tokens: TokenService,
  ) {}

  async exchange(providerName: string, params: SocialExchangeParams): Promise<SocialLoginResult> {
    const provider = this.providers.find(providerName);
    if (!provider) {
      throw new NotFoundException({ code: NOT_FOUND, message: '지원하지 않는 로그인 방식이에요' });
    }
    // 1. 코드를 찾으면서 동시에 지운다. 코드는 한 번만 쓸 수 있고, 아래에서 PKCE가 틀려도 이미 소모되어
    //    코드를 가로챈 쪽이 codeVerifier를 여러 번 추측해 볼 수 없다. 만료된 코드는 찾지 못한다
    const attempt = await this.attempts.findOneAndDelete({
      provider: provider.name,
      codeHash: hashCode(params.code),
      expiresAt: { $gt: new Date() },
    });
    if (!attempt || !matchesChallenge(params.codeVerifier, attempt.codeChallenge)) {
      throw new BadRequestException({ code: VALIDATION_FAILED, message: INVALID_CODE_MESSAGE });
    }

    // 2. 이메일이 겹쳐 계정을 만들지 않은 로그인. 합치지 않고 안내만 한다
    if (attempt.outcome === 'account_exists') {
      throw new ConflictException({ code: ACCOUNT_EXISTS, message: ACCOUNT_EXISTS_MESSAGE });
    }
    if (attempt.outcome !== 'signed_in' || attempt.userId === null) {
      throw new BadRequestException({ code: VALIDATION_FAILED, message: INVALID_CODE_MESSAGE });
    }

    // 3. 사용자를 다시 읽는다. 콜백과 교환 사이(최대 2분)에 탈퇴했을 수 있어 탈퇴한 사용자는 막는다
    const user = await this.users.findOne({ _id: attempt.userId, deletedAt: null });
    if (!user) {
      throw new BadRequestException({ code: VALIDATION_FAILED, message: INVALID_CODE_MESSAGE });
    }

    // 4. 토큰을 발급한다(기기마다 refresh 토큰이 한 줄씩 생긴다)
    // 세션 버전은 방금 읽은 사용자의 값을 쓴다(TokenService.assertActive)
    const { accessToken, refreshToken } = await this.tokens.issue(
      String(user._id),
      undefined,
      undefined,
      undefined,
      user.sessionVersion ?? 0,
    );
    return { accessToken, refreshToken, user: toAppUser(user) };
  }
}
