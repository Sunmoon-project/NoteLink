import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { TOKEN_EXPIRED, TokenService } from './token.service.js';

/** 인증된 요청에 붙는 정보. 컨트롤러는 `request.user.userId`로 사용자를 알아낸다 */
export interface AuthenticatedUser {
  userId: string;
}

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

/** `Authorization: Bearer <토큰>` 에서 토큰을 꺼낸다. 형식이 다르면 null (스킴은 대소문자를 구분하지 않는다: RFC 7235) */
export function readBearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null; // 헤더가 여러 번 오면 배열이다. 하나만 받는다
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

/**
 * access 토큰으로 요청을 인증한다. 통과하면 `request.user`에 사용자 id를 붙인다.
 * 사용 예: `@UseGuards(JwtAuthGuard)` (사용하는 모듈이 `AuthModule`을 가져와야 한다)
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = readBearerToken(request.headers['authorization']);
    if (token === null) {
      // 토큰이 없거나 형식이 다른 경우도 같은 응답이다
      throw new UnauthorizedException({ code: TOKEN_EXPIRED, message: '다시 로그인해 주세요' });
    }
    request.user = await this.tokens.verifyAccess(token);
    return true;
  }
}
