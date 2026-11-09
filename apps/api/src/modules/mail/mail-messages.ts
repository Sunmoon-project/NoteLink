import { EMAIL_CODE_TTL_MS } from '../auth/app-login/email-code.service.js';

/** 보낼 메일 한 통. 어떤 발송 수단(SMTP 등)을 쓰든 제목과 본문은 같다 */
export interface MailMessage {
  subject: string;
  /** 일반 텍스트 본문. HTML을 쓰지 않아 메일 앱이 링크나 이미지를 제멋대로 열지 못한다 */
  text: string;
}

/**
 * 가입 인증번호 메일. 인증번호는 제목에 넣지 않는다(잠금 화면 알림에 번호가 그대로 보이지 않게).
 * 유효 시간은 서버가 실제로 쓰는 값(EMAIL_CODE_TTL_MS)에서 계산해 안내와 실제가 어긋나지 않게 한다.
 */
export function verificationCodeMessage(code: string): MailMessage {
  const minutes = Math.round(EMAIL_CODE_TTL_MS / 60_000);
  return {
    subject: '[NoteLink] 이메일 인증번호 안내',
    text: [
      'NoteLink 가입 인증번호입니다.',
      '',
      code,
      '',
      `이 번호는 ${minutes}분 동안만 유효합니다.`,
      '직접 요청하지 않았다면 이 메일을 무시해 주세요.',
    ].join('\n'),
  };
}

/**
 * 이미 가입한 이메일로 가입을 시도했을 때 보내는 안내. 인증번호는 담지 않는다.
 * (가입 여부를 화면 응답으로 알려 주면 남의 가입 여부를 조회할 수 있어 메일로만 알린다)
 */
export function alreadyRegisteredMessage(): MailMessage {
  return {
    subject: '[NoteLink] 이미 가입된 이메일입니다',
    text: [
      '이 이메일로 NoteLink 가입 요청이 있었지만, 이미 가입된 이메일입니다.',
      '',
      '앱에서 로그인해 주세요.',
      '직접 요청하지 않았다면 이 메일을 무시해 주세요.',
    ].join('\n'),
  };
}
