import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import type { JwtConfig } from '../../config/jwt.config.js';
import { RefreshToken, type RefreshTokenDocument } from './schemas/refresh-token.schema.js';

/** `createJwtConfig`로 만든 설정을 이 이름으로 넣어 둔다(auth.module에서 연결) */
export const JWT_CONFIG = 'JWT_CONFIG';

/** 앱이 401 + 이 코드를 받으면 refresh 토큰으로 새 토큰을 받아 온다(packages/shared ERROR_CODES.TOKEN_EXPIRED) */
export const TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

export type DeviceInfo = Record<string, unknown>;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(JWT_CONFIG) private readonly config: JwtConfig,
    @InjectModel(RefreshToken.name) private readonly refreshTokens: Model<RefreshTokenDocument>,
  ) {}

  /** 로그인할 때마다 호출한다. 기기마다 자기 refresh 토큰 한 줄이 생긴다 */
  async issue(userId: string, device?: DeviceInfo): Promise<IssuedTokens> {
    const accessToken = await this.jwt.signAsync(
      { sub: userId },
      { secret: this.config.accessSecret, expiresIn: this.config.accessTTL },
    );
    // jti: 같은 사용자가 같은 초에 두 번 로그인해도 토큰이 서로 달라지게 한다(tokenHash가 unique)
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti: randomUUID() },
      { secret: this.config.refreshSecret, expiresIn: this.config.refreshTTL },
    );
    const { exp } = this.jwt.decode<{ exp: number }>(refreshToken);
    await this.refreshTokens.create({
      userId: new Types.ObjectId(userId),
      tokenHash: hashToken(refreshToken),
      device,
      expiresAt: new Date(exp * 1000),
    });
    return { accessToken, refreshToken };
  }

  /** refresh 토큰을 새 토큰 한 쌍으로 바꾼다. 쓴 토큰은 바로 폐기한다 */
  async rotate(refreshToken: string): Promise<IssuedTokens> {
    const payload = await this.verifyRefresh(refreshToken);
    // 조회와 폐기를 한 번에 해서, 같은 토큰으로 동시에 두 번 요청해도 한 번만 성공한다
    const used = await this.refreshTokens.findOneAndUpdate(
      { tokenHash: hashToken(refreshToken), revokedAt: null, expiresAt: { $gt: new Date() } },
      { revokedAt: new Date() },
    );
    if (!used) throw invalidToken();
    return this.issue(payload.sub, used.device);
  }

  /** 로그아웃. 이미 폐기됐거나 없는 토큰이어도 오류 없이 끝낸다 */
  async revoke(refreshToken: string): Promise<void> {
    await this.refreshTokens.updateOne(
      { tokenHash: hashToken(refreshToken), revokedAt: null },
      { revokedAt: new Date() },
    );
  }

  private async verifyRefresh(refreshToken: string): Promise<{ sub: string }> {
    try {
      return await this.jwt.verifyAsync<{ sub: string }>(refreshToken, {
        secret: this.config.refreshSecret,
      });
    } catch {
      throw invalidToken();
    }
  }
}

/** DB에는 토큰 원문 대신 해시를 저장한다. DB가 유출돼도 토큰을 그대로 쓸 수 없다 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function invalidToken(): UnauthorizedException {
  return new UnauthorizedException({ code: TOKEN_EXPIRED, message: '다시 로그인해 주세요' });
}
