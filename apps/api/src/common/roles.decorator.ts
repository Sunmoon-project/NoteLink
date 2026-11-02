import { SetMetadata } from '@nestjs/common';

import type { Role } from './roles.js';

export const ROLES_KEY = 'roles';

/**
 * 이 라우트에 접근할 수 있는 역할을 지정합니다.
 * 예: @Roles(ROLES.ADMIN)  → admin만 허용
 * RolesGuard와 함께 써야 효과가 있습니다.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
