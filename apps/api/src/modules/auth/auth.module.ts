import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';

import { createGoogleConfig } from '../../config/google.config.js';
import { createJwtConfig } from '../../config/jwt.config.js';
import { createKakaoConfig } from '../../config/kakao.config.js';
import { createNaverConfig } from '../../config/naver.config.js';
import { optionalProviderConfig } from '../../config/oauth-config.js';
import { MailModule } from '../mail/mail.module.js';
import { AppLoginController } from './app-login/app-login.controller.js';
import { AppLoginService } from './app-login/app-login.service.js';
import { AppSignupService } from './app-login/app-signup.service.js';
import { EmailCodeService } from './app-login/email-code.service.js';
import { EmailProofService } from './app-login/email-proof.service.js';
import { LoginThrottleService } from './app-login/login-throttle.service.js';
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
import { TermsController } from './terms/terms.controller.js';
import { TermsService } from './terms/terms.service.js';
import { JWT_CONFIG, TokenService } from './token.service.js';

@Module({
  imports: [
    // 시크릿과 수명은 토큰마다(access · refresh) 다르므로 기본값 없이 등록하고, TokenService가 호출할 때 넘긴다
    JwtModule.register({}),
    // 인증번호 메일을 보내는 발송 수단(MAIL_SENDER)
    MailModule,
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
  controllers: [AuthTokenController, SocialLoginController, AppLoginController, TermsController],
  providers: [
    // JWT_* 환경변수를 읽고 검증한다. 없거나 잘못되면 서버가 시작할 때 바로 실패한다
    {
      provide: JWT_CONFIG,
      inject: [ConfigService],
      useFactory: createJwtConfig,
    },
    // GOOGLE_* 환경변수를 읽고 검증한다. 일부만 있거나 잘못되면 서버가 시작할 때 바로 실패하고,
    // 하나도 없으면 구글 로그인만 끈다(null, 아래 SOCIAL_PROVIDER_ADAPTERS에서 빠진다)
    {
      provide: GOOGLE_CONFIG,
      inject: [ConfigService],
      useFactory: optionalProviderConfig(
        ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'],
        createGoogleConfig,
      ),
    },
    // KAKAO_* 환경변수도 같은 방식으로 읽고 검증한다
    {
      provide: KAKAO_CONFIG,
      inject: [ConfigService],
      useFactory: optionalProviderConfig(
        ['KAKAO_REST_API_KEY', 'KAKAO_CLIENT_SECRET', 'KAKAO_REDIRECT_URI'],
        createKakaoConfig,
      ),
    },
    // NAVER_* 환경변수도 같은 방식으로 읽고 검증한다
    {
      provide: NAVER_CONFIG,
      inject: [ConfigService],
      useFactory: optionalProviderConfig(
        ['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET', 'NAVER_REDIRECT_URI'],
        createNaverConfig,
      ),
    },
    TokenService,
    EmailCodeService,
    EmailProofService,
    AppSignupService,
    LoginThrottleService,
    AppLoginService,
    JwtAuthGuard,
    // 약관 동의 저장(FR-01-05)
    TermsService,
    GoogleOAuthClient,
    KakaoOAuthClient,
    NaverOAuthClient,
    // 지원하는 소셜 로그인 제공자 목록. 키가 없어 꺼진(설정이 null인) 제공자는 빼서, 등록되지 않은 제공자처럼 거절된다
    // (꺼진 제공자의 클라이언트는 만들어지지만 쓰이지 않는다)
    {
      provide: SOCIAL_PROVIDER_ADAPTERS,
      inject: [
        GoogleOAuthClient,
        KakaoOAuthClient,
        NaverOAuthClient,
        GOOGLE_CONFIG,
        KAKAO_CONFIG,
        NAVER_CONFIG,
      ],
      useFactory: (
        google: GoogleOAuthClient,
        kakao: KakaoOAuthClient,
        naver: NaverOAuthClient,
        ...configs: unknown[]
      ) => [google, kakao, naver].filter((_, i) => configs[i] !== null),
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
