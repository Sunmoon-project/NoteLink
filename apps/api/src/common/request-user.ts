import { UnauthorizedException } from '@nestjs/common';

import type { AuthenticatedRequest } from '../modules/auth/jwt-auth.guard.js';

/**
 * 로그인한 사용자의 id를 꺼낸다.
 * JwtAuthGuard를 통과한 요청에는 항상 user가 붙어 있지만, 타입은 "없을 수도 있음"이라서
 * 여기서 한 번 확인한다. 없으면(가드가 빠진 경우 등) 로그인 만료 응답과 같은 401로 처리한다.
 */
export function requireUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.userId;
  if (userId === undefined) {
    throw new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: '다시 로그인해 주세요' });
  }
  return userId;
}
