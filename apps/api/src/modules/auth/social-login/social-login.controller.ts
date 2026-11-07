import {
  Controller,
  Get,
  Header,
  HttpStatus,
  NotFoundException,
  Param,
  Query,
  Redirect,
} from '@nestjs/common';

import { NOT_FOUND } from './social-login.constants.js';
import { SocialLoginService } from './social-login.service.js';
import { parseSocialStartQuery } from './social-start-query.js';

/** 전역 접두사(api/v1)가 붙어 `/api/v1/auth/social/...` 이 된다(packages/shared PATHS.socialStart) */
@Controller('auth/social')
export class SocialLoginController {
  constructor(private readonly socialLogin: SocialLoginService) {}

  /**
   * 앱이 시스템 브라우저로 여는 주소. 로그인 시도를 저장하고 브라우저를 제공자 로그인 화면으로 보낸다.
   * 아직 구글만 지원한다. 카카오 · 네이버는 구글과 같은 구조로 뒤에 추가한다.
   */
  @Get(':provider/start')
  @Redirect()
  // 주소에 이번 로그인 시도의 state가 들어 있으므로 브라우저나 중간 서버가 저장해 두지 않게 한다
  @Header('Cache-Control', 'no-store')
  async start(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
  ): Promise<{ url: string; statusCode: number }> {
    if (provider !== 'google') {
      throw new NotFoundException({ code: NOT_FOUND, message: '지원하지 않는 로그인 방식이에요' });
    }
    const url = await this.socialLogin.startGoogle(parseSocialStartQuery(query));
    return { url, statusCode: HttpStatus.FOUND };
  }
}
