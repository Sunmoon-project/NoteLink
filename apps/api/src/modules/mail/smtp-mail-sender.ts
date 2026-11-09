import { Logger } from '@nestjs/common';

import {
  alreadyRegisteredMessage,
  verificationCodeMessage,
  type MailMessage,
} from './mail-messages.js';
import { MailUnavailableError, type MailSender } from './mail-sender.js';

/** 메일 발송을 요청하고 결과를 기다리는 최대 시간. 넘기면 가입 화면이 오래 멈추지 않도록 포기한다 */
export const SMTP_SEND_TIMEOUT_MS = 15_000;

/** 호출하는 쪽에 돌려주는 고정 문구. 라이브러리 오류 문구에는 서버 주소나 받는 사람이 섞일 수 있어 그대로 쓰지 않는다 */
export const MAIL_SEND_FAILED_MESSAGE = '메일을 보내지 못했습니다';

/** nodemailer의 `Transporter`에서 이 파일이 쓰는 부분만 뽑은 형태(테스트에서 가짜 객체를 넣기 쉽게 함) */
export interface SmtpTransport {
  sendMail(message: { from: string; to: string; subject: string; text: string }): Promise<unknown>;
}

/**
 * SMTP 서버로 메일을 보낸다.
 *
 * - 서버가 메일을 받아 줄 때까지만 기다린다. 인증 실패 · 연결 실패 같은 오류는 여기서 드러난다.
 *   받는 사람의 편지함에 닿았는지는 알 수 없다.
 * - 실패하면 원인을 `MailUnavailableError`(고정 문구)로 바꿔 던진다. 접속 정보 · 받는 사람 · 인증번호는
 *   오류 문구와 로그에 넣지 않는다.
 * - 라이브러리의 단계별 제한 시간과 별개로 전체 시간도 제한한다(단계마다 기다리면 합이 길어진다).
 */
export class SmtpMailSender implements MailSender {
  private readonly logger = new Logger('Mail');

  constructor(
    private readonly transport: SmtpTransport,
    private readonly from: string,
    private readonly timeoutMs: number = SMTP_SEND_TIMEOUT_MS,
  ) {}

  sendVerificationCode(to: string, code: string): Promise<void> {
    return this.send(to, verificationCodeMessage(code));
  }

  sendAlreadyRegistered(to: string): Promise<void> {
    return this.send(to, alreadyRegisteredMessage());
  }

  private async send(to: string, message: MailMessage): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const sending = this.transport.sendMail({
        from: this.from,
        to,
        subject: message.subject,
        text: message.text,
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
          this.timeoutMs,
        );
      });
      // race가 sending에도 처리기를 붙이므로, 시간이 지나 포기한 뒤에 늦게 실패해도 처리되지 않은 거부가 되지 않는다
      await Promise.race([sending, timeout]);
    } catch (error) {
      // 오류 종류와 응답 코드만 남긴다(오류 문구에는 서버 주소나 받는 사람이 섞일 수 있다)
      this.logger.error(`SMTP 메일 발송 실패 (${describeFailure(error)})`);
      throw new MailUnavailableError(MAIL_SEND_FAILED_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 라이브러리 오류에서 비밀이 아닌 부분(오류 코드 · SMTP 응답 코드 · 명령)만 뽑는다 */
function describeFailure(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'unknown';
  const { code, responseCode, command } = error as Record<string, unknown>;
  // 줄바꿈 등이 섞인 값이 로그 줄을 가를 수 없도록 짧은 식별자 꼴만 받는다
  const parts = [code, responseCode, command].filter(
    (v): v is string | number =>
      typeof v === 'number' || (typeof v === 'string' && /^[\w.-]{1,64}$/.test(v)),
  );
  return parts.length > 0 ? parts.join(' ') : 'unknown';
}
