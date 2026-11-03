import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';
import { RefreshToken } from './schemas/refresh-token.schema.js';
import { User } from './schemas/user.schema.js';

// Mongoose 모델은 함수이자 객체(정적 메서드 보유)이므로 둘 다 흉내 냅니다.
function createUserModelMock() {
  const saved: Array<Record<string, unknown>> = [];
  const model = vi.fn();
  return Object.assign(model, {
    exists: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
    __saved: saved,
  });
}

function createRefreshModelMock() {
  return {
    create: vi.fn().mockResolvedValue({}),
    findOneAndUpdate: vi.fn(),
    updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let userModel: ReturnType<typeof createUserModelMock>;
  let refreshModel: ReturnType<typeof createRefreshModelMock>;
  let jwt: {
    signAsync: ReturnType<typeof vi.fn>;
    verifyAsync: ReturnType<typeof vi.fn>;
    decode: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    userModel = createUserModelMock();
    refreshModel = createRefreshModelMock();
    jwt = {
      signAsync: vi.fn().mockResolvedValue('signed.jwt.token'),
      verifyAsync: vi.fn(),
      decode: vi.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    };

    const config = {
      get: vi.fn().mockReturnValue(undefined),
      getOrThrow: vi.fn().mockReturnValue('secret'),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: getModelToken(User.name), useValue: userModel },
        { provide: getModelToken(RefreshToken.name), useValue: refreshModel },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(AuthService);
  });

  describe('register', () => {
    it('이미 있는 이메일이면 ConflictException', async () => {
      userModel.exists.mockResolvedValue({ _id: 'x' });
      await expect(
        service.register({ email: 'a@b.com', password: 'password1', nickname: 'kim' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('비밀번호를 해시해서 저장하고 토큰을 발급한다', async () => {
      userModel.exists.mockResolvedValue(null);
      userModel.create.mockResolvedValue({
        _id: { toString: () => 'uid1' },
        email: 'a@b.com',
        nickname: 'kim',
        role: 'user',
        pointBalance: 0,
      });

      const result = await service.register({
        email: 'a@b.com',
        password: 'password1',
        nickname: 'kim',
      });

      const createArg = userModel.create.mock.calls[0]?.[0] as {
        passwordHash: string;
      };
      expect(createArg.passwordHash).not.toBe('password1');
      expect(await bcrypt.compare('password1', createArg.passwordHash)).toBe(true);
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(result.user._id).toBe('uid1');
      expect(refreshModel.create).toHaveBeenCalledOnce();
    });
  });

  it('동시 가입으로 유일 인덱스에 걸리면 ConflictException', async () => {
    userModel.exists.mockResolvedValue(null);
    userModel.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));
    await expect(
      service.register({ email: 'a@b.com', password: 'password1', nickname: 'kim' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  describe('login', () => {
    it('없는 사용자면 UnauthorizedException', async () => {
      userModel.findOne.mockResolvedValue(null);
      await expect(
        service.login({ email: 'none@b.com', password: 'password1' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('비밀번호가 틀리면 UnauthorizedException', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      userModel.findOne.mockResolvedValue({
        _id: { toString: () => 'uid1' },
        passwordHash: hash,
        role: 'user',
        save: vi.fn(),
      });
      await expect(
        service.login({ email: 'a@b.com', password: 'wrong-password' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('맞으면 토큰을 발급하고 lastLoginAt을 갱신한다', async () => {
      const hash = await bcrypt.hash('correct-password', 10);
      const save = vi.fn();
      userModel.findOne.mockResolvedValue({
        _id: { toString: () => 'uid1' },
        email: 'a@b.com',
        nickname: 'kim',
        role: 'user',
        pointBalance: 0,
        passwordHash: hash,
        save,
      });

      const result = await service.login({ email: 'a@b.com', password: 'correct-password' });
      expect(result.accessToken).toBe('signed.jwt.token');
      expect(save).toHaveBeenCalledOnce();
    });
  });

  describe('refresh', () => {
    it('저장돼 있지 않은 토큰이면 UnauthorizedException', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: 'uid1', jti: 'j1' });
      refreshModel.findOneAndUpdate.mockResolvedValue(null);
      await expect(service.refresh('some.refresh.token')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('사용하지 않은 토큰만 한 번의 갱신으로 폐기하고 새 토큰을 발급한다(회전)', async () => {
      jwt.verifyAsync.mockResolvedValue({ sub: 'uid1', jti: 'j1' });
      refreshModel.findOneAndUpdate.mockResolvedValue({});
      userModel.findById.mockResolvedValue({ _id: { toString: () => 'uid1' }, role: 'user' });

      const tokens = await service.refresh('some.refresh.token');

      const filter = refreshModel.findOneAndUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(filter.revokedAt).toEqual({ $exists: false });
      expect(refreshModel.create).toHaveBeenCalledOnce();
      expect(tokens.accessToken).toBe('signed.jwt.token');
    });
  });

  describe('logout', () => {
    it('해당 토큰을 폐기 처리한다', async () => {
      await service.logout('some.refresh.token');
      expect(refreshModel.updateOne).toHaveBeenCalledOnce();
    });
  });
});
