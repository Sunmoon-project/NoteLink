// 가입 · 프로필 입력 검사. 문제가 없으면 null, 있으면 칸 아래에 보여 줄 안내를 돌려준다

/** 아이디@도메인.최상위(영문 2자 이상) · 공백 · 연속 점 없이 · 254자 이하 */
export function emailError(email: string): string | null {
  const v = email.trim();
  if (!v) return '이메일을 입력해 주세요';
  if (v.length > 254) return '이메일이 너무 길어요';
  if (!/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(v) || v.includes('..'))
    return '이메일 형식을 확인해 주세요 (예: you@example.com)';
  return null;
}

/** 8~64자 · 영문과 숫자를 모두 포함 · 공백 없이 */
export function passwordError(pw: string): string | null {
  if (!pw) return '비밀번호를 입력해 주세요';
  if (/\s/.test(pw)) return '비밀번호에는 공백을 넣을 수 없어요';
  if (pw.length < 8) return '비밀번호는 8자 이상이어야 해요';
  if (pw.length > 64) return '비밀번호는 64자 이하로 정해 주세요';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return '영문과 숫자를 모두 넣어 주세요';
  return null;
}

export function confirmError(pw: string, confirm: string): string | null {
  if (!confirm) return '비밀번호를 한 번 더 입력해 주세요';
  return pw === confirm ? null : '비밀번호가 서로 달라요';
}

/** 앞뒤 공백을 뺀 2~10자 · 한글 · 영문 · 숫자만 */
export function nicknameError(nick: string): string | null {
  const v = nick.trim();
  if (v.length < 2 || v.length > 10) return '닉네임은 2~10자로 정해 주세요';
  if (!/^[가-힣A-Za-z0-9]+$/.test(v)) return '닉네임은 한글 · 영문 · 숫자만 쓸 수 있어요';
  return null;
}
