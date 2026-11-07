import { randomBytes } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import type { GoogleConfig } from '../../../config/google.config.js';
import {
  SocialLoginAttempt,
  type SocialLoginAttemptDocument,
} from '../schemas/social-login-attempt.schema.js';
import { buildGoogleAuthUrl } from './google-auth-url.js';
import { ATTEMPT_TTL_MS, GOOGLE_CONFIG } from './social-login.constants.js';
import type { SocialStartParams } from './social-start-query.js';

@Injectable()
export class SocialLoginService {
  constructor(
    @Inject(GOOGLE_CONFIG) private readonly google: GoogleConfig,
    @InjectModel(SocialLoginAttempt.name)
    private readonly attempts: Model<SocialLoginAttemptDocument>,
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
}
