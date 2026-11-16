import { Types, model, models } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  SOCIAL_PROVIDERS,
  SocialLoginAttempt,
  SocialLoginAttemptSchema,
} from '../src/modules/auth/schemas/social-login-attempt.schema.js';

// 연결 없이 만든 모델로 validateSync()만 쓴다. 감시 모드에서 다시 불러와도 같은 이름을 두 번 만들지 않는다
const Attempt =
  models['SocialLoginAttemptTest'] ??
  model<SocialLoginAttempt>('SocialLoginAttemptTest', SocialLoginAttemptSchema);

const VALID = {
  provider: 'google',
  oauthState: 'server-state',
  appState: 'app-state',
  codeChallenge: 'code-challenge',
  expiresAt: new Date('2026-01-01T00:10:00Z'),
};

/** 정상 값에서 일부만 바꾼 문서를 만든다. undefined를 주면 그 필드가 없는 상태가 된다 */
function attemptOf(overrides: Record<string, unknown> = {}) {
  return new Attempt({ ...VALID, ...overrides });
}

function indexOf(key: string) {
  return SocialLoginAttemptSchema.indexes().find(([keys]) => key in keys);
}

describe('SocialLoginAttempt 스키마', () => {
  describe('컬렉션', () => {
    it('이름은 snake_case 복수형이다 (README의 DB 규칙)', () => {
      expect(SocialLoginAttemptSchema.get('collection')).toBe('social_login_attempts');
    });

    it('생성 · 수정 시각을 자동으로 기록한다', () => {
      expect(SocialLoginAttemptSchema.get('timestamps')).toBe(true);
    });
  });

  describe('필수값', () => {
    it('정상 값이면 검증을 통과한다', () => {
      expect(attemptOf().validateSync()).toBeUndefined();
    });

    it.each(['provider', 'oauthState', 'appState', 'codeChallenge', 'expiresAt'])(
      '%s가 없으면 실패한다',
      (field) => {
        const error = attemptOf({ [field]: undefined }).validateSync();

        expect(error?.errors[field]).toBeDefined();
      },
    );

    it('필수 필드를 모두 빼면 다섯 개가 한꺼번에 걸린다', () => {
      const error = new Attempt({}).validateSync();

      expect(Object.keys(error?.errors ?? {}).sort()).toEqual(
        ['appState', 'codeChallenge', 'expiresAt', 'oauthState', 'provider'].sort(),
      );
    });
  });

  describe('provider', () => {
    // 앱이 보내는 값과 같아야 한다(packages/shared SocialProvider: kakao · naver · google)
    it('앱과 같은 세 제공자만 정의한다', () => {
      expect([...SOCIAL_PROVIDERS].sort()).toEqual(['google', 'kakao', 'naver']);
    });

    it.each(SOCIAL_PROVIDERS)('%s는 허용한다', (provider) => {
      expect(attemptOf({ provider }).validateSync()).toBeUndefined();
    });

    it.each(['facebook', 'Google', 'GOOGLE', ''])('%j는 거부한다', (provider) => {
      expect(attemptOf({ provider }).validateSync()?.errors['provider']).toBeDefined();
    });
  });

  describe('제공자 인증이 끝나기 전의 기본값', () => {
    it('userId와 codeHash는 null이다', () => {
      const attempt = attemptOf();

      expect(attempt.userId).toBeNull();
      expect(attempt.codeHash).toBeNull();
    });

    it('제공자 인증이 끝나면 userId와 codeHash를 채울 수 있다', () => {
      const userId = new Types.ObjectId();
      const attempt = attemptOf({ userId, codeHash: 'a'.repeat(64) });

      expect(attempt.validateSync()).toBeUndefined();
      expect(attempt.userId?.equals(userId)).toBe(true);
      expect(attempt.codeHash).toBe('a'.repeat(64));
    });
  });

  describe('인덱스', () => {
    it('oauthState는 유일하다 (콜백이 시도를 하나만 찾도록)', () => {
      expect(indexOf('oauthState')?.[1]).toMatchObject({ unique: true });
    });

    it('expiresAt은 만료 시각이 지나면 바로 지우는 TTL 인덱스다', () => {
      expect(indexOf('expiresAt')?.[1]).toMatchObject({ expireAfterSeconds: 0 });
    });

    it('codeHash는 문자열인 문서끼리만 유일하다 (아직 코드가 없는 null끼리는 겹쳐도 됨)', () => {
      expect(indexOf('codeHash')?.[1]).toMatchObject({
        unique: true,
        partialFilterExpression: { codeHash: { $type: 'string' } },
      });
    });

    it('인덱스는 이 세 개뿐이다', () => {
      const keys = SocialLoginAttemptSchema.indexes().map(([k]) => Object.keys(k).join(','));

      expect(keys.sort()).toEqual(['codeHash', 'expiresAt', 'oauthState']);
    });
  });
});
