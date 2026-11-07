import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';

import type { GoogleConfig } from '../../../config/google.config.js';
import {
  SocialLoginAttempt,
  type SocialLoginAttemptDocument,
} from '../schemas/social-login-attempt.schema.js';
import { type AppRedirectError, buildAppRedirect } from './app-redirect.js';
import { buildGoogleAuthUrl } from './google-auth-url.js';
import type { GoogleCallbackParams } from './google-callback-query.js';
import { GoogleOAuthClient } from './google-oauth.client.js';
import {
  ATTEMPT_TTL_MS,
  CALLBACK_PROCESSING_MARGIN_MS,
  CODE_TTL_MS,
  GOOGLE_CONFIG,
} from './social-login.constants.js';
import { SocialProviderError } from './social-provider.js';
import { VALIDATION_FAILED } from './social-start-query.js';
import type { SocialStartParams } from './social-start-query.js';
import { SocialUserService } from './social-user.service.js';

/** 1회용 코드는 원문 대신 해시를 저장한다. DB가 유출돼도 코드를 그대로 쓸 수 없다 */
export function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

@Injectable()
export class SocialLoginService {
  private readonly logger = new Logger(SocialLoginService.name);

  constructor(
    @Inject(GOOGLE_CONFIG) private readonly google: GoogleConfig,
    @InjectModel(SocialLoginAttempt.name)
    private readonly attempts: Model<SocialLoginAttemptDocument>,
    private readonly googleClient: GoogleOAuthClient,
    private readonly users: SocialUserService,
  ) {}

  /**
   * 구글 로그인을 시작한다. 로그인 시도를 저장하고, 사용자를 보낼 구글 로그인 주소를 돌려준다.
   * 앱이 보낸 state · code_challenge는 구글에 보내지 않고 서버에만 보관한다.
   */
  async startGoogle(params: SocialStartParams): Promise<string> {
    // 구글 구간용 state는 앱이 보낸 값과 별개로 서버가 새로 만든다(추측할 수 없는 32바이트)
    const oauthState = randomBytes(32).toString('base64url');
    await this.attempts.create({
      provider: 'google',
      oauthState,
      appState: params.appState,
      codeChallenge: params.codeChallenge,
      expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS),
    });
    return buildGoogleAuthUrl(this.google, oauthState);
  }

  /**
   * 구글이 사용자를 돌려보낸 콜백을 처리한다. 브라우저를 보낼 주소(`notelink://auth/callback?...`)를 돌려준다.
   * 앱으로 돌려보낼 수 없는 경우(state로 로그인 시도를 못 찾음 = 만료 · 이미 처리됨 · 가짜 콜백)에는
   * 앱 state를 알 수 없으므로 400을 던진다.
   */
  async handleGoogleCallback(params: GoogleCallbackParams): Promise<string> {
    // 1. 로그인 시도를 찾으면서 동시에 점유한다. 같은 콜백이 두 번 와도(새로고침 · 동시 요청) 한 번만 처리된다.
    //    점유는 "코드 해시 자리에 임시 표시를 채우는 것"으로 하고, 처리가 끝나면 진짜 해시로 바꾼다.
    const code = randomBytes(32).toString('base64url');
    const attempt = await this.attempts.findOneAndUpdate(
      {
        provider: 'google',
        oauthState: params.oauthState,
        codeHash: null,
        // 점유한 뒤 구글 호출과 사용자 처리를 하는 동안 만료되지 않도록 여유를 두고 점유한다
        expiresAt: { $gt: new Date(Date.now() + CALLBACK_PROCESSING_MARGIN_MS) },
      },
      { codeHash: hashCode(code) },
    );
    if (!attempt) {
      throw new BadRequestException({
        code: VALIDATION_FAILED,
        message: '로그인 시간이 지났거나 이미 처리된 요청이에요. 앱으로 돌아가 다시 시도해 주세요',
      });
    }
    const appState = attempt.appState;
    const back = (error: AppRedirectError) =>
      this.fail({ _id: attempt._id, codeHash: hashCode(code) }, appState, error);

    // 2. 사용자가 구글 화면에서 취소했거나 코드를 받지 못했다
    if (params.error !== null)
      return back(params.error === 'access_denied' ? 'access_denied' : 'invalid_code');
    if (params.code === null) return back('invalid_code');

    try {
      // 3. 구글에서 사용자 정보를 받고, 우리 사용자를 찾거나 만든다
      const profile = await this.googleClient.fetchProfile(params.code);
      const result = await this.users.findOrCreate('google', profile);

      // 4. 결과를 기록하고 코드의 수명을 짧게 줄인다. 이제부터 앱이 코드를 교환할 수 있다
      //    내가 점유한 문서(codeHash가 내 코드의 해시)에만 쓰고, 실제로 반영됐는지 확인한다.
      //    그사이 문서가 사라졌다면(만료 · 삭제) 앱이 교환할 수 없는 코드를 내주지 않는다
      const saved = await this.attempts.updateOne(
        { _id: attempt._id, codeHash: hashCode(code) },
        {
          outcome: result.kind,
          userId: result.kind === 'signed_in' ? result.userId : null,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        },
      );
      if (saved.matchedCount !== 1) {
        this.logger.warn('구글 콜백: 결과를 저장하려는 로그인 시도가 사라졌습니다(만료 또는 삭제)');
        return back('invalid_code');
      }
      return buildAppRedirect({ code, state: appState });
    } catch (error) {
      if (error instanceof SocialProviderError) {
        // 운영자가 원인을 알 수 있게 남긴다. 메시지에는 상태 코드만 있고 코드 · 토큰 · 시크릿은 없다.
        // (client_secret이 틀리면 구글이 401을 주고, 사용자에게는 unavailable로 보인다)
        this.logger.warn(`구글 로그인 실패 (${error.reason}): ${error.message}`);
        return back(error.reason);
      }
      // 오류 내용(코드 · 토큰이 들어 있을 수 있다)은 앱에 보내지 않고 서버 로그에만 남긴다
      this.logger.error(
        '구글 콜백 처리 중 예상하지 못한 오류',
        error instanceof Error ? error.stack : undefined,
      );
      return back('server_error');
    }
  }

  /** 실패한 시도는 지워서 점유해 둔 코드가 쓰이지 못하게 하고, 앱에는 오류를 돌려준다 */
  private async fail(
    mine: { _id: Types.ObjectId; codeHash: string },
    appState: string,
    error: AppRedirectError,
  ): Promise<string> {
    try {
      // 내가 점유한 문서(코드 해시가 내 것)만 지운다. 점유가 다른 쪽으로 넘어간 문서는 건드리지 않는다
      await this.attempts.deleteOne({ _id: mine._id, codeHash: mine.codeHash });
    } catch {
      // 지우지 못해도 코드는 앱에 내주지 않았으므로 쓰일 수 없고, 만료되면 사라진다
    }
    return buildAppRedirect({ error, state: appState });
  }
}
