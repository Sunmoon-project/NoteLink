import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ChangePlanDto, RegisterDeviceDto, UpdateStatusDto } from './dto/account.dto.js';
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

  /** 푸시 받을 기기 등록 { platform, pushToken, locale } → 204 */
  @Post('me/devices')
  @HttpCode(HttpStatus.NO_CONTENT)
  async registerDevice(
    @Req() req: AuthenticatedRequest,
    @Body() body: RegisterDeviceDto,
  ): Promise<void> {
    await this.users.registerDevice(requireUserId(req), body);
  }

  /** 요금제 바꾸기 { tier } → 바뀐 내 정보. 결제 연동 전에는 free만(유료는 402) */
  @Patch('me/subscription')
  async changePlan(@Req() req: AuthenticatedRequest, @Body() body: ChangePlanDto) {
    return { data: await this.users.changePlan(requireUserId(req), body) };
  }
}
