import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';

import { AuthResult, AuthService, AuthTokens, PublicUser } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { RegisterDto } from './dto/register.dto.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import type { AuthenticatedRequest } from './jwt-auth.guard.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto): Promise<{ data: AuthResult }> {
    const data = await this.authService.register(dto);
    return { data };
  }

  @Post('email/login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto): Promise<{ data: AuthResult }> {
    const data = await this.authService.login(dto);
    return { data };
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() dto: RefreshDto): Promise<{ data: AuthTokens }> {
    const data = await this.authService.refresh(dto.refreshToken);
    return { data };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Body() dto: RefreshDto): Promise<void> {
    await this.authService.logout(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: AuthenticatedRequest): Promise<{ data: PublicUser }> {
    const data = await this.authService.getMe(req.user.userId);
    return { data };
  }
}

// 앱의 내 정보 주소 (packages/shared PATHS.me)
@Controller('users')
export class UsersController {
  constructor(private readonly authService: AuthService) {}

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: AuthenticatedRequest): Promise<{ data: PublicUser }> {
    return { data: await this.authService.getMe(req.user.userId) };
  }
}
