import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Redirect,
} from '@nestjs/common';

import { parseSocialCallbackQuery } from './social-callback-query.js';
import { parseSocialExchangeBody } from './social-exchange-body.js';
import { type SocialLoginResult, SocialExchangeService } from './social-exchange.service.js';
import { SocialLoginService } from './social-login.service.js';
import { parseSocialStartQuery } from './social-start-query.js';

/** 전역 접두사(api/v1)가 붙어 `/api/v1/auth/social/...` 이 된다(packages/shared PATHS.socialStart) */
@Controller('auth/social')
export class SocialLoginController {
  constructor(
    private readonly socialLogin: SocialLoginService,
    private readonly exchange: SocialExchangeService,
  ) {}

  /**
   * 제공자가 로그인을 마친 사용자를 돌려보내는 주소. 각 제공자 콘솔의 "승인된 리디렉션 URI"와 같은 경로다
   * (예: 구글 `GOOGLE_CALLBACK_PATH`). 1회용 코드를 만들어 브라우저를 앱(notelink://auth/callback)으로 돌려보낸다.
   */
  @Get(':provider/callback')
  @Redirect()
  // 앱 주소에 1회용 코드가 들어 있으므로 브라우저나 중간 서버가 저장해 두지 않게 한다
  @Header('Cache-Control', 'no-store')
  async callback(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
  ): Promise<{ url: string; statusCode: number }> {
    // 지원하지 않는 제공자는 쿼리 검증 전에 404로 돌려보낸다(시작 · 교환과 같은 순서)
    this.socialLogin.provider(provider);
    const url = await this.socialLogin.handleCallback(provider, parseSocialCallbackQuery(query));
    return { url, statusCode: HttpStatus.FOUND };
  }

  /**
   * 앱이 시스템 브라우저로 여는 주소. 로그인 시도를 저장하고 브라우저를 제공자 로그인 화면으로 보낸다.
   */
  @Get(':provider/start')
  @Redirect()
  // 주소에 이번 로그인 시도의 state가 들어 있으므로 브라우저나 중간 서버가 저장해 두지 않게 한다
  @Header('Cache-Control', 'no-store')
  async start(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
  ): Promise<{ url: string; statusCode: number }> {
    // 지원하지 않는 제공자는 쿼리 검증 전에 404로 돌려보낸다
    this.socialLogin.provider(provider);
    const url = await this.socialLogin.start(provider, parseSocialStartQuery(query));
    return { url, statusCode: HttpStatus.FOUND };
  }

  /**
   * 앱이 콜백에서 받은 1회용 코드와 codeVerifier를 보내 토큰으로 바꾼다(packages/shared PATHS.socialLogin).
   * 응답: `{ data: { accessToken, refreshToken, user } }`.
   * 코드가 없거나 만료됐거나 PKCE가 틀리면 400, 이메일이 겹치면 409(ACCOUNT_EXISTS).
   */
  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  // 토큰이 들어 있는 응답이므로 어디에도 저장되지 않게 한다
  @Header('Cache-Control', 'no-store')
  async login(
    @Param('provider') provider: string,
    @Body() body: unknown,
  ): Promise<{ data: SocialLoginResult }> {
    // 지원하지 않는 제공자는 본문 검증 전에 404로 돌려보낸다
    this.socialLogin.provider(provider);
    return { data: await this.exchange.exchange(provider, parseSocialExchangeBody(body)) };
  }
}
