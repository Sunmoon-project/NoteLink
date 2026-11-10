import type { MongooseModuleOptions } from '@nestjs/mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SmtpMailSender } from '../src/modules/mail/smtp-mail-sender.js';
import { AppLoginService } from '../src/modules/auth/app-login/app-login.service.js';
import { AppSignupService } from '../src/modules/auth/app-login/app-signup.service.js';
import { LoginThrottleService } from '../src/modules/auth/app-login/login-throttle.service.js';
import { EmailCodeService } from '../src/modules/auth/app-login/email-code.service.js';
import {
  MAIL_SENDER,
  type MailSender,
  MailUnavailableError,
} from '../src/modules/mail/mail-sender.js';
import { EmailProofService } from '../src/modules/auth/app-login/email-proof.service.js';
import { GoogleOAuthClient } from '../src/modules/auth/social-login/google-oauth.client.js';
import { KakaoOAuthClient } from '../src/modules/auth/social-login/kakao-oauth.client.js';
import { NaverOAuthClient } from '../src/modules/auth/social-login/naver-oauth.client.js';
import {
  GOOGLE_CONFIG,
  KAKAO_CONFIG,
  NAVER_CONFIG,
} from '../src/modules/auth/social-login/social-login.constants.js';
import { SocialLoginService } from '../src/modules/auth/social-login/social-login.service.js';
import { SocialProviderRegistry } from '../src/modules/auth/social-login/social-provider-registry.js';
import { JWT_CONFIG, TokenService } from '../src/modules/auth/token.service.js';
import { TEST_ENV, createAppModuleBuilder, stubAppEnv } from './support/app-module.js';

// @nestjs/mongoose가 내부에서 쓰는 설정 provider 이름(공개 상수가 아님)
const MONGOOSE_MODULE_OPTIONS = 'MongooseModuleOptions';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** 메일을 SMTP로 보내는 설정(값은 전부 가짜). 조립만 확인하므로 실제 서버에 접속하지 않는다 */
const SMTP_ENV = {
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'noreply@example.com',
  SMTP_PASS: 'fake-app-password',
  MAIL_FROM: 'noreply@example.com',
};

describe('AppModule의 MongoDB 설정', () => {
  it('환경변수 MONGODB_URI를 MongoDB 설정의 uri로 넘긴다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const options = moduleRef.get<MongooseModuleOptions>(MONGOOSE_MODULE_OPTIONS, {
      strict: false,
    });
    await moduleRef.close();

    expect(options).toEqual({ uri: TEST_ENV.MONGODB_URI });
  });

  it('MONGODB_URI가 비어 있으면 DB 연결 전에 조립 단계에서 실패한다', async () => {
    // 빈 값으로 두면 로컬 .env 파일의 값이 덮어쓰지 않는다(이미 설정된 환경변수가 우선)
    stubAppEnv({ MONGODB_URI: '' });

    await expect(createAppModuleBuilder().compile()).rejects.toThrow('MONGODB_URI');
  });
});

describe('AppModule의 JWT 설정', () => {
  it('JWT_* 환경변수를 읽어 TokenService가 쓸 설정으로 만든다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const config = moduleRef.get(JWT_CONFIG, { strict: false });
    const tokenService = moduleRef.get(TokenService, { strict: false });
    await moduleRef.close();

    expect(config).toEqual({
      accessSecret: TEST_ENV.JWT_ACCESS_SECRET,
      refreshSecret: TEST_ENV.JWT_REFRESH_SECRET,
      accessTTL: '15m',
      refreshTTL: '14d',
    });
    expect(tokenService).toBeInstanceOf(TokenService);
  });

  it.each(['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'JWT_ACCESS_TTL', 'JWT_REFRESH_TTL'])(
    '%s가 비어 있으면 서버 조립 단계에서 실패한다',
    async (key) => {
      stubAppEnv({ [key]: '' });

      await expect(createAppModuleBuilder().compile()).rejects.toThrow(key);
    },
  );
});

describe('AppModule의 구글 로그인 설정', () => {
  it('GOOGLE_* 환경변수를 읽어 SocialLoginService가 쓸 설정으로 만든다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const config = moduleRef.get(GOOGLE_CONFIG, { strict: false });
    const service = moduleRef.get(SocialLoginService, { strict: false });
    await moduleRef.close();

    expect(config).toEqual({
      clientId: TEST_ENV.GOOGLE_CLIENT_ID,
      clientSecret: TEST_ENV.GOOGLE_CLIENT_SECRET,
      redirectUri: TEST_ENV.GOOGLE_REDIRECT_URI,
    });
    expect(service).toBeInstanceOf(SocialLoginService);
  });

  it.each(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI'])(
    '%s가 비어 있으면 서버 조립 단계에서 실패한다',
    async (key) => {
      stubAppEnv({ [key]: '' });

      await expect(createAppModuleBuilder().compile()).rejects.toThrow(key);
    },
  );

  it('리디렉션 주소가 구글 콜백 경로가 아니면 서버 조립 단계에서 실패한다', async () => {
    stubAppEnv({ GOOGLE_REDIRECT_URI: 'https://notelink.app/api/v1/auth/social/twitter/callback' });

    await expect(createAppModuleBuilder().compile()).rejects.toThrow('GOOGLE_REDIRECT_URI');
  });
});

describe('AppModule의 카카오 로그인 설정', () => {
  it('KAKAO_* 환경변수를 읽어 어댑터가 쓸 설정으로 만든다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const config = moduleRef.get(KAKAO_CONFIG, { strict: false });
    const registry = moduleRef.get(SocialProviderRegistry, { strict: false });
    await moduleRef.close();

    expect(config).toEqual({
      restApiKey: TEST_ENV.KAKAO_REST_API_KEY,
      clientSecret: TEST_ENV.KAKAO_CLIENT_SECRET,
      redirectUri: TEST_ENV.KAKAO_REDIRECT_URI,
    });
    expect(registry.find('kakao')).toBeInstanceOf(KakaoOAuthClient);
    expect(registry.find('google')).toBeInstanceOf(GoogleOAuthClient);
  });

  it.each(['KAKAO_REST_API_KEY', 'KAKAO_CLIENT_SECRET', 'KAKAO_REDIRECT_URI'])(
    '%s가 비어 있으면 서버 조립 단계에서 실패한다',
    async (key) => {
      stubAppEnv({ [key]: '' });

      await expect(createAppModuleBuilder().compile()).rejects.toThrow(key);
    },
  );

  it('리다이렉트 주소가 카카오 콜백 경로가 아니면 서버 조립 단계에서 실패한다', async () => {
    stubAppEnv({ KAKAO_REDIRECT_URI: 'https://notelink.app/api/v1/auth/social/google/callback' });

    await expect(createAppModuleBuilder().compile()).rejects.toThrow('KAKAO_REDIRECT_URI');
  });
});

describe('AppModule의 네이버 로그인 설정', () => {
  it('NAVER_* 환경변수를 읽어 어댑터가 쓸 설정으로 만든다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const config = moduleRef.get(NAVER_CONFIG, { strict: false });
    const registry = moduleRef.get(SocialProviderRegistry, { strict: false });
    await moduleRef.close();

    expect(config).toEqual({
      clientId: TEST_ENV.NAVER_CLIENT_ID,
      clientSecret: TEST_ENV.NAVER_CLIENT_SECRET,
      redirectUri: TEST_ENV.NAVER_REDIRECT_URI,
    });
    expect(registry.find('naver')).toBeInstanceOf(NaverOAuthClient);
    expect(registry.find('kakao')).toBeInstanceOf(KakaoOAuthClient);
    expect(registry.find('google')).toBeInstanceOf(GoogleOAuthClient);
  });

  it.each(['NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET', 'NAVER_REDIRECT_URI'])(
    '%s가 비어 있으면 서버 조립 단계에서 실패한다',
    async (key) => {
      stubAppEnv({ [key]: '' });

      await expect(createAppModuleBuilder().compile()).rejects.toThrow(key);
    },
  );

  it('리다이렉트 주소가 네이버 콜백 경로가 아니면 서버 조립 단계에서 실패한다', async () => {
    stubAppEnv({ NAVER_REDIRECT_URI: 'https://notelink.app/api/v1/auth/social/google/callback' });

    await expect(createAppModuleBuilder().compile()).rejects.toThrow('NAVER_REDIRECT_URI');
  });
});

describe('AppModule의 앱 로그인(이메일 인증번호)', () => {
  it('서버를 조립하면 EmailCodeService가 만들어진다 (생성자 인자를 Nest가 모두 해결할 수 있다)', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const service = moduleRef.get(EmailCodeService, { strict: false });
    await moduleRef.close();

    expect(service).toBeInstanceOf(EmailCodeService);
  });

  it('서버를 조립하면 AppSignupService가 만들어진다 (메일 발송 · 비밀번호 비용 등 모든 의존성을 Nest가 해결한다)', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const service = moduleRef.get(AppSignupService, { strict: false });
    await moduleRef.close();

    expect(service).toBeInstanceOf(AppSignupService);
  });

  it('서버를 조립하면 AppLoginService가 만들어진다 (비밀번호 비용을 등록하지 않아도 기본값으로 동작)', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const service = moduleRef.get(AppLoginService, { strict: false });
    await moduleRef.close();

    expect(service).toBeInstanceOf(AppLoginService);
  });

  it('서버를 조립하면 LoginThrottleService가 만들어지고 AppLoginService가 이를 받아 쓴다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();

    const throttle = moduleRef.get(LoginThrottleService, { strict: false });
    const login = moduleRef.get(AppLoginService, { strict: false });
    await moduleRef.close();

    expect(throttle).toBeInstanceOf(LoginThrottleService);
    expect((login as unknown as { throttle: unknown }).throttle).toBe(throttle);
  });

  it('MAIL_TRANSPORT가 없으면 서버는 뜨지만 메일 발송 수단은 발송을 거부한다 (운영 기본값)', async () => {
    stubAppEnv({ MAIL_TRANSPORT: '' });
    const moduleRef = await createAppModuleBuilder().compile();
    const mail = moduleRef.get<MailSender>(MAIL_SENDER, { strict: false });
    await moduleRef.close();

    await expect(mail.sendVerificationCode('a@b.com', '123456')).rejects.toThrow(
      MailUnavailableError,
    );
  });

  it('MAIL_TRANSPORT=log이면 메일 발송 수단이 개발용 로그 발송이 된다', async () => {
    stubAppEnv({ MAIL_TRANSPORT: 'log' });
    const moduleRef = await createAppModuleBuilder().compile();
    const mail = moduleRef.get<MailSender>(MAIL_SENDER, { strict: false });
    await moduleRef.close();

    await expect(mail.sendVerificationCode('a@b.com', '123456')).resolves.toBeUndefined();
  });

  it('MAIL_TRANSPORT=smtp이면 메일 발송 수단이 SMTP 발송이 된다 (접속 없이 조립만 확인)', async () => {
    stubAppEnv(SMTP_ENV);
    const moduleRef = await createAppModuleBuilder().compile();
    const mail = moduleRef.get<MailSender>(MAIL_SENDER, { strict: false });
    await moduleRef.close();

    expect(mail).toBeInstanceOf(SmtpMailSender);
  });

  it.each(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'])(
    'MAIL_TRANSPORT=smtp인데 %s가 비어 있으면 서버 조립 단계에서 실패한다',
    async (key) => {
      stubAppEnv({ ...SMTP_ENV, [key]: '' });

      await expect(createAppModuleBuilder().compile()).rejects.toThrow(key);
    },
  );

  it('서버를 조립하면 EmailProofService도 만들어지고, 실제 비밀값으로 증표를 발급 · 검증한다', async () => {
    stubAppEnv();
    const moduleRef = await createAppModuleBuilder().compile();
    const proof = moduleRef.get(EmailProofService, { strict: false });
    await moduleRef.close();

    const claims = { email: 'a@b.com', purpose: 'signup' as const, verifiedAt: new Date() };
    const { token } = await proof.issue(claims);

    expect(await proof.verify(token)).toMatchObject({ ok: true, email: 'a@b.com' });
  });
});
