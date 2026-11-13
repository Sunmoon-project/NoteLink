import { Body, Controller, Header, HttpCode, HttpStatus, Post } from '@nestjs/common';

import {
  parsePasswordResetBody,
  parseSendCodeBody,
  parseVerifyCodeBody,
} from './app-login-input.js';
import { AccountRecoveryService } from './account-recovery.service.js';

/**
 * 아이디 찾기 · 비밀번호 재설정(FR-01). 전역 접두사가 붙어 `/api/v1/auth/...` 이 된다(packages/shared PATHS).
 * 인증번호 · 비밀번호가 오가므로 어디에도 저장되지 않게 한다.
 */
@Controller('auth')
export class AccountRecoveryController {
  constructor(private readonly recovery: AccountRecoveryService) {}

  /**
   * 계정 찾기 인증번호를 보낸다. 응답은 204. 가입하지 않은 이메일이어도 응답이 같다(메일로만 알린다).
   * 너무 빨리 다시 보내면 429 RATE_LIMITED + retryAfterSeconds.
   */
  @Post('recovery/send-code')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async sendCode(@Body() body: unknown): Promise<void> {
    await this.recovery.sendCode(parseSendCodeBody(body).email);
  }

  /**
   * 아이디 찾기. 응답: `{ data: { id } }` (아이디 = 가입 이메일, 계정이 없으면 null).
   * 틀리면 400 EMAIL_CODE_INVALID(+ 남은 횟수), 횟수를 다 쓰면 429 EMAIL_CODE_LOCKED.
   */
  @Post('find-id')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  async findId(@Body() body: unknown): Promise<{ data: { id: string | null } }> {
    const { email, code } = parseVerifyCodeBody(body);
    return { data: await this.recovery.findId(email, code) };
  }

  /**
   * 비밀번호 재설정. 응답은 204. 아이디와 이메일이 다르면 400 VALIDATION_FAILED,
   * 인증번호가 틀리면 400 EMAIL_CODE_INVALID. 바꾸면 모든 기기의 로그인을 끊는다.
   */
  @Post('password/reset')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async reset(@Body() body: unknown): Promise<void> {
    const { id, email, code, password } = parsePasswordResetBody(body);
    await this.recovery.resetPassword(id, email, code, password);
  }
}
