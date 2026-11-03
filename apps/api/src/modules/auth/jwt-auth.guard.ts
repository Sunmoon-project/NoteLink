import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';

export interface AuthenticatedUser {
  userId: string;
  role: string;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: '인증이 필요합니다.',
      });
    }

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        role: string;
      }>(token, {
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      });
      request.user = { userId: payload.sub, role: payload.role };
      return true;
    } catch (err) {
      // 앱은 이 코드를 받아야 토큰을 갱신합니다 (packages/shared ERROR_CODES.TOKEN_EXPIRED).
      if ((err as Error).name === 'TokenExpiredError') {
        throw new UnauthorizedException({
          code: 'AUTH_TOKEN_EXPIRED',
          message: '액세스 토큰이 만료되었습니다.',
        });
      }
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: '유효하지 않은 액세스 토큰입니다.',
      });
    }
  }

  private extractBearerToken(request: Request): string | undefined {
    const header = request.headers.authorization;
    if (!header) {
      return undefined;
    }
    const [scheme, value] = header.split(' ');
    return scheme === 'Bearer' && value ? value : undefined;
  }
}
