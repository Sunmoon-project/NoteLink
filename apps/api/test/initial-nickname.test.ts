import { describe, expect, it } from 'vitest';

import {
  initialNickname,
  NICKNAME_MAX,
  NICKNAME_MIN,
} from '../src/modules/auth/social-login/initial-nickname.js';

// 앱(apps/mobile/src/lib/validation.ts nicknameError)의 규칙과 같은지 확인하는 기준
const APP_RULE = /^[가-힣A-Za-z0-9]{2,10}$/;

const fixed = () => '0042';

describe('initialNickname', () => {
  describe('이름을 그대로 쓸 수 있는 경우', () => {
    it.each(['김노트', 'Student', '노트123', 'ab', '가나'])('%s는 그대로 쓴다', (name) => {
      expect(initialNickname(name, fixed)).toBe(name);
    });

    it('앞뒤 공백은 지운다', () => {
      expect(initialNickname('  김노트  ', fixed)).toBe('김노트');
    });
  });

  describe('허용되지 않는 글자는 뺀다', () => {
    it.each([
      ['중간 공백', 'Kim Note', 'KimNote'],
      ['특수문자', '김.노-트_!', '김노트'],
      ['이모지', '김노트😀', '김노트'],
      ['점 · 가운뎃점', '김·노트', '김노트'],
      ['따옴표', '"김노트"', '김노트'],
      ['줄바꿈 · 탭', '김\n노\t트', '김노트'],
      ['일본어 · 중국어 글자', '김ノート노트', '김노트'],
      ['전각 숫자', '김노트１２', '김노트'],
    ])('%s: %s', (_reason, name, expected) => {
      expect(initialNickname(name, fixed)).toBe(expected);
    });
  });

  describe('길이', () => {
    it('10자를 넘으면 앞 10자만 쓴다', () => {
      const result = initialNickname('가나다라마바사아자차카타', fixed);

      expect(result).toBe('가나다라마바사아자차');
      expect(Array.from(result)).toHaveLength(NICKNAME_MAX);
    });

    it('정확히 10자는 그대로 쓴다', () => {
      expect(initialNickname('가나다라마바사아자차', fixed)).toBe('가나다라마바사아자차');
    });

    it('특수문자를 뺀 뒤의 길이로 센다', () => {
      expect(initialNickname('가-나-다-라-마-바-사-아-자-차-카', fixed)).toBe(
        '가나다라마바사아자차',
      );
    });

    it('영문 긴 이름도 10자로 자른다', () => {
      expect(initialNickname('Christopher-Alexander', fixed)).toBe('Christophe');
    });
  });

  describe('대체 닉네임 (남은 글자가 2자 미만)', () => {
    it.each([
      ['이름이 없음(null)', null],
      ['빈 문자열', ''],
      ['공백뿐', '    '],
      ['특수문자뿐', '!@#$%^&*()'],
      ['이모지뿐', '😀😀😀'],
      ['허용되지 않는 언어뿐', 'ノートノート'],
      ['허용되는 글자가 한 개뿐', '김!'],
    ])('%s이면 사용자 + 숫자로 대신한다', (_reason, name) => {
      expect(initialNickname(name, fixed)).toBe('사용자0042');
    });

    it('2자는 대체하지 않는다 (경계값)', () => {
      expect(initialNickname('김노', fixed)).toBe('김노');
    });

    it('숫자는 4자리이고 앞이 0으로 채워진다', () => {
      expect(initialNickname(null, () => '0007')).toBe('사용자0007');
    });
  });

  describe('앱 규칙과의 일치', () => {
    it.each([
      '김노트',
      'Kim Note',
      '김.노-트!',
      '😀😀',
      null,
      '가나다라마바사아자차카타파하',
      'a',
      '한글Eng123456789',
      '  앞뒤공백  ',
    ])('어떤 이름(%j)이 들어와도 앱의 닉네임 규칙을 통과한다', (name) => {
      expect(initialNickname(name)).toMatch(APP_RULE);
    });

    it('기본 대체 닉네임(실제 난수)도 앱 규칙을 통과한다', () => {
      for (let i = 0; i < 200; i++) {
        expect(initialNickname(null)).toMatch(APP_RULE);
      }
    });

    it('최소 · 최대 길이는 앱과 같다', () => {
      expect(NICKNAME_MIN).toBe(2);
      expect(NICKNAME_MAX).toBe(10);
    });
  });

  it('조합형 한글(자모가 분리된 입력)도 완성형으로 맞춰 센다', () => {
    const decomposed = '김노트'.normalize('NFD');

    expect(initialNickname(decomposed, fixed)).toBe('김노트');
  });
});
