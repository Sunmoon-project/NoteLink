import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import {
  ChangePlanDto,
  RegisterDeviceDto,
  UpdateStatusDto,
  VerifyIdentityCodeDto,
} from './dto/account.dto.js';
import { UpdateProfileDto } from './dto/update-profiile.dto.js';
import { UsersService } from './users.service.js';

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('interest-categories')
  async interestCategories() {
    return { data: await this.users.interestCategories() };
  }

  @Get('me') // 내 정보 조회
  async getMe(@Req() req: AuthenticatedRequest) {
    const user = await this.users.getMe(requireUserId(req));
    return { data: user };
  }

  @Patch('me') // 내 정보 수정
  async updateProfile(@Req() req: AuthenticatedRequest, @Body() body: UpdateProfileDto) {
    const user = await this.users.updateProfile(requireUserId(req), body);
    return { data: user };
  }

  /** 회원 탈퇴 → 204 */
  @Delete('me')
  @HttpCode(HttpStatus.NO_CONTENT)
  async withdraw(@Req() req: AuthenticatedRequest): Promise<void> {
    await this.users.withdraw(requireUserId(req));
  }

  /** 내 상태 바꾸기 { status } → 204 */
  @Patch('me/status')
  @HttpCode(HttpStatus.NO_CONTENT)
  async setStatus(@Req() req: AuthenticatedRequest, @Body() body: UpdateStatusDto): Promise<void> {
    await this.users.setStatus(requireUserId(req), body);
  }

  /** 앱이 앞에 있다는 신호 → 204. 앱은 앞에 있는 동안 1분마다 보낸다 */
  @Put('me/presence')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markActive(
    @Req() req: AuthenticatedRequest,
    @Query('device') device?: string,
  ): Promise<void> {
    await this.users.setPresence(requireUserId(req), true, device);
  }

  /** 앱이 백그라운드로 갔다는 신호 → 204. 친구에게 바로 오프라인으로 보인다 */
  @Delete('me/presence')
  @HttpCode(HttpStatus.NO_CONTENT)
  async markAway(
    @Req() req: AuthenticatedRequest,
    @Query('device') device?: string,
  ): Promise<void> {
    await this.users.setPresence(requireUserId(req), false, device);
  }

  /** 푸시 받을 기기 등록 { platform, pushToken, locale } → 204 */
  @Post('me/devices')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerDevice(
    @Req() req: AuthenticatedRequest,
    @Body() body: RegisterDeviceDto,
  ): Promise<void> {
    await this.users.registerDevice(requireUserId(req), body);
  }

  /** 계정 이메일로 본인 인증번호 보내기 → 204. 이메일이 없으면 400 NO_EMAIL */
  @Post('me/email/send-code')
  @HttpCode(HttpStatus.NO_CONTENT)
  async sendEmailCode(@Req() req: AuthenticatedRequest): Promise<void> {
    await this.users.sendEmailCode(requireUserId(req));
  }

  /** 본인 인증번호 확인 { code } → 인증된 내 정보 */
  @Post('me/email/verify-code')
  @HttpCode(HttpStatus.OK)
  async verifyEmailCode(@Req() req: AuthenticatedRequest, @Body() body: VerifyIdentityCodeDto) {
    return { data: await this.users.verifyEmailCode(requireUserId(req), body.code) };
  }

  /** 요금제 바꾸기 { tier } → 바뀐 내 정보. 결제 연동 전에는 free만(유료는 402) */
  @Patch('me/subscription')
  async changePlan(@Req() req: AuthenticatedRequest, @Body() body: ChangePlanDto) {
    return { data: await this.users.changePlan(requireUserId(req), body) };
  }
}
