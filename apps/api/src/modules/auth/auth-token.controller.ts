import { Body, Controller, Header, HttpCode, HttpStatus, Post } from '@nestjs/common';

import { parseRefreshBody, readLogoutToken } from './refresh-body.js';
import { type IssuedTokens, TokenService } from './token.service.js';

/**
 * 로그인 방식(소셜 · 이메일)과 상관없이 모두가 같이 쓰는 토큰 갱신 · 로그아웃.
 * 전역 접두사(api/v1)가 붙어 `/api/v1/auth/refresh` · `/api/v1/auth/logout` 이 된다(packages/shared PATHS).
 */
@Controller('auth')
export class AuthTokenController {
  constructor(private readonly tokens: TokenService) {}

  /**
   * access 토큰이 만료되면 앱이 refresh 토큰을 보내 새 토큰 한 쌍을 받는다. 쓴 refresh 토큰은 폐기된다.
   * 응답: `{ data: { accessToken, refreshToken } }`. 쓸 수 없는 토큰이면 401 + AUTH_TOKEN_EXPIRED.
   */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  // 토큰이 들어 있는 응답이므로 어디에도 저장되지 않게 한다
  @Header('Cache-Control', 'no-store')
  async refresh(@Body() body: unknown): Promise<{ data: IssuedTokens }> {
    return { data: await this.tokens.rotate(parseRefreshBody(body)) };
  }

  /** 로그아웃한 기기의 refresh 토큰만 폐기한다(다른 기기는 그대로). 항상 204 */
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  async logout(@Body() body: unknown): Promise<void> {
    const token = readLogoutToken(body);
    if (token !== null) await this.tokens.revoke(token);
  }
}
