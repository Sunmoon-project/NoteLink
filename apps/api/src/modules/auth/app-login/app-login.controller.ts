import { Body, Controller, Header, HttpCode, HttpStatus, Post } from '@nestjs/common';

import {
  parseLoginBody,
  parseSendCodeBody,
  parseSignupBody,
  parseVerifyCodeBody,
} from './app-login-input.js';
import { type AppLoginResult, AppLoginService } from './app-login.service.js';
import { AppSignupService } from './app-signup.service.js';

/**
 * 앱 자체 가입 · 로그인(이메일). 전역 접두사(api/v1)가 붙어 `/api/v1/auth/email/...` 이 된다(packages/shared PATHS).
 *
 * 가입은 세 단계다: ① 인증번호 받기(send-code) → ② 인증번호 확인(verify-code, 가입 증표를 받는다)
 * → ③ 비밀번호를 정해 가입(signup). 가입을 마치면 로그인(login)으로 이어진다.
 * 모든 응답은 인증번호 · 증표 · 토큰이 오가므로 어디에도 저장되지 않게 한다.
 */
@Controller('auth/email')
export class AppLoginController {
  constructor(
    private readonly signup: AppSignupService,
    private readonly login: AppLoginService,
  ) {}

  /**
   * 가입용 인증번호를 메일로 보낸다. 응답은 204이며 본문이 없다.
   * 이미 가입한 이메일이어도 응답과 발송 제한이 똑같다(가입 여부를 응답으로 알려 주지 않는다).
   * 너무 빨리 다시 보내면 429 RATE_LIMITED + retryAfterSeconds.
   */
  @Post('send-code')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async sendCode(@Body() body: unknown): Promise<void> {
    await this.signup.sendCode(parseSendCodeBody(body).email);
  }

  /**
   * 인증번호를 확인하고 가입 증표를 돌려준다. 증표는 10분 안에 `signup`에 내야 한다.
   * 응답: `{ data: { verificationToken, expiresInSeconds } }`.
   * 틀리면 400 EMAIL_CODE_INVALID(+ 남은 횟수), 횟수를 다 쓰면 429 EMAIL_CODE_LOCKED.
   */
  @Post('verify-code')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async verifyCode(
    @Body() body: unknown,
  ): Promise<{ data: { verificationToken: string; expiresInSeconds: number } }> {
    const { email, code } = parseVerifyCodeBody(body);
    return { data: await this.signup.verifyCode(email, code) };
  }

  /**
   * 인증을 마친 이메일로 비밀번호를 정해 계정을 만든다. 응답은 204이며 토큰을 주지 않는다(로그인은 따로 한다).
   * 이메일은 요청에서 받지 않고 증표 안의 값만 쓴다. 이미 가입했으면 409 EMAIL_TAKEN.
   */
  @Post('signup')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async register(@Body() body: unknown): Promise<void> {
    const { verificationToken, password } = parseSignupBody(body);
    await this.signup.signup(verificationToken, password);
  }

  /**
   * 이메일과 비밀번호로 로그인한다. 응답: `{ data: { accessToken, refreshToken, user } }`.
   * 이메일 또는 비밀번호가 맞지 않으면(계정이 없는 경우 포함) 401 INVALID_CREDENTIALS,
   * 5번 틀려 잠기면 429 LOGIN_LOCKED + retryAfterSeconds.
   */
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async signIn(@Body() body: unknown): Promise<{ data: AppLoginResult }> {
    const { email, password } = parseLoginBody(body);
    return { data: await this.login.login(email, password) };
  }
}
