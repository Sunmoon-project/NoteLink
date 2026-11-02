import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ROLES_KEY } from './roles.decorator.js';
import type { Role } from './roles.js';

interface RequestWithUser extends Request {
  user?: { userId: string; role: string };
}

/**
 * @Roles(...)로 지정한 역할만 통과시킵니다.
 * JwtAuthGuard가 먼저 실행돼 request.user.role을 채워둬야 합니다.
 * (컨트롤러에서 @UseGuards(JwtAuthGuard, RolesGuard) 순서로 씁니다.)
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 메서드/클래스에 붙은 @Roles 메타데이터를 읽습니다.
    const requiredRoles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    // @Roles가 없으면 역할 제한이 없는 라우트 → 통과
    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const role = request.user?.role;

    if (!role || !requiredRoles.includes(role as Role)) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: '이 작업을 수행할 권한이 없습니다.',
      });
    }
    return true;
  }
}
