/**
 * 사용자 역할 정의. User 스키마의 role 필드, JWT payload, RolesGuard가 공유합니다.
 * (상수는 UPPER_SNAKE — AGENTS.md 이름 규칙)
 */
export const ROLES = {
  USER: 'user',
  ADMIN: 'admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];
