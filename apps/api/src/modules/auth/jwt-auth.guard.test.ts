import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';

import { JwtAuthGuard } from './jwt-auth.guard.js';

const run = (verify: () => Promise<unknown>) => {
  const guard = new JwtAuthGuard(
    { verifyAsync: vi.fn(verify) } as unknown as JwtService,
    { getOrThrow: () => 'secret' } as unknown as ConfigService,
  );
  const request = { headers: { authorization: 'Bearer t' } };
  const context = { switchToHttp: () => ({ getRequest: () => request }) };
  return guard.canActivate(context as unknown as ExecutionContext);
};
const codeOf = (p: Promise<unknown>) =>
  p.catch((e: { getResponse(): { code: string } }) => e.getResponse().code);

describe('JwtAuthGuard', () => {
  it('만료된 토큰은 앱이 갱신하도록 AUTH_TOKEN_EXPIRED로 알린다', async () => {
    const expired = Object.assign(new Error('x'), { name: 'TokenExpiredError' });
    await expect(codeOf(run(() => Promise.reject(expired)))).resolves.toBe('AUTH_TOKEN_EXPIRED');
  });

  it('그 밖의 잘못된 토큰은 UNAUTHORIZED', async () => {
    await expect(codeOf(run(() => Promise.reject(new Error('bad'))))).resolves.toBe('UNAUTHORIZED');
  });

  it('유효하면 통과한다', async () => {
    await expect(run(() => Promise.resolve({ sub: 'u', role: 'user' }))).resolves.toBe(true);
  });
});
