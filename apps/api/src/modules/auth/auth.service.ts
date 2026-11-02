import { createHash, randomUUID } from 'node:crypto';

import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import * as bcrypt from 'bcrypt';
import { Model } from 'mongoose';

import { RefreshToken, RefreshTokenDocument } from './schemas/refresh-token.schema.js';
import { User, UserDocument } from './schemas/user.schema.js';

const BCRYPT_ROUNDS = 12;

interface AccessPayload {
  sub: string;
  role: string;
}

interface RefreshPayload {
  sub: string;
  jti: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface PublicUser {
  id: string;
  email?: string;
  nickname: string;
  role: string;
  pointBalance: number;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(RefreshToken.name)
    private readonly refreshTokenModel: Model<RefreshTokenDocument>,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(input: {
    email: string;
    password: string;
    nickname: string;
  }): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    const existing = await this.userModel.exists({ email: input.email });
    if (existing) {
      throw new ConflictException({
        code: 'EMAIL_ALREADY_EXISTS',
        message: '이미 사용 중인 이메일입니다.',
      });
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const user = await this.userModel.create({
      email: input.email,
      passwordHash,
      nickname: input.nickname,
    });

    const tokens = await this.issueTokens(user);
    return { user: this.toPublicUser(user), tokens };
  }

  async login(input: {
    email: string;
    password: string;
  }): Promise<{ user: PublicUser; tokens: AuthTokens }> {
    const user = await this.userModel.findOne({ email: input.email });
    // 비밀번호가 없는 계정(소셜 전용)이나 없는 이메일은 같은 오류로 응답합니다.
    if (!user?.passwordHash) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: '이메일 또는 비밀번호가 올바르지 않습니다.',
      });
    }

    const ok = await bcrypt.compare(input.password, user.passwordHash);
    if (!ok) {
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: '이메일 또는 비밀번호가 올바르지 않습니다.',
      });
    }

    user.lastLoginAt = new Date();
    await user.save();

    const tokens = await this.issueTokens(user);
    return { user: this.toPublicUser(user), tokens };
  }

  /** refresh 토큰을 검증하고 회전(기존 폐기 + 신규 발급)합니다. */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    let payload: RefreshPayload;
    try {
      payload = await this.jwtService.verifyAsync<RefreshPayload>(refreshToken, {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: '유효하지 않은 리프레시 토큰입니다.',
      });
    }

    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.refreshTokenModel.findOne({ tokenHash });

    // 저장돼 있지 않거나 이미 폐기된 토큰이면 거부합니다.
    if (!stored || stored.revokedAt || stored.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: '유효하지 않은 리프레시 토큰입니다.',
      });
    }

    const user = await this.userModel.findById(payload.sub);
    if (!user) {
      throw new UnauthorizedException({
        code: 'INVALID_REFRESH_TOKEN',
        message: '유효하지 않은 리프레시 토큰입니다.',
      });
    }

    // 회전: 사용한 토큰은 폐기하고 새 토큰 쌍을 발급합니다.
    stored.revokedAt = new Date();
    await stored.save();

    return this.issueTokens(user);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.refreshTokenModel.updateOne(
      { tokenHash, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
  }

  async getMe(userId: string): Promise<PublicUser> {
    const user = await this.userModel.findById(userId);
    if (!user || user.deletedAt) {
      throw new UnauthorizedException({
        code: 'USER_NOT_FOUND',
        message: '사용자를 찾을 수 없습니다.',
      });
    }
    return this.toPublicUser(user);
  }

  private async issueTokens(user: UserDocument): Promise<AuthTokens> {
    const userId = user._id.toString();

    const accessPayload: AccessPayload = { sub: userId, role: user.role };
    const accessOptions: JwtSignOptions = {
      secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      // TTL은 환경변수(문자열)로 받습니다. @nestjs/jwt는 ms 형식 리터럴 타입을
      // 요구하므로, 런타임 문자열을 그대로 전달하기 위해 캐스팅합니다.
      expiresIn: (this.config.get<string>('JWT_ACCESS_TTL') ??
        '15m') as JwtSignOptions['expiresIn'],
    };
    const accessToken = await this.jwtService.signAsync(accessPayload, accessOptions);

    const jti = randomUUID();
    const refreshPayload: RefreshPayload = { sub: userId, jti };
    const refreshOptions: JwtSignOptions = {
      secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: (this.config.get<string>('JWT_REFRESH_TTL') ??
        '14d') as JwtSignOptions['expiresIn'],
    };
    const refreshToken = await this.jwtService.signAsync(refreshPayload, refreshOptions);

    await this.refreshTokenModel.create({
      userId: user._id,
      tokenHash: this.hashToken(refreshToken),
      expiresAt: this.decodeExpiry(refreshToken),
    });

    return { accessToken, refreshToken };
  }

  /** 원본 토큰은 저장하지 않고 SHA-256 해시만 DB에 둡니다. */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private decodeExpiry(token: string): Date {
    const decoded = this.jwtService.decode(token) as { exp?: number } | null;
    if (!decoded?.exp) {
      // 방어적 기본값: 14일 뒤.
      return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
    }
    return new Date(decoded.exp * 1000);
  }

  private toPublicUser(user: UserDocument): PublicUser {
    return {
      id: user._id.toString(),
      email: user.email,
      nickname: user.nickname,
      role: user.role,
      pointBalance: user.pointBalance,
    };
  }
}
