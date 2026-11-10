import { describe, expect, it } from 'vitest';

import { isSingleEmailAddress } from '../src/common/email-address.js';

describe('isSingleEmailAddress (사람 한 명의 주소인가)', () => {
  it.each([
    ['일반 주소', 'student@example.com'],
    ['플러스 주소', 'a+tag@example.com'],
    ['점이 있는 아이디', 'first.last@example.com'],
    ['하위 도메인', 'a@mail.example.co.kr'],
    ['아포스트로피(실제 쓰이는 주소)', "o'brien@example.com"],
    ['퓨니코드 최상위', 'a@example.xn--p1ai'],
    ['한글 아이디 (입력 규칙이 허용 — 발송 가능 여부는 SMTP 서버가 정한다)', '학생@example.com'],
    ['하이픈 · 밑줄', 'a_b-c@my-host.example.com'],
  ])('%s는 통과한다', (_name, value) => {
    expect(isSingleEmailAddress(value)).toBe(true);
  });

  it.each([
    ['쉼표로 다른 사람을 끼워 넣음', 'x1,victim@example.com'],
    ['쉼표로 두 주소', 'a@example.com,b@example.com'],
    ['세미콜론', 'a@example.com;b@example.com'],
    ['아이디 안의 세미콜론 (@가 하나뿐이라 다른 규칙으로는 못 거른다)', 'x;victim@example.com'],
    ['아이디 안의 콜론', 'x:victim@example.com'],
    ['아이디 안의 쉼표', 'x,victim@example.com'],
    ['도메인 쪽 쉼표', 'a@example.com,example.org'],
    ['꺾쇠(이름 <주소>)', 'Name <a@example.com>'],
    ['꺾쇠만', '<a@example.com>'],
    ['여는 꺾쇠', 'a@example.com<'],
    ['따옴표', '"x,y"@example.com'],
    ['작은따옴표 대신 큰따옴표 하나', 'a"b@example.com'],
    ['괄호(주석)', 'a(comment)@example.com'],
    ['대괄호(IP 도메인)', 'a@[127.0.0.1]'],
    ['역슬래시', 'a\\b@example.com'],
    ['콜론(그룹 문법)', 'group:a@example.com;'],
    ['공백으로 두 주소', 'a@example.com b@example.com'],
    ['앞 공백', ' a@example.com'],
    ['줄바꿈으로 헤더 끼워 넣기', 'a@example.com\r\nBcc: evil@example.com'],
    ['줄바꿈만', 'a@example.com\n'],
    ['탭', 'a@exa\tmple.com'],
    ['널 문자', 'a@example.com\u0000'],
    ['삭제 문자', 'a@example\u007f.com'],
    ['@ 없음', 'student.example.com'],
    ['@ 두 개', 'a@b@example.com'],
    ['아이디 없음', '@example.com'],
    ['도메인 없음', 'a@'],
    ['빈 문자열', ''],
  ])('%s는 거부한다', (_name, value) => {
    expect(isSingleEmailAddress(value)).toBe(false);
  });

  it('제어문자는 하나도 빠짐없이 거부한다 (0x00~0x1f, 0x7f)', () => {
    const codes = [...Array.from({ length: 0x20 }, (_, i) => i), 0x7f];

    for (const code of codes) {
      const char = String.fromCharCode(code);
      expect(isSingleEmailAddress(`a${char}b@example.com`), `0x${code.toString(16)}`).toBe(false);
    }
  });

  it('제어문자 바로 옆 글자(0x20 공백 · 0x7e)는 각각 공백 규칙과 허용 문자로 구분된다', () => {
    expect(isSingleEmailAddress('a~b@example.com')).toBe(true); // 0x7e는 허용
    expect(isSingleEmailAddress('a b@example.com')).toBe(false); // 0x20은 공백 규칙으로 거부
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['숫자', 123],
    ['배열', ['a@example.com']],
    ['객체', { address: 'a@example.com' }],
    ['불리언', true],
  ])('문자열이 아니면(%s) 거부한다', (_name, value) => {
    expect(isSingleEmailAddress(value)).toBe(false);
  });
});
