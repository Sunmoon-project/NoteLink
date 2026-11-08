import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';

import { createGoogleConfig } from '../../config/google.config.js';
import { createJwtConfig } from '../../config/jwt.config.js';
import { createKakaoConfig } from '../../config/kakao.config.js';
import { createNaverConfig } from '../../config/naver.config.js';
import { AppLoginService } from './app-login/app-login.service.js';
import { AppSignupService } from './app-login/app-signup.service.js';
import { EmailCodeService } from './app-login/email-code.service.js';
import { EmailProofService } from './app-login/email-proof.service.js';
import { LoginThrottleService } from './app-login/login-throttle.service.js';
import { createMailSender, MAIL_SENDER } from './app-login/mail-sender.js';
import { AuthTokenController } from './auth-token.controller.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { AuthCode, AuthCodeSchema } from './schemas/auth-code.schema.js';
import { LoginAttempt, LoginAttemptSchema } from './schemas/login-attempt.schema.js';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema.js';
import {
  SocialLoginAttempt,
  SocialLoginAttemptSchema,
} from './schemas/social-login-attempt.schema.js';
import { User, UserSchema } from './schemas/user.schema.js';
import { GoogleOAuthClient } from './social-login/google-oauth.client.js';
import { KakaoOAuthClient } from './social-login/kakao-oauth.client.js';
import { NaverOAuthClient } from './social-login/naver-oauth.client.js';
import { SocialExchangeService } from './social-login/social-exchange.service.js';
import { SocialLoginController } from './social-login/social-login.controller.js';
import {
  GOOGLE_CONFIG,
  KAKAO_CONFIG,
  NAVER_CONFIG,
  SOCIAL_PROVIDER_ADAPTERS,
} from './social-login/social-login.constants.js';
import { SocialLoginService } from './social-login/social-login.service.js';
import { SocialProviderRegistry } from './social-login/social-provider-registry.js';
import { SocialUserService } from './social-login/social-user.service.js';
import { JWT_CONFIG, TokenService } from './token.service.js';

@Module({
  imports: [
    // 시크릿과 수명은 토큰마다(access · refresh) 다르므로 기본값 없이 등록하고, TokenService가 호출할 때 넘긴다
    JwtModule.register({}),
    MongooseModule.forFeature([
      // refresh_tokens 컬렉션
      { name: RefreshToken.name, schema: RefreshTokenSchema },
      // auth_codes 컬렉션(이메일로 보낸 6자리 인증번호)
      { name: AuthCode.name, schema: AuthCodeSchema },
      // login_attempts 컬렉션(이메일 로그인 시도 횟수 제한)
      { name: LoginAttempt.name, schema: LoginAttemptSchema },
      // social_login_attempts 컬렉션(소셜 로그인 진행 상태)
      { name: SocialLoginAttempt.name, schema: SocialLoginAttemptSchema },
      // users 컬렉션(소셜 로그인으로 사용자를 찾거나 만든다)
      { name: User.name, schema: UserSchema },
    ]),
  ],
  controllers: [AuthTokenController, SocialLoginController],
  providers: [
    // JWT_* 환경변수를 읽고 검증한다. 없거나 잘못되면 서버가 시작할 때 바로 실패한다
    {
      provide: JWT_CONFIG,
      inject: [ConfigService],
      useFactory: createJwtConfig,
    },
    // GOOGLE_* 환경변수를 읽고 검증한다. 마찬가지로 서버가 시작할 때 바로 실패한다
    {
      provide: GOOGLE_CONFIG,
      inject: [ConfigService],
      useFactory: createGoogleConfig,
    },
    // KAKAO_* 환경변수도 같은 방식으로 읽고 검증한다
    {
      provide: KAKAO_CONFIG,
      inject: [ConfigService],
      useFactory: createKakaoConfig,
    },
    // NAVER_* 환경변수도 같은 방식으로 읽고 검증한다
    {
      provide: NAVER_CONFIG,
      inject: [ConfigService],
      useFactory: createNaverConfig,
    },
    TokenService,
    // 인증번호 메일 발송 수단. MAIL_TRANSPORT=log(개발 전용)일 때만 로그로 남기고, 그 밖에는 발송을 거부한다
    {
      provide: MAIL_SENDER,
      inject: [ConfigService],
      useFactory: createMailSender,
    },
    EmailCodeService,
    EmailProofService,
    AppSignupService,
    LoginThrottleService,
    AppLoginService,
    JwtAuthGuard,
    GoogleOAuthClient,
    KakaoOAuthClient,
    NaverOAuthClient,
    // 지원하는 소셜 로그인 제공자 목록
    {
      provide: SOCIAL_PROVIDER_ADAPTERS,
      inject: [GoogleOAuthClient, KakaoOAuthClient, NaverOAuthClient],
      useFactory: (google: GoogleOAuthClient, kakao: KakaoOAuthClient, naver: NaverOAuthClient) => [
        google,
        kakao,
        naver,
      ],
    },
    SocialProviderRegistry,
    SocialUserService,
    SocialLoginService,
    SocialExchangeService,
  ],
  // 이메일 · 소셜 로그인이 같은 토큰 발급 로직을 쓰고, 다른 모듈이 JwtAuthGuard로 요청을 인증할 수 있도록 내보낸다
  exports: [TokenService, JwtAuthGuard],
})
export class AuthModule {}
