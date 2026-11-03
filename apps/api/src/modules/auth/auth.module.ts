import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthController, UsersController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { AuthCode, AuthCodeSchema } from './schemas/auth-code.schema.js';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema.js';
import { User, UserSchema } from './schemas/user.schema.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: AuthCode.name, schema: AuthCodeSchema },
      { name: RefreshToken.name, schema: RefreshTokenSchema },
    ]),
    // 시크릿은 서명/검증 시점에 ConfigService로 주입합니다(토큰별로 다른 시크릿 사용).
    JwtModule.register({}),
  ],
  controllers: [AuthController, UsersController],
  providers: [AuthService, JwtAuthGuard],
  // JwtAuthGuard를 다른 모듈에서 쓰려면 그 의존성(JwtModule)도 함께 내보내야 합니다.
  exports: [MongooseModule, JwtModule, AuthService, JwtAuthGuard],
})
export class AuthModule {}
