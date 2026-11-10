import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { requireUserId } from '../../../common/request-user.js';
import { AgreeTermsDto } from '../dto/agree-terms.dto.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../jwt-auth.guard.js';
import { TermsService } from './terms.service.js';

/** 주소는 /api/v1/auth/terms (packages/shared PATHS). 로그인한 사용자의 약관 동의를 저장한다 */
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class TermsController {
  constructor(private readonly terms: TermsService) {}

  /** POST /api/v1/auth/terms { termCodes } → 204. 필수 약관이 빠지면 400 TERMS_REQUIRED */
  @Post('terms')
  @HttpCode(HttpStatus.NO_CONTENT)
  async agree(@Req() req: AuthenticatedRequest, @Body() body: AgreeTermsDto): Promise<void> {
    const saved = await this.terms.agree(requireUserId(req), body.termCodes);
    if (!saved) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: '사용자를 찾을 수 없습니다.' });
    }
  }
}
