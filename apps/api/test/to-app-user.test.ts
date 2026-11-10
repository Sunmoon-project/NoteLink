import { AuthTokens, User } from '@notelink/shared';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';

import { toAppUser, type UserSource } from '../src/modules/auth/to-app-user.js';

// packages/shared/src/schemas.ts 의 User 가 요구하는 필드 · 설정 이름
const USER_FIELDS = [
  '_id',
  'email',
  'nickname',
  'role',
  'learnerType',
  'pointBalance',
  'settings',
  'status',
  'interestCategoryIds',
  'streakDays',
  'createdAt',
];
const SETTINGS_FIELDS = [
  'resumePlayback',
  'keepScreenOnWhileRecording',
  'subtitleLanguage',
  'pageTurn',
  'offlineCache',
  'theme',
  'doubleTapEraser',
  'leftHanded',
];

const id = new Types.ObjectId();
const createdAt = new Date('2026-01-02T03:04:05.678Z');

/** 소셜 로그인으로 막 가입한 사용자의 DB 문서(기본값만 있다) */
const fresh = (): UserSource => ({
  _id: id,
  email: 'student@example.com',
  nickname: '김노트',
  role: 'user',
  learnerType: null,
  pointBalance: 0,
  settings: {},
  status: 'active',
  interestCategoryIds: [],
  createdAt,
});

describe('toAppUser', () => {
  describe('앱이 기대하는 User 모양', () => {
    it('필수 필드를 모두 가진다', () => {
      expect(Object.keys(toAppUser(fresh())).sort()).toEqual([...USER_FIELDS].sort());
    });

    it('설정은 앱이 읽는 8개 필드가 모두 채워진다 (비어 있는 DB 기본값 {}여도)', () => {
      expect(Object.keys(toAppUser(fresh()).settings).sort()).toEqual([...SETTINGS_FIELDS].sort());
    });

    it('JSON으로 보내도 값이 보존된다 (ObjectId · Date가 문자열이 된다)', () => {
      const sent = JSON.parse(JSON.stringify(toAppUser(fresh()))) as Record<string, unknown>;

      expect(sent['_id']).toBe(String(id));
      expect(sent['createdAt']).toBe('2026-01-02T03:04:05.678Z');
      expect(typeof sent['_id']).toBe('string');
    });

    it('직렬화하기 전에도 _id는 문자열이다 (타입 AppUser 그대로)', () => {
      const user = toAppUser(fresh());

      expect(typeof user._id).toBe('string');
      expect(user._id).toBe(String(id));
    });

    it('createdAt은 UTC ISO 문자열이다 (끝이 Z)', () => {
      expect(toAppUser(fresh()).createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe('앱의 검증 스키마(packages/shared)로 파싱된다', () => {
    // 앱이 실제로 쓰는 zod 스키마다. 앱의 User 모양이 바뀌면 이 테스트가 먼저 깨져서 서버가 조용히 어긋나지 않는다
    const sent = (user: UserSource) => JSON.parse(JSON.stringify(toAppUser(user))) as unknown;

    it('가입 직후 사용자(기본값만 있음)', () => {
      expect(User.safeParse(sent(fresh())).success).toBe(true);
    });

    it('값이 모두 채워진 사용자', () => {
      const full: UserSource = {
        ...fresh(),
        role: 'admin',
        learnerType: 'worker',
        pointBalance: 1240,
        settings: { theme: 'dark', leftHanded: true, pageTurn: 'tap' },
        status: 'resting',
        interestCategoryIds: [new Types.ObjectId(), new Types.ObjectId()],
      };

      expect(User.safeParse(sent(full)).success).toBe(true);
    });

    it('이메일이 없는 소셜 사용자', () => {
      expect(User.safeParse(sent({ ...fresh(), email: null })).success).toBe(true);
    });

    it('로그인 응답 전체(AuthTokens)의 user 자리에 들어간다', () => {
      const body = { accessToken: 'a', refreshToken: 'b', user: sent(fresh()) };

      expect(AuthTokens.safeParse(body).success).toBe(true);
    });

    it('파싱이 실패하면 그 이유를 알 수 있다 (스키마가 실제로 검증하고 있다는 확인)', () => {
      const broken = { ...(sent(fresh()) as Record<string, unknown>), streakDays: undefined };

      expect(User.safeParse(broken).success).toBe(false);
    });
  });

  describe('가입 직후 (DB에는 값이 비어 있다)', () => {
    it('학습자 유형이 null이어도 앱이 받을 수 있는 기본값을 준다', () => {
      expect(toAppUser(fresh()).learnerType).toBe('university');
    });

    it('설정은 앱의 기본값이다', () => {
      expect(toAppUser(fresh()).settings).toEqual({
        resumePlayback: true,
        keepScreenOnWhileRecording: true,
        subtitleLanguage: '한국어',
        pageTurn: 'swipe',
        offlineCache: false,
        theme: 'light',
        doubleTapEraser: true,
        leftHanded: false,
      });
    });

    it('연속 학습일 · 포인트는 0이다', () => {
      const user = toAppUser(fresh());

      expect(user.streakDays).toBe(0);
      expect(user.pointBalance).toBe(0);
    });

    it('관심 분야는 빈 배열이다', () => {
      expect(toAppUser(fresh()).interestCategoryIds).toEqual([]);
    });
  });

  describe('이미 값이 있는 사용자', () => {
    it('사용자가 정한 학습자 유형을 그대로 쓴다', () => {
      expect(toAppUser({ ...fresh(), learnerType: 'worker' }).learnerType).toBe('worker');
    });

    it('사용자가 바꾼 설정은 유지하고, 나머지는 기본값으로 채운다', () => {
      const user = toAppUser({ ...fresh(), settings: { theme: 'dark', leftHanded: true } });

      expect(user.settings.theme).toBe('dark');
      expect(user.settings.leftHanded).toBe(true);
      expect(user.settings.resumePlayback).toBe(true);
      expect(Object.keys(user.settings)).toHaveLength(8);
    });

    it('포인트 · 상태 · 관심 분야를 그대로 쓴다', () => {
      const cat = new Types.ObjectId();

      const user = toAppUser({
        ...fresh(),
        pointBalance: 1240,
        status: 'busy',
        interestCategoryIds: [cat],
      });

      expect(user.pointBalance).toBe(1240);
      expect(user.status).toBe('busy');
      expect(user.interestCategoryIds).toEqual([String(cat)]);
    });

    it('닉네임 · 이메일 · 역할을 그대로 쓴다', () => {
      const user = toAppUser({ ...fresh(), role: 'admin' });

      expect(user).toMatchObject({
        nickname: '김노트',
        email: 'student@example.com',
        role: 'admin',
      });
    });

    it('이메일이 없는 소셜 계정은 email이 null이다', () => {
      expect(toAppUser({ ...fresh(), email: null }).email).toBeNull();
      expect(toAppUser({ ...fresh(), email: undefined }).email).toBeNull();
    });
  });

  describe('DB 값이 앱이 모르는 값일 때 앱이 깨지지 않게 보정한다', () => {
    it.each(['teacher', '', 'University', 123, undefined])(
      '학습자 유형 %j는 기본값으로 바꾼다',
      (value) => {
        expect(toAppUser({ ...fresh(), learnerType: value as never }).learnerType).toBe(
          'university',
        );
      },
    );

    it.each(['sleeping', '', 'ACTIVE', 5, undefined, null])(
      '상태 %j는 active로 바꾼다',
      (value) => {
        expect(toAppUser({ ...fresh(), status: value as never }).status).toBe('active');
      },
    );

    it.each([-0.5, 1.5, NaN, '10', null, undefined])(
      '포인트 %j(정수가 아님)는 0으로 바꾼다',
      (value) => {
        expect(toAppUser({ ...fresh(), pointBalance: value as never }).pointBalance).toBe(0);
      },
    );

    it('허용된 상태 4가지는 그대로 쓴다', () => {
      for (const status of ['active', 'busy', 'resting', 'offline']) {
        expect(toAppUser({ ...fresh(), status }).status).toBe(status);
      }
    });

    it('createdAt이 없으면(아직 저장 전) 지금 시각으로 채운다', () => {
      const before = Date.now();

      const user = toAppUser({ ...fresh(), createdAt: undefined });

      expect(new Date(user.createdAt).getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  describe('앱에 내보내지 않는 값', () => {
    it('비밀번호 해시 · 소셜 연동 · 약관 · 삭제 시각 등 앱에 필요 없는 필드는 내보내지 않는다', () => {
      const dirty = {
        ...fresh(),
        passwordHash: '$2b$10$secret-hash-value',
        socialAccounts: [{ provider: 'google', providerUid: 'secret-uid' }],
        termAgreements: [{ termCode: 'x' }],
        deletedAt: new Date(),
        lastLoginAt: new Date(),
        __v: 0,
      } as UserSource;

      const json = JSON.stringify(toAppUser(dirty));

      expect(json).not.toContain('secret-hash-value');
      expect(json).not.toContain('secret-uid');
      expect(json).not.toContain('passwordHash');
      expect(json).not.toContain('socialAccounts');
      expect(json).not.toContain('termAgreements');
      expect(json).not.toContain('deletedAt');
      expect(Object.keys(toAppUser(dirty)).sort()).toEqual([...USER_FIELDS].sort());
    });

    it('settings 안에 섞여 있는 알 수 없는 값은 그대로 두되, 앱이 읽는 필드의 기본값을 덮어쓰지 않는다', () => {
      const user = toAppUser({ ...fresh(), settings: { futureFlag: true } });

      expect(user.settings['futureFlag']).toBe(true);
      expect(user.settings.theme).toBe('light');
    });
  });
});
