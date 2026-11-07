import { NotFoundException } from '@nestjs/common';
import type { Model } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import type { SocialLoginAttemptDocument } from '../src/modules/auth/schemas/social-login-attempt.schema.js';
import { SocialLoginService } from '../src/modules/auth/social-login/social-login.service.js';
import { SocialProviderRegistry } from '../src/modules/auth/social-login/social-provider-registry.js';
import type { SocialProviderAdapter } from '../src/modules/auth/social-login/social-provider.js';
import type { SocialUserService } from '../src/modules/auth/social-login/social-user.service.js';

const adapter = (name: 'google' | 'kakao' | 'naver'): SocialProviderAdapter => ({
  name,
  buildAuthUrl: (state) => `https://${name}.example/authorize?state=${state}`,
  fetchProfile: () => Promise.resolve({ providerUid: `${name}-uid`, email: null, name: null }),
});

describe('SocialProviderRegistry', () => {
  it('이름으로 어댑터를 찾는다', () => {
    const google = adapter('google');
    const kakao = adapter('kakao');

    const registry = new SocialProviderRegistry([google, kakao]);

    expect(registry.find('google')).toBe(google);
    expect(registry.find('kakao')).toBe(kakao);
  });

  it('등록하지 않은 제공자는 찾지 못한다', () => {
    const registry = new SocialProviderRegistry([adapter('google')]);

    expect(registry.find('kakao')).toBeUndefined();
    expect(registry.find('naver')).toBeUndefined();
  });

  it.each([
    'Google',
    'GOOGLE',
    ' google',
    'google ',
    '',
    'facebook',
    '__proto__',
    'constructor',
    'toString',
  ])('이름이 정확히 같지 않으면(%j) 찾지 못한다', (name) => {
    const registry = new SocialProviderRegistry([adapter('google')]);

    expect(registry.find(name)).toBeUndefined();
  });

  it('같은 제공자를 두 번 등록하면 시작할 때 바로 실패한다', () => {
    expect(() => new SocialProviderRegistry([adapter('google'), adapter('google')])).toThrow(
      '중복 등록',
    );
  });

  it('아무것도 등록하지 않아도 만들 수 있고 아무것도 찾지 못한다', () => {
    const registry = new SocialProviderRegistry([]);

    expect(registry.names()).toEqual([]);
    expect(registry.find('google')).toBeUndefined();
  });

  it('등록된 제공자 이름 목록을 돌려준다', () => {
    const registry = new SocialProviderRegistry([
      adapter('google'),
      adapter('kakao'),
      adapter('naver'),
    ]);

    expect(registry.names()).toEqual(['google', 'kakao', 'naver']);
  });
});

describe('SocialLoginService가 제공자를 고르는 방식', () => {
  function setup(...adapters: SocialProviderAdapter[]) {
    const saved: { provider: string; oauthState: string }[] = [];
    const attempts = {
      create: (data: { provider: string; oauthState: string }) => {
        saved.push(data);
        return Promise.resolve(data);
      },
    } as unknown as Model<SocialLoginAttemptDocument>;
    const service = new SocialLoginService(new SocialProviderRegistry(adapters), attempts, {
      findOrCreate: vi.fn(),
    } as unknown as SocialUserService);
    return { service, saved };
  }
  const PARAMS = { appState: 'a'.repeat(32), codeChallenge: 'c'.repeat(43) };

  it('시작: 고른 제공자의 로그인 주소를 돌려주고 시도에 그 제공자 이름을 저장한다', async () => {
    const s = setup(adapter('google'), adapter('kakao'));

    const href = await s.service.start('kakao', PARAMS);

    expect(href.startsWith('https://kakao.example/authorize?state=')).toBe(true);
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0]!.provider).toBe('kakao');
    expect(new URL(href).searchParams.get('state')).toBe(s.saved[0]!.oauthState);
  });

  it('시작: 제공자마다 자기 주소를 만든다 (섞이지 않는다)', async () => {
    const s = setup(adapter('google'), adapter('kakao'), adapter('naver'));

    const urls = await Promise.all(
      ['google', 'kakao', 'naver'].map((p) => s.service.start(p, PARAMS)),
    );

    expect(urls[0]).toContain('google.example');
    expect(urls[1]).toContain('kakao.example');
    expect(urls[2]).toContain('naver.example');
    expect(s.saved.map((a) => a.provider)).toEqual(['google', 'kakao', 'naver']);
  });

  it('등록하지 않은 제공자로 시작하면 404이고 시도를 저장하지 않는다', async () => {
    const s = setup(adapter('google'));

    const error = await s.service.start('kakao', PARAMS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toEqual({
      code: 'NOT_FOUND',
      message: expect.any(String),
    });
    expect(s.saved).toHaveLength(0);
  });

  it('등록하지 않은 제공자의 콜백은 404이다', async () => {
    const s = setup(adapter('google'));

    const error = await s.service
      .handleCallback('naver', { oauthState: 'x'.repeat(43), code: 'c', error: null })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
  });
});
