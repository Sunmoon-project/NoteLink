import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User } from '../src/modules/auth/schemas/user.schema.js';
import { TermsController } from '../src/modules/auth/terms/terms.controller.js';
import { TermsService } from '../src/modules/auth/terms/terms.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';

const USER_ID = new Types.ObjectId().toString();
const TOKEN = 'test-token';
const AUTH = { Authorization: `Bearer ${TOKEN}` };

interface Agreement {
  termCode: string;
  version: string;
  agreed: boolean;
  agreedAt: Date;
}

// 가짜 users: 사용자 한 명의 약관 동의만 기억한다. user가 null이면 없는 사용자
let user: { termAgreements: Agreement[] } | null;
const userModel = {
  findOne: vi.fn(() => ({ lean: vi.fn(() => Promise.resolve(user)) })),
  updateOne: vi.fn((_filter: unknown, update: { $set: { termAgreements: Agreement[] } }) => {
    if (!user) return Promise.resolve({ matchedCount: 0 });
    user.termAgreements = update.$set.termAgreements;
    return Promise.resolve({ matchedCount: 1 });
  }),
};

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    controllers: [TermsController],
    providers: [
      TermsService,
      { provide: getModelToken(User.name), useValue: userModel },
      // 로그인 확인(JwtAuthGuard)이 쓰는 도구의 가짜: TOKEN만 통과시킨다
      {
        provide: TokenService,
        useValue: {
          verifyAccess: (token: string) =>
            token === TOKEN
              ? Promise.resolve({ userId: USER_ID })
              : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
        },
      },
    ],
  }).compile();
  app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  user = { termAgreements: [] };
  userModel.findOne.mockClear();
  userModel.updateOne.mockClear();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-09T01:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

const post = (body: unknown, headers: Record<string, string> = AUTH) =>
  request(app.getHttpServer()).post('/api/v1/auth/terms').set(headers).send(body as object);

describe('POST /auth/terms (FR-01-05)', () => {
  it('필수 약관에만 동의하면 204이고 선택 약관은 agreed: false로 남긴다', async () => {
    const res = await post({ termCodes: ['service', 'privacy'] });
    expect(res.status).toBe(204);
    const now = new Date('2026-11-09T01:00:00Z');
    expect(user?.termAgreements).toEqual([
      { termCode: 'service', version: '1.0', agreed: true, agreedAt: now },
      { termCode: 'privacy', version: '1.0', agreed: true, agreedAt: now },
      { termCode: 'marketing', version: '1.0', agreed: false, agreedAt: now },
    ]);
  });

  it('선택 약관까지 모두 동의하면 세 개 모두 agreed: true', async () => {
    const res = await post({ termCodes: ['service', 'privacy', 'marketing'] });
    expect(res.status).toBe(204);
    expect(user?.termAgreements.map((t) => t.agreed)).toEqual([true, true, true]);
  });

  it('필수 약관이 하나 빠지면 400 TERMS_REQUIRED이고 아무것도 저장하지 않는다', async () => {
    const res = await post({ termCodes: ['service', 'marketing'] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TERMS_REQUIRED');
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('빈 목록이면 400 TERMS_REQUIRED', async () => {
    const res = await post({ termCodes: [] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TERMS_REQUIRED');
  });

  it('모르는 약관 코드는 400', async () => {
    const res = await post({ termCodes: ['service', 'privacy', 'unknown'] });
    expect(res.status).toBe(400);
    expect(userModel.updateOne).not.toHaveBeenCalled();
  });

  it('같은 코드가 두 번 오면 400', async () => {
    const res = await post({ termCodes: ['service', 'service', 'privacy'] });
    expect(res.status).toBe(400);
  });

  it('termCodes가 배열이 아니거나 없으면 400', async () => {
    expect((await post({ termCodes: 'service' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
  });

  it('정의되지 않은 필드가 오면 400', async () => {
    const res = await post({ termCodes: ['service', 'privacy'], extra: 1 });
    expect(res.status).toBe(400);
  });

  it('로그인하지 않으면 401 AUTH_TOKEN_EXPIRED', async () => {
    const res = await post({ termCodes: ['service', 'privacy'] }, {});
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('사용자가 없으면 404 NOT_FOUND', async () => {
    user = null;
    const res = await post({ termCodes: ['service', 'privacy'] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('다시 호출해 선택 약관만 바뀌면 그 약관의 시각만 새로 기록한다', async () => {
    await post({ termCodes: ['service', 'privacy'] });
    vi.setSystemTime(new Date('2026-11-10T01:00:00Z'));
    const res = await post({ termCodes: ['service', 'privacy', 'marketing'] });
    expect(res.status).toBe(204);
    const first = new Date('2026-11-09T01:00:00Z');
    const second = new Date('2026-11-10T01:00:00Z');
    expect(user?.termAgreements).toEqual([
      { termCode: 'service', version: '1.0', agreed: true, agreedAt: first },
      { termCode: 'privacy', version: '1.0', agreed: true, agreedAt: first },
      { termCode: 'marketing', version: '1.0', agreed: true, agreedAt: second },
    ]);
  });
});
