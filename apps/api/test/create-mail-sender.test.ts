import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMailSender, createSmtpTransport } from '../src/modules/mail/create-mail-sender.js';
import { LogMailSender } from '../src/modules/mail/mail-sender.js';
import { SmtpMailSender, type SmtpTransport } from '../src/modules/mail/smtp-mail-sender.js';

const config = (values: Record<string, string | undefined>) => ({ get: (k: string) => values[k] });

const SMTP = {
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PORT: '587',
  SMTP_USER: 'noreply@example.com',
  SMTP_PASS: 'app-password',
  MAIL_FROM: 'noreply@example.com',
};

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

function fakeFactory() {
  const sendMail = vi.fn((_m: unknown) => Promise.resolve({}));
  const createFor = vi.fn((_c: unknown): SmtpTransport => ({ sendMail }));
  return { sendMail, createFor };
}

describe('createMailSender MAIL_TRANSPORT=smtp', () => {
  it('SMTP 발송 수단을 만든다', () => {
    const { createFor } = fakeFactory();

    expect(createMailSender(config(SMTP), createFor)).toBeInstanceOf(SmtpMailSender);
  });

  it('접속 정보로 전송 수단을 만들고, 보내는 사람 주소로 메일을 보낸다', async () => {
    const { sendMail, createFor } = fakeFactory();

    await createMailSender(config(SMTP), createFor).sendVerificationCode('a@b.com', '123456');

    expect(createFor).toHaveBeenCalledExactlyOnceWith({
      host: 'smtp.example.com',
      port: 587,
      user: 'noreply@example.com',
      pass: 'app-password',
    });
    expect(sendMail.mock.calls[0]![0]).toMatchObject({
      from: 'noreply@example.com',
      to: 'a@b.com',
    });
  });

  it('값 앞뒤 공백 · 줄바꿈을 지운 뒤 쓴다', async () => {
    const { sendMail, createFor } = fakeFactory();

    await createMailSender(
      config({
        MAIL_TRANSPORT: ' smtp\n',
        SMTP_HOST: ' smtp.example.com\n',
        SMTP_PORT: ' 465 ',
        SMTP_USER: '  user@example.com ',
        SMTP_PASS: ' pw\n',
        MAIL_FROM: '  noreply@example.com \n',
      }),
      createFor,
    ).sendAlreadyRegistered('a@b.com');

    expect(createFor).toHaveBeenCalledExactlyOnceWith({
      host: 'smtp.example.com',
      port: 465,
      user: 'user@example.com',
      pass: 'pw',
    });
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ from: 'noreply@example.com' });
  });

  it.each(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'])(
    '%s가 없으면 서버를 띄우기 전에 실패한다',
    (key) => {
      const { createFor } = fakeFactory();

      expect(() => createMailSender(config({ ...SMTP, [key]: undefined }), createFor)).toThrow(
        new RegExp(`${key}.*필요`),
      );
      expect(createFor).not.toHaveBeenCalled();
    },
  );

  it.each(['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM'])(
    '%s가 빈 문자열이나 공백뿐이어도 실패한다',
    (key) => {
      const { createFor } = fakeFactory();

      for (const blank of ['', '   ', '\n']) {
        expect(() => createMailSender(config({ ...SMTP, [key]: blank }), createFor)).toThrow(
          new RegExp(`${key}.*필요`),
        );
      }
    },
  );

  it.each([
    ['경로가 붙음', 'smtp.example.com/path'],
    ['주소에 포트가 붙음', 'smtp.example.com:587'],
    ['공백이 섞임', 'smtp example.com'],
    ['주소 앞에 프로토콜', 'smtp://smtp.example.com'],
    ['점으로 시작', '.example.com'],
    ['하이픈으로 끝남', 'example.com-'],
    ['@가 섞임', 'user@example.com'],
    ['줄바꿈', 'a.example.com\nb.example.com'],
  ])('SMTP_HOST가 올바르지 않으면(%s) 실패한다', (_n, host) => {
    const { createFor } = fakeFactory();

    expect(() => createMailSender(config({ ...SMTP, SMTP_HOST: host }), createFor)).toThrow(
      /SMTP_HOST/,
    );
    expect(createFor).not.toHaveBeenCalled();
  });

  it.each(['smtp.gmail.com', 'smtp.naver.com', 'localhost', 'mail-1.example.co.kr', '127.0.0.1'])(
    'SMTP_HOST %s는 통과한다',
    (host) => {
      const { createFor } = fakeFactory();

      expect(() => createMailSender(config({ ...SMTP, SMTP_HOST: host }), createFor)).not.toThrow();
    },
  );

  it.each([
    ['숫자가 아님', 'abc'],
    ['0', '0'],
    ['65536', '65536'],
    ['소수', '58.7'],
    ['음수', '-1'],
    ['지수 표기', '1e3'],
    ['16진수', '0x24b'],
    ['여섯 자리', '587000'],
  ])('SMTP_PORT가 올바르지 않으면(%s) 실패한다', (_n, port) => {
    const { createFor } = fakeFactory();

    expect(() => createMailSender(config({ ...SMTP, SMTP_PORT: port }), createFor)).toThrow(
      /SMTP_PORT/,
    );
    expect(createFor).not.toHaveBeenCalled();
  });

  it.each([
    ['1', 1],
    ['25', 25],
    ['465', 465],
    ['587', 587],
    ['2525', 2525],
    ['65535', 65535],
  ])('SMTP_PORT %s는 통과한다', (port, expected) => {
    const { createFor } = fakeFactory();

    createMailSender(config({ ...SMTP, SMTP_PORT: port }), createFor);

    expect(createFor.mock.calls[0]![0]).toMatchObject({ port: expected });
  });

  it.each([
    ['@가 없음', 'noreply.example.com'],
    ['도메인에 점이 없음', 'noreply@localhost'],
    ['이름이 붙음', 'NoteLink <noreply@example.com>'],
    ['주소가 둘', 'a@example.com,b@example.com'],
    ['공백이 들어감', 'no reply@example.com'],
    ['줄바꿈으로 헤더를 끼워 넣음', 'a@example.com\nBcc: evil@example.com'],
    ['따옴표', '"a"@example.com'],
  ])('MAIL_FROM이 올바르지 않으면(%s) 실패한다', (_n, from) => {
    const { createFor } = fakeFactory();

    expect(() => createMailSender(config({ ...SMTP, MAIL_FROM: from }), createFor)).toThrow(
      /MAIL_FROM/,
    );
    expect(createFor).not.toHaveBeenCalled();
  });

  it('설정 오류 문구에 설정값(비밀번호 · 사용자 · 주소)을 넣지 않는다', () => {
    const { createFor } = fakeFactory();
    const attempts: Record<string, string>[] = [
      { SMTP_HOST: 'SECRET-HOST/x' },
      { SMTP_PORT: 'SECRET-PORT' },
      { MAIL_FROM: 'SECRET-FROM' },
      { SMTP_PASS: '' },
    ];

    for (const override of attempts) {
      let message = '';
      try {
        createMailSender(
          config({ ...SMTP, SMTP_USER: 'SECRET-USER', SMTP_PASS: 'SECRET-PASS', ...override }),
          createFor,
        );
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('SECRET');
    }
  });

  it('smtp로 설정하면 로그 발송이 아니다 (인증번호가 로그에 남지 않는다)', async () => {
    const { createFor } = fakeFactory();

    const sender = createMailSender(config(SMTP), createFor);
    await sender.sendVerificationCode('a@b.com', '123456');

    expect(sender).not.toBeInstanceOf(LogMailSender);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it.each(['SMTP', 'Smtp', 'smtps', 'smtp2', 'mail'])(
    '%s처럼 정확히 smtp가 아닌 값은 smtp로 보지 않는다',
    (value) => {
      const { createFor } = fakeFactory();

      const sender = createMailSender(config({ ...SMTP, MAIL_TRANSPORT: value }), createFor);

      expect(sender).toBeInstanceOf(LogMailSender);
      expect(createFor).not.toHaveBeenCalled();
    },
  );
});

describe('createMailSender 다른 값', () => {
  it('SMTP 설정이 있어도 MAIL_TRANSPORT가 log면 로그 발송이다', () => {
    const { createFor } = fakeFactory();

    expect(createMailSender(config({ ...SMTP, MAIL_TRANSPORT: 'log' }), createFor)).toBeInstanceOf(
      LogMailSender,
    );
    expect(createFor).not.toHaveBeenCalled();
  });

  it('MAIL_TRANSPORT가 없으면 SMTP 설정이 있어도 쓰지 않는다 (명시했을 때만)', () => {
    const { createFor } = fakeFactory();

    expect(
      createMailSender(config({ ...SMTP, MAIL_TRANSPORT: undefined }), createFor),
    ).toBeInstanceOf(LogMailSender);
    expect(createFor).not.toHaveBeenCalled();
  });
});

describe('createSmtpTransport (실제 nodemailer 설정)', () => {
  /** nodemailer가 받은 설정을 확인하려고 만든 전송 수단의 옵션을 읽는다 */
  const optionsOf = (port: number) => {
    const transport = createSmtpTransport({ host: 'smtp.example.com', port, user: 'u', pass: 'p' });
    return (transport as unknown as { options: Record<string, unknown> }).options;
  };

  it('465는 연결하자마자 암호화(SMTPS)한다', () => {
    const options = optionsOf(465);

    expect(options).toMatchObject({ secure: true, host: 'smtp.example.com', port: 465 });
  });

  it.each([587, 25, 2525])(
    '%i는 STARTTLS를 반드시 올린다 (올리지 못하면 연결을 포기한다)',
    (port) => {
      const options = optionsOf(port);

      expect(options).toMatchObject({ secure: false, requireTLS: true });
    },
  );

  it('TLS 1.2 미만은 쓰지 않는다', () => {
    expect(optionsOf(587)).toMatchObject({ tls: { minVersion: 'TLSv1.2' } });
  });

  it('인증 정보를 전달한다', () => {
    expect(optionsOf(587)).toMatchObject({ auth: { user: 'u', pass: 'p' } });
  });

  it('파일 읽기와 외부 주소 호출 기능을 끈다', () => {
    expect(optionsOf(587)).toMatchObject({ disableFileAccess: true, disableUrlAccess: true });
  });

  it('연결과 응답 대기 시간을 기본값(2분 · 30초)보다 짧게 둔다', () => {
    const options = optionsOf(587);

    expect(options['connectionTimeout']).toBeLessThanOrEqual(15_000);
    expect(options['greetingTimeout']).toBeLessThanOrEqual(15_000);
    expect(options['socketTimeout']).toBeLessThanOrEqual(30_000);
  });

  it('nodemailer 옵션 이름을 라이브러리가 실제로 인식한다 (이름 오타 방지)', () => {
    // 잘못된 이름은 조용히 무시되므로, 읽은 옵션이 비어 있지 않은지로 확인한다
    const options = optionsOf(587);

    for (const key of ['requireTLS', 'connectionTimeout', 'greetingTimeout', 'socketTimeout']) {
      expect(options[key]).toBeDefined();
    }
  });
});
