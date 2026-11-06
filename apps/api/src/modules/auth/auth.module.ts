import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';

import { createJwtConfig } from '../../config/jwt.config.js';
import { RefreshToken, RefreshTokenSchema } from './schemas/refresh-token.schema.js';
import { JWT_CONFIG, TokenService } from './token.service.js';

@Module({
  imports: [
    // 시크릿과 수명은 토큰마다(access · refresh) 다르므로 기본값 없이 등록하고, TokenService가 호출할 때 넘긴다
    JwtModule.register({}),
    // refresh_tokens 컬렉션
    MongooseModule.forFeature([{ name: RefreshToken.name, schema: RefreshTokenSchema }]),
  ],
  providers: [
    // JWT_* 환경변수를 읽고 검증한다. 없거나 잘못되면 서버가 시작할 때 바로 실패한다
    {
      provide: JWT_CONFIG,
      inject: [ConfigService],
      useFactory: createJwtConfig,
    },
    TokenService,
  ],
  // 이메일 · 소셜 로그인이 같은 토큰 발급 로직을 쓰도록 내보낸다
  exports: [TokenService],
})
export class AuthModule {}
