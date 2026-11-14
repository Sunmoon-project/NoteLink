import { Logger } from '@nestjs/common';

import { isSingleEmailAddress } from '../../common/email-address.js';
import {
  alreadyRegisteredMessage,
  noAccountMessage,
  recoveryCodeMessage,
  verificationCodeMessage,
  type MailMessage,
} from './mail-messages.js';
import { MailUnavailableError, type MailSender } from './mail-sender.js';

/** 메일 발송을 요청하고 결과를 기다리는 최대 시간. 넘기면 가입 화면이 오래 멈추지 않도록 포기한다 */
export const SMTP_SEND_TIMEOUT_MS = 15_000;

/** 호출하는 쪽에 돌려주는 고정 문구. 라이브러리 오류 문구에는 서버 주소나 받는 사람이 섞일 수 있어 그대로 쓰지 않는다 */
export const MAIL_SEND_FAILED_MESSAGE = '메일을 보내지 못했습니다';

/** 주소 하나의 최대 길이(RFC 5321) */
const RECIPIENT_MAX_LENGTH = 254;

/** 받는 사람 한 명(문자열이 아니라 주소 객체로 넘기면 라이브러리가 쉼표 등으로 나누지 않는다) */
export interface SmtpRecipient {
  address: string;
}

/** 보낼 메일 한 통 */
export interface SmtpOutgoingMail {
  from: string;
  to: SmtpRecipient;
  subject: string;
  text: string;
}

/**
 * 메일 **한 통을 보내기 위한** 전용 전송 수단. 발송마다 새로 만든다.
 * 시간 초과 때 `abort()`로 이 전송이 연 연결만 끊으며, 같은 시각의 다른 발송에는 영향이 없다.
 */
export interface SmtpTransport {
  sendMail(message: SmtpOutgoingMail): Promise<unknown>;
  /** 진행 중인 연결을 끊는다. 이미 끝났거나 연결이 없어도 오류 없이 끝난다 */
  abort(): void;
}

/** 발송 한 건마다 전용 `SmtpTransport`를 만든다 */
export type SmtpTransportFactory = () => SmtpTransport;

/**
 * SMTP 서버로 메일을 보낸다.
 *
 * - 서버가 메일을 받아 줄 때까지만 기다린다. 인증 실패 · 연결 실패 같은 오류는 여기서 드러난다.
 *   받는 사람의 편지함에 닿았는지는 알 수 없다.
 * - 받는 사람은 단일 주소만 허용하고 주소 객체로 전달한다. 쉼표 등으로 여러 명에게 퍼지지 않는다.
 * - 전체 시간 제한을 넘기면 **그 발송의 연결을 끊는다**. 기다림만 포기하면 연결이 살아 있다가
 *   서버가 늦게 응답했을 때 메일이 나중에 나갈 수 있다. 연결은 발송마다 따로라서 다른 발송은 끊기지 않는다.
 * - 실패하면 원인을 `MailUnavailableError`(고정 문구)로 바꿔 던진다. 접속 정보 · 받는 사람 · 인증번호는
 *   오류 문구와 로그에 넣지 않는다.
 */
export class SmtpMailSender implements MailSender {
  private readonly logger = new Logger('Mail');

  constructor(
    private readonly openTransport: SmtpTransportFactory,
    private readonly from: string,
    private readonly timeoutMs: number = SMTP_SEND_TIMEOUT_MS,
  ) {}

  sendVerificationCode(to: string, code: string): Promise<void> {
    return this.send(to, verificationCodeMessage(code));
  }

  sendAlreadyRegistered(to: string): Promise<void> {
    return this.send(to, alreadyRegisteredMessage());
  }

  sendRecoveryCode(to: string, code: string): Promise<void> {
    return this.send(to, recoveryCodeMessage(code));
  }

  sendNoAccount(to: string): Promise<void> {
    return this.send(to, noAccountMessage());
  }

  private async send(to: string, message: MailMessage): Promise<void> {
    let transport: SmtpTransport | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      if (!isSingleRecipient(to)) {
        // 라이브러리에 넘기기 전에 거부한다(받는 사람 값은 오류 문구와 로그에 넣지 않는다)
        throw Object.assign(new Error('invalid recipient'), { code: 'EENVELOPE' });
      }
      transport = this.openTransport();
      const sending = transport.sendMail({
        from: this.from,
        to: { address: to },
        subject: message.subject,
        text: message.text,
      });
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })),
          this.timeoutMs,
        );
      });
      // race가 sending에도 처리기를 붙이므로, 포기한 뒤에 늦게 실패해도 처리되지 않은 거부가 되지 않는다
      await Promise.race([sending, timeout]);
    } catch (error) {
      // 기다림만 끝내면 연결이 살아 있어 메일이 나중에 나갈 수 있다. 이 발송의 연결을 끊는다
      abortQuietly(transport);
      // 오류 종류와 응답 코드만 남긴다(오류 문구에는 서버 주소나 받는 사람이 섞일 수 있다)
      this.logger.error(`SMTP 메일 발송 실패 (${describeFailure(error)})`);
      throw new MailUnavailableError(MAIL_SEND_FAILED_MESSAGE);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 받는 사람 하나로 쓸 수 있는 주소인지 */
function isSingleRecipient(address: unknown): address is string {
  // 라이브러리는 문자열 수신자를 쉼표 등으로 나눠 여러 명에게 보낸다(`x1,victim@example.com`은 victim에게 간다).
  // 앞단의 입력 검증이 느슨해져도 엉뚱한 사람에게 가지 않도록, 발송 직전에 같은 규칙으로 한 번 더 거른다.
  return isSingleEmailAddress(address) && address.length <= RECIPIENT_MAX_LENGTH;
}

/** 연결을 끊다가 나는 오류가 원래 오류를 가리지 않게 한다 */
function abortQuietly(transport: SmtpTransport | undefined): void {
  try {
    transport?.abort();
  } catch {
    // 이미 끊겼거나 닫는 중이다
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
