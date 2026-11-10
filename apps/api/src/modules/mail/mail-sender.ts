import { Injectable, Logger } from '@nestjs/common';

/** `MailSender` 구현을 이 이름으로 넣어 둔다(MailModule에서 연결) */
export const MAIL_SENDER = 'MAIL_SENDER';

/** 메일을 보낼 수 없는 상태(발송 수단이 설정되지 않았거나, 보내다 실패했다) */
export class MailUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailUnavailableError';
  }
}

/**
 * 가입 · 로그인 과정에서 나가는 메일. 어떤 발송 수단(Azure Communication Services, SMTP 등)을 쓰든
 * 이 모양만 맞추면 되도록 분리해 둔다. 메일 본문과 제목은 구현이 정한다.
 */
export interface MailSender {
  /** 가입용 인증번호를 보낸다. `code`는 메일 본문에만 쓰고 어디에도 저장 · 기록하지 않는다 */
  sendVerificationCode(to: string, code: string): Promise<void>;
  /**
   * 이미 가입한 이메일로 가입을 시도했을 때 알린다. 인증번호는 보내지 않는다.
   * (가입 여부를 화면 응답으로 알려 주면 남의 가입 여부를 조회할 수 있어, 메일로만 알린다)
   */
  sendAlreadyRegistered(to: string): Promise<void>;
}

/**
 * 메일을 보내는 대신 서버 로그에 남긴다. **개발 환경 전용**이다.
 * 인증번호를 로그에 남기므로, `MAIL_TRANSPORT=log`로 명시했을 때만 로그를 남기고 그 밖에는 모두 거부한다.
 * (환경 구분이 빠졌을 때 개발 방식으로 오인해 운영 로그에 인증번호가 남는 사고를 막는 안전한 기본값)
 */
@Injectable()
export class LogMailSender implements MailSender {
  private readonly logger = new Logger('Mail');

  constructor(private readonly enabled: boolean) {}

  // async로 선언해, 거부도 동기 예외가 아니라 항상 거절된 Promise로 나가게 한다(인터페이스가 Promise를 약속한다)
  async sendVerificationCode(to: string, code: string): Promise<void> {
    this.ensureEnabled();
    this.logger.warn(`[개발용 메일] 가입 인증번호 → ${to}: ${code}`);
  }

  async sendAlreadyRegistered(to: string): Promise<void> {
    this.ensureEnabled();
    this.logger.warn(`[개발용 메일] 이미 가입한 이메일입니다 → ${to}`);
  }

  private ensureEnabled(): void {
    if (!this.enabled) {
      throw new MailUnavailableError('메일 발송 수단이 설정되지 않았습니다 (MAIL_TRANSPORT)');
    }
  }
}
