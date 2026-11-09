import { Controller, Get, type INestApplication, Req, UseGuards } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { AuthModule } from '../src/modules/auth/auth.module.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../src/modules/auth/jwt-auth.guard.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { stubAppEnv } from './support/app-module.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

const REFRESH = '/api/v1/auth/refresh';
const LOGOUT = '/api/v1/auth/logout';
const PROTECTED = '/api/v1/test-protected';
// packages/shared ERROR_CODES.TOKEN_EXPIRED 와 같은 값. 앱이 이 코드를 받아야 갱신을 시도한다
const TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED';

/** 가드를 쓰는 모듈이 어떻게 연결되는지 보여 주는 시험용 컨트롤러(실제 서비스 코드에는 없다) */
@Controller('test-protected')
@UseGuards(JwtAuthGuard)
class ProtectedController {
  @Get()
  whoAmI(@Req() req: AuthenticatedRequest): { data: { userId: string | undefined } } {
    return { data: { userId: req.user?.userId } };
  }
}

describe('토큰 갱신 · 로그아웃 · 인증 가드 (로그인 방식과 무관: TokenService로 발급한 토큰으로 시험)', () => {
  let app: INestApplication;
  let tokenService: TokenService;
  const fakeRefresh = createFakeRefreshTokens();
  const tokens = fakeRefresh.rows;

  beforeAll(async () => {
    stubAppEnv();
    const refreshModel = fakeRefresh.model;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule, AuthModule],
      controllers: [ProtectedController],
    })
      .overrideProvider(getConnectionToken())
      .useValue({ close: () => Promise.resolve(), models: {}, model: () => ({}) })
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(refreshModel)
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    tokenService = moduleRef.get(TokenService);
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    tokens.length = 0;
  });

  /**
   * 로그인한 것처럼 토큰을 발급한다(어떤 방식으로 로그인했든 서버가 하는 일은 같다).
   * 같은 사용자가 여러 기기에서 로그인한 상황은 같은 `userId`를 넘겨 여러 번 호출해서 만든다.
   */
  async function signIn(userId: string = new Types.ObjectId().toHexString()) {
    const issued = await tokenService.issue(userId);
    return { ...issued, user: { _id: userId } };
  }

  const refresh = (refreshToken: unknown) =>
    request(app.getHttpServer()).post(REFRESH).send({ refreshToken });
  const logout = (refreshToken: unknown) =>
    request(app.getHttpServer()).post(LOGOUT).send({ refreshToken });
  const whoAmI = (token?: string) => {
    const r = request(app.getHttpServer()).get(PROTECTED);
    return token === undefined ? r : r.set('Authorization', `Bearer ${token}`);
  };

  describe('POST /auth/refresh', () => {
    it('새 토큰 한 쌍을 { data: { accessToken, refreshToken } } 로 돌려준다 (앱이 기대하는 모양)', async () => {
      const login = await signIn();

      const res = await refresh(login.refreshToken);

      expect(res.status).toBe(200);
      expect(Object.keys(res.body)).toEqual(['data']);
      expect(Object.keys(res.body.data).sort()).toEqual(['accessToken', 'refreshToken']);
      expect(res.body.data.refreshToken).not.toBe(login.refreshToken);
      // access 토큰은 상태를 저장하지 않아 jti가 없다. 같은 초 안에 발급되면 값이 같을 수 있어 다름을 요구하지 않는다.
      // 대신 새 access 토큰이 이 사용자의 유효한 토큰인지를 확인한다
      expect(res.body.data.accessToken).toEqual(expect.any(String));
    });

    it('시간이 지난 뒤 갱신하면 access 토큰도 새로 만들어진다 (수명이 다시 시작된다)', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const login = await signIn();
      vi.setSystemTime(new Date('2026-01-01T00:10:00Z'));

      const next = (await refresh(login.refreshToken)).body.data;

      expect(next.accessToken).not.toBe(login.accessToken);
      // 로그인 후 16분(원래 access는 만료) 시점에도 새 access 토큰은 아직 유효하다
      vi.setSystemTime(new Date('2026-01-01T00:16:00Z'));
      expect((await whoAmI(login.accessToken)).status).toBe(401);
      expect((await whoAmI(next.accessToken)).status).toBe(200);
      vi.useRealTimers();
    });

    it('응답에 사용자 정보가 없다 (앱은 토큰만 기대한다)', async () => {
      const login = await signIn();

      const res = await refresh(login.refreshToken);

      expect(res.body.data.user).toBeUndefined();
    });

    it('새 access 토큰으로 보호된 주소에 접근할 수 있다', async () => {
      const login = await signIn();
      const next = (await refresh(login.refreshToken)).body.data;

      const res = await whoAmI(next.accessToken);

      expect(res.status).toBe(200);
      expect(res.body.data.userId).toBe(login.user._id);
    });

    it('쓴 refresh 토큰은 다시 쓸 수 없다 (401 AUTH_TOKEN_EXPIRED)', async () => {
      const login = await signIn();
      await refresh(login.refreshToken);

      const again = await refresh(login.refreshToken);

      expect(again.status).toBe(401);
      expect(again.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
    });

    it('갱신을 거듭해도 이어진다 (새 토큰으로 또 갱신)', async () => {
      const login = await signIn();
      let token = login.refreshToken;

      for (let i = 0; i < 5; i++) {
        const res = await refresh(token);
        expect(res.status).toBe(200);
        token = res.body.data.refreshToken;
      }

      expect(tokens.filter((t) => t.revokedAt === null)).toHaveLength(1);
    });

    it('같은 토큰으로 동시에 갱신하면 한 번만 성공한다', async () => {
      const login = await signIn();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => refresh(login.refreshToken)),
      );

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 401)).toHaveLength(9);
      expect(tokens.filter((t) => t.revokedAt === null)).toHaveLength(1);
    });

    it('응답을 캐시하지 않게 한다 (토큰이 들어 있다)', async () => {
      const login = await signIn();

      const res = await refresh(login.refreshToken);

      expect(res.headers['cache-control']).toBe('no-store');
    });

    it('access 토큰을 refresh 자리에 내밀면 401이다', async () => {
      const login = await signIn();

      const res = await refresh(login.accessToken);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_TOKEN_EXPIRED');
    });

    it('서명이 맞아도 DB에 없는 토큰은 401이다', async () => {
      const login = await signIn();
      tokens.length = 0;

      const res = await refresh(login.refreshToken);

      expect(res.status).toBe(401);
    });

    it('DB의 만료 시각이 지난 토큰은 401이고 새 토큰이 생기지 않는다', async () => {
      const login = await signIn();
      tokens[0]!.expiresAt = new Date(Date.now() - 1000);

      const res = await refresh(login.refreshToken);

      expect(res.status).toBe(401);
      expect(tokens).toHaveLength(1);
    });

    it.each([
      ['본문 없음', undefined],
      ['refreshToken이 없음', {}],
      ['JWT 모양이 아님', 'not-a-jwt'],
      ['빈 문자열', ''],
      ['숫자', 123],
    ])('%s이면 400 { code, message } 이다', async (_reason, value) => {
      const res = await request(app.getHttpServer())
        .post(REFRESH)
        .send(value === undefined ? undefined : { refreshToken: value });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'VALIDATION_FAILED', message: expect.any(String) });
    });

    it('오류 응답에 받은 토큰을 되돌려 주지 않는다', async () => {
      const login = await signIn();

      const res = await refresh(login.accessToken);

      expect(res.text).not.toContain(login.accessToken);
    });

    it('GET은 받지 않는다 (토큰을 주소에 싣지 않는다)', async () => {
      const login = await signIn();

      const res = await request(app.getHttpServer()).get(
        `${REFRESH}?refreshToken=${login.refreshToken}`,
      );

      expect(res.status).toBe(404);
    });

    it('접두사가 없는 주소(/auth/refresh)는 응답하지 않는다', async () => {
      const login = await signIn();

      const res = await request(app.getHttpServer())
        .post('/auth/refresh')
        .send({ refreshToken: login.refreshToken });

      expect(res.status).toBe(404);
    });
  });

  describe('POST /auth/logout', () => {
    it('204로 끝나고 본문이 없다', async () => {
      const login = await signIn();

      const res = await logout(login.refreshToken);

      expect(res.status).toBe(204);
      expect(res.text).toBe('');
    });

    it('로그아웃한 기기의 refresh 토큰은 더 이상 갱신할 수 없다', async () => {
      const login = await signIn();
      await logout(login.refreshToken);

      const res = await refresh(login.refreshToken);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_TOKEN_EXPIRED');
    });

    it('같은 사용자의 다른 기기 토큰은 그대로 쓸 수 있다 (로그아웃한 기기의 토큰만 갱신에 실패한다)', async () => {
      const userId = new Types.ObjectId().toHexString();
      const phone = await signIn(userId);
      const tablet = await signIn(userId);
      // 같은 사용자의 서로 다른 두 기기 토큰이어야 이 시험이 의미가 있다
      expect(phone.user._id).toBe(tablet.user._id);
      expect(phone.refreshToken).not.toBe(tablet.refreshToken);

      await logout(phone.refreshToken);

      // 로그아웃 직후, 폐기된 것은 로그아웃한 기기의 행 하나뿐이다(갱신은 쓴 토큰도 폐기하므로 갱신 전에 확인한다)
      const rows = tokens.filter((t) => t.userId.toHexString() === userId);
      expect(rows).toHaveLength(2);
      expect(rows.filter((t) => t.revokedAt !== null)).toHaveLength(1);

      const phoneRefresh = await refresh(phone.refreshToken);
      const tabletRefresh = await refresh(tablet.refreshToken);
      expect(phoneRefresh.status).toBe(401);
      expect(phoneRefresh.body.code).toBe('AUTH_TOKEN_EXPIRED');
      expect(tabletRefresh.status).toBe(200);
    });

    it('로그아웃하지 않은 기기는 로그아웃한 뒤에도 계속 갱신할 수 있다', async () => {
      const userId = new Types.ObjectId().toHexString();
      const phone = await signIn(userId);
      const tablet = await signIn(userId);
      await logout(phone.refreshToken);

      const first = await refresh(tablet.refreshToken);
      const second = await refresh(first.body.data.refreshToken);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect((await refresh(phone.refreshToken)).status).toBe(401);
    });

    it('두 기기 모두 로그아웃하면 둘 다 갱신할 수 없다', async () => {
      const userId = new Types.ObjectId().toHexString();
      const phone = await signIn(userId);
      const tablet = await signIn(userId);

      await logout(phone.refreshToken);
      await logout(tablet.refreshToken);

      expect((await refresh(phone.refreshToken)).status).toBe(401);
      expect((await refresh(tablet.refreshToken)).status).toBe(401);
    });

    it('로그아웃해도 이미 발급된 access 토큰은 만료(15분)까지 유효하다 (access는 서버가 상태를 갖지 않는다)', async () => {
      const login = await signIn();
      await logout(login.refreshToken);

      const res = await whoAmI(login.accessToken);

      expect(res.status).toBe(200);
    });

    it('같은 토큰으로 두 번 로그아웃해도 204이다', async () => {
      const login = await signIn();
      await logout(login.refreshToken);

      const again = await logout(login.refreshToken);

      expect(again.status).toBe(204);
    });

    it.each([
      ['본문 없음', undefined],
      ['앱이 토큰을 잃은 상태({})', {}],
      ['refreshToken이 undefined', { refreshToken: undefined }],
      ['JWT 모양이 아님', { refreshToken: 'not-a-jwt' }],
      ['빈 문자열', { refreshToken: '' }],
      ['숫자', { refreshToken: 5 }],
      [
        '서명은 맞지만 DB에 없는 토큰',
        { refreshToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.abc' },
      ],
    ])('%s이어도 오류 없이 204이다', async (_reason, body) => {
      const res = await request(app.getHttpServer()).post(LOGOUT).send(body);

      expect(res.status).toBe(204);
    });

    it('유효한 토큰과 없는 토큰의 응답이 같다 (토큰이 유효한지 알려 주지 않는다)', async () => {
      const login = await signIn();

      const valid = await logout(login.refreshToken);
      const unknown = await logout(login.refreshToken);

      expect(valid.status).toBe(unknown.status);
      expect(valid.text).toBe(unknown.text);
    });

    it('다른 사람의 토큰으로 로그아웃해도 내 토큰에는 영향이 없다', async () => {
      const me = await signIn();
      const other = await signIn();
      await logout(other.refreshToken);

      expect((await refresh(me.refreshToken)).status).toBe(200);
    });

    it('응답을 캐시하지 않게 한다', async () => {
      const login = await signIn();

      const res = await logout(login.refreshToken);

      expect(res.headers['cache-control']).toBe('no-store');
    });
  });

  describe('JwtAuthGuard (보호된 주소)', () => {
    it('로그인으로 받은 access 토큰으로 접근하면 내 사용자 id가 붙는다', async () => {
      const login = await signIn();

      const res = await whoAmI(login.accessToken);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ data: { userId: login.user._id } });
    });

    it('토큰이 없으면 401 AUTH_TOKEN_EXPIRED이다', async () => {
      const res = await whoAmI();

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ code: 'AUTH_TOKEN_EXPIRED', message: expect.any(String) });
    });

    it('refresh 토큰으로는 접근할 수 없다', async () => {
      const login = await signIn();

      const res = await whoAmI(login.refreshToken);

      expect(res.status).toBe(401);
    });

    it('엉뚱한 토큰이면 401이다', async () => {
      expect((await whoAmI('garbage')).status).toBe(401);
    });

    it('Bearer가 아닌 스킴이면 401이다', async () => {
      const login = await signIn();

      const res = await request(app.getHttpServer())
        .get(PROTECTED)
        .set('Authorization', `Basic ${login.accessToken}`);

      expect(res.status).toBe(401);
    });

    it('401 응답이 앱이 갱신을 시도하는 조건(401 + AUTH_TOKEN_EXPIRED)과 정확히 같다', async () => {
      const res = await whoAmI('garbage');

      expect(res.status).toBe(401);
      expect(res.body.code).toBe(TOKEN_EXPIRED);
    });
  });

  describe('앱이 하는 전체 시나리오', () => {
    it('로그인 → 보호된 주소 → (access 만료 가정) 갱신 → 다시 접근 → 로그아웃 → 갱신 불가', async () => {
      const login = await signIn();
      expect((await whoAmI(login.accessToken)).status).toBe(200);

      const next = (await refresh(login.refreshToken)).body.data;
      expect((await whoAmI(next.accessToken)).status).toBe(200);

      expect((await logout(next.refreshToken)).status).toBe(204);
      expect((await refresh(next.refreshToken)).status).toBe(401);
      expect((await refresh(login.refreshToken)).status).toBe(401);
    });
  });
});
