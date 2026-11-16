import { createHash, randomBytes } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { APP_REDIRECT_URI } from '../src/modules/auth/social-login/social-login.constants.js';
import {
  parseSocialStartQuery,
  VALIDATION_FAILED,
} from '../src/modules/auth/social-login/social-start-query.js';

// 앱(apps/mobile/src/lib/social-auth.ts)이 만드는 값과 같은 방식으로 만든다
const appState = randomBytes(16).toString('hex');
const codeVerifier = randomBytes(32).toString('hex');
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

const VALID: Record<string, unknown> = {
  redirect: APP_REDIRECT_URI,
  state: appState,
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
};

function queryOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...VALID, ...overrides };
}

/** 400과 { code, message } 형식인지 확인하고 오류를 돌려준다 */
function failure(query: Record<string, unknown>): BadRequestException {
  try {
    parseSocialStartQuery(query);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return error as BadRequestException;
  }
  throw new Error('오류가 나야 하는데 통과했다');
}

describe('parseSocialStartQuery', () => {
  describe('정상', () => {
    it('앱이 실제로 만드는 값을 통과시키고 state와 code_challenge를 돌려준다', () => {
      expect(parseSocialStartQuery(queryOf())).toEqual({ appState, codeChallenge });
    });

    it('앱이 만드는 code_challenge는 43자이다 (서버가 기대하는 길이와 맞는지)', () => {
      expect(codeChallenge).toHaveLength(43);
    });

    it('정상 값은 문자열 그대로 돌려준다 (배열 · 객체가 아니다)', () => {
      const result = parseSocialStartQuery(queryOf());

      expect(typeof result.appState).toBe('string');
      expect(typeof result.codeChallenge).toBe('string');
    });

    it('알 수 없는 쿼리가 더 있어도 무시한다', () => {
      expect(parseSocialStartQuery(queryOf({ extra: 'x' }))).toEqual({ appState, codeChallenge });
    });

    it.each([16, 32, 128])('state %i자는 허용한다', (length) => {
      const state = 'a'.repeat(length);

      expect(parseSocialStartQuery(queryOf({ state })).appState).toBe(state);
    });

    it('state에 영문 대소문자 · 숫자 · - · _ 를 쓸 수 있다', () => {
      const state = 'Ab09-_Ab09-_Ab09-_';

      expect(parseSocialStartQuery(queryOf({ state })).appState).toBe(state);
    });
  });

  describe('redirect (앱 복귀 주소)', () => {
    it.each([
      ['다른 앱 주소', 'evil://auth/callback'],
      ['웹 주소', 'https://evil.example/callback'],
      ['경로만 다름', 'notelink://auth/other'],
      ['끝에 /', `${APP_REDIRECT_URI}/`],
      ['쿼리 추가', `${APP_REDIRECT_URI}?x=1`],
      ['대문자', 'NOTELINK://auth/callback'],
      ['앞에 공백', ` ${APP_REDIRECT_URI}`],
      ['접두사만 같음', `${APP_REDIRECT_URI}.evil.example`],
    ])('%s는 거부한다', (_reason, redirect) => {
      const error = failure(queryOf({ redirect }));

      expect(error.getStatus()).toBe(400);
      expect(error.getResponse()).toMatchObject({ code: VALIDATION_FAILED });
      expect(JSON.stringify(error.getResponse())).toContain('redirect');
    });
  });

  describe('필수 쿼리', () => {
    it.each(['redirect', 'state', 'code_challenge', 'code_challenge_method'])(
      '%s가 없으면 400 { code, message } 로 거부한다',
      (field) => {
        const error = failure(queryOf({ [field]: undefined }));

        expect(error.getStatus()).toBe(400);
        expect(error.getResponse()).toEqual({
          code: VALIDATION_FAILED,
          message: expect.stringContaining(field),
        });
      },
    );

    it.each(['redirect', 'state', 'code_challenge', 'code_challenge_method'])(
      '%s가 빈 문자열이면 거부한다',
      (field) => {
        expect(failure(queryOf({ [field]: '' })).getResponse()).toMatchObject({
          code: VALIDATION_FAILED,
        });
      },
    );
  });

  describe('문자열이 아닌 값 (같은 쿼리를 여러 번 보내거나 객체로 보낸 경우)', () => {
    // 원소가 하나인 배열은 문자열로 바뀌어 정규식을 통과할 수 있다(['abc'] → 'abc'). 값이 배열인 채로 돌려주면 안 된다
    it.each(['state', 'code_challenge'])('%s가 원소 하나짜리 배열이면 거부한다', (field) => {
      const valid = field === 'state' ? appState : codeChallenge;

      expect(failure(queryOf({ [field]: [valid] })).getResponse()).toMatchObject({
        code: VALIDATION_FAILED,
      });
    });

    it.each([
      ['반복된 쿼리(배열)', [appState, appState]],
      ['객체', { $gt: '' }],
      ['숫자', 12345],
    ])('state가 %s이면 거부한다', (_reason, state) => {
      expect(failure(queryOf({ state })).getResponse()).toMatchObject({ code: VALIDATION_FAILED });
    });

    it('redirect가 배열이면 허용 주소가 들어 있어도 거부한다', () => {
      expect(failure(queryOf({ redirect: [APP_REDIRECT_URI] })).getResponse()).toMatchObject({
        code: VALIDATION_FAILED,
      });
    });
  });

  describe('state 형식', () => {
    it.each([
      ['15자(너무 짧음)', 'a'.repeat(15)],
      ['129자(너무 김)', 'a'.repeat(129)],
      ['공백 포함', `${'a'.repeat(16)} b`],
      ['특수문자 포함', `${'a'.repeat(16)}!`],
      ['줄바꿈 포함', `${'a'.repeat(16)}\n`],
      ['한글 포함', `${'a'.repeat(16)}가`],
      ['URL 구분자 포함', `${'a'.repeat(16)}&x=1`],
    ])('%s이면 거부한다', (_reason, state) => {
      const error = failure(queryOf({ state }));

      expect(error.getResponse()).toMatchObject({ code: VALIDATION_FAILED });
      expect(JSON.stringify(error.getResponse())).toContain('state');
    });
  });

  describe('code_challenge 형식', () => {
    it.each([
      ['42자(너무 짧음)', 'a'.repeat(42)],
      ['44자(너무 김)', 'a'.repeat(44)],
      ['base64의 + 포함(base64url이 아님)', `${'a'.repeat(42)}+`],
      ['base64의 / 포함', `${'a'.repeat(42)}/`],
      ['패딩 = 포함', `${'a'.repeat(42)}=`],
      ['공백 포함', `${'a'.repeat(42)} `],
    ])('%s이면 거부한다', (_reason, challenge) => {
      const error = failure(queryOf({ code_challenge: challenge }));

      expect(error.getResponse()).toMatchObject({ code: VALIDATION_FAILED });
      expect(JSON.stringify(error.getResponse())).toContain('code_challenge');
    });
  });

  describe('code_challenge_method', () => {
    it.each(['plain', 's256', 'S512', 'S256 '])('%j는 거부한다 (S256만 지원)', (method) => {
      const error = failure(queryOf({ code_challenge_method: method }));

      expect(error.getResponse()).toMatchObject({ code: VALIDATION_FAILED });
      expect(JSON.stringify(error.getResponse())).toContain('code_challenge_method');
    });
  });

  it('오류 문구에 받은 값을 넣지 않는다 (state · code_challenge가 응답에 되비치지 않게)', () => {
    const secret = `${'z'.repeat(20)}!!`;

    for (const field of ['state', 'code_challenge', 'redirect', 'code_challenge_method']) {
      const error = failure(queryOf({ [field]: secret }));

      expect(JSON.stringify(error.getResponse())).not.toContain(secret);
    }
  });
});
