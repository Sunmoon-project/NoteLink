/**
 * 이메일 주소가 **사람 한 명**을 가리키는지 확인하는 공용 규칙.
 *
 * 메일 라이브러리는 문자열 수신자를 쉼표 · 세미콜론으로 나누고 `이름 <주소>` 꼴도 풀어 읽는다.
 * 그래서 `x1,victim@example.com`을 그대로 넘기면 victim에게 메일이 간다. 이런 문자가 하나라도 있으면
 * 한 명의 주소로 볼 수 없으므로, 입력을 받는 곳(`readEmail`)과 보내는 곳(`SmtpMailSender`)이 같은 규칙으로 거른다.
 *
 * 주소가 실제로 존재하는지, 한글 아이디처럼 일반 SMTP로 보낼 수 없는 주소인지는 여기서 따지지 않는다
 * (그건 입력 규칙과 SMTP 서버가 정한다). 여기서는 "여러 수신자나 헤더로 번질 수 있는가"만 본다.
 */

/** 주소를 나누거나 `이름 <주소>` · 따옴표 · 주석 꼴로 읽히게 만드는 문자 */
const SPLITTING_CHARACTERS = /[,;<>"()[\]\\:]/;
/** 줄바꿈 · 탭 · 널 같은 제어문자(헤더에 다른 줄을 끼워 넣는 데 쓰인다): 0x00~0x1f, 0x7f */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isSingleEmailAddress(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (SPLITTING_CHARACTERS.test(value) || hasControlCharacter(value)) return false;
  // 공백이 있으면 여러 주소로 읽힐 수 있다
  if (/\s/.test(value)) return false;
  // @는 정확히 하나, 양쪽은 비어 있지 않다
  const at = value.indexOf('@');
  return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1;
}
