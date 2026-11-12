import { Body, Controller, Patch, Req, UseGuards, Get } from '@nestjs/common';
import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
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
}
