import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EMAIL_CODE_TTL_MS } from '../src/modules/auth/app-login/email-code.service.js';
import { MailUnavailableError } from '../src/modules/mail/mail-sender.js';
import {
  MAIL_SEND_FAILED_MESSAGE,
  SMTP_SEND_TIMEOUT_MS,
  SmtpMailSender,
  type SmtpOutgoingMail,
  type SmtpTransport,
} from '../src/modules/mail/smtp-mail-sender.js';

const FROM = 'noreply@example.com';
const SECRET = 'SUPER-SECRET-SMTP-PASSWORD';

type Sent = SmtpOutgoingMail;

/** 발송마다 새 전송 수단을 돌려주는 팩토리. 만들어진 전송 수단과 끊김 기록을 확인할 수 있다 */
function factoryOf(sendMail: SmtpTransport['sendMail']) {
  const abort = vi.fn();
  const open = vi.fn((): SmtpTransport => ({ sendMail, abort }));
  return { open, abort };
}

function okTransport() {
  const sendMail = vi.fn((_message: Sent) => Promise.resolve({ accepted: ['x'] }));
  const { open, abort } = factoryOf(sendMail);
  return { transport: open, sendMail, open, abort };
}

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const loggedText = () => errorLog.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

describe('SmtpMailSender 인증번호 메일', () => {
  it('보내는 사람 · 받는 사람 · 인증번호를 담아 한 번 보낸다', async () => {
    const { transport, sendMail } = okTransport();

    await new SmtpMailSender(transport, FROM).sendVerificationCode('user@example.com', '012345');

    expect(sendMail).toHaveBeenCalledOnce();
    const message = sendMail.mock.calls[0]![0];
    expect(message.from).toBe(FROM);
    expect(message.to).toEqual({ address: 'user@example.com' });
    expect(message.text).toContain('012345');
  });

  it('앞자리가 0인 인증번호도 그대로 본문에 넣는다', async () => {
    const { transport, sendMail } = okTransport();

    await new SmtpMailSender(transport, FROM).sendVerificationCode('a@example.com', '000042');

    expect(sendMail.mock.calls[0]![0].text).toContain('000042');
  });

  it('인증번호는 제목에 넣지 않는다 (잠금 화면 알림에 그대로 보이지 않게)', async () => {
    const { transport, sendMail } = okTransport();

    await new SmtpMailSender(transport, FROM).sendVerificationCode('a@example.com', '123456');

    expect(sendMail.mock.calls[0]![0].subject).not.toContain('123456');
  });

  it('유효 시간을 서버가 실제로 쓰는 값(EMAIL_CODE_TTL_MS)에서 계산해 안내한다', async () => {
    const { transport, sendMail } = okTransport();

    await new SmtpMailSender(transport, FROM).sendVerificationCode('a@example.com', '123456');

    expect(sendMail.mock.calls[0]![0].text).toContain(`${EMAIL_CODE_TTL_MS / 60_000}분`);
  });

  it('한 통에 받는 사람 한 명에게만 보낸다 (to에 주소가 하나)', async () => {
    const { transport, sendMail } = okTransport();

    await new SmtpMailSender(transport, FROM).sendVerificationCode('a@example.com', '123456');

    expect(sendMail.mock.calls[0]![0]).toEqual({
      from: FROM,
      to: { address: 'a@example.com' },
      subject: expect.any(String),
      text: expect.any(String),
    });
  });

  it('성공하면 아무 값도 돌려주지 않는다 (전송 결과 객체를 밖으로 내보내지 않는다)', async () => {
    const { transport } = okTransport();

    await expect(
      new SmtpMailSender(transport, FROM).sendVerificationCode('a@example.com', '123456'),
    ).resolves.toBeUndefined();
  });

  it('성공해도 로그를 남기지 않는다 (받는 사람과 인증번호가 로그에 남지 않는다)', async () => {
    const { transport } = okTransport();
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await new SmtpMailSender(transport, FROM).sendVerificationCode('a@example.com', '123456');

    expect(errorLog).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('SmtpMailSender 이미 가입한 이메일 안내', () => {
  it('인증번호 없이 받는 사람에게 안내만 보낸다', async () => {
    const { transport, sendMail } = okTransport();

    await new SmtpMailSender(transport, FROM).sendAlreadyRegistered('user@example.com');

    const message = sendMail.mock.calls[0]![0];
    expect(message).toMatchObject({ from: FROM, to: { address: 'user@example.com' } });
    expect(message.text).not.toMatch(/\d{6}/);
  });

  it('인증번호 메일과 제목 · 본문이 다르다 (받는 사람이 구분할 수 있다)', async () => {
    const { transport, sendMail } = okTransport();
    const sender = new SmtpMailSender(transport, FROM);

    await sender.sendVerificationCode('a@example.com', '123456');
    await sender.sendAlreadyRegistered('a@example.com');

    const [a, b] = sendMail.mock.calls.map((c) => c[0]);
    expect(a!.subject).not.toBe(b!.subject);
    expect(a!.text).not.toBe(b!.text);
  });
});

describe('SmtpMailSender 실패 처리', () => {
  const failures: Array<[string, () => Promise<never> | never]> = [
    [
      '서버가 인증을 거부할 때',
      () =>
        Promise.reject(
          Object.assign(
            new Error(`Invalid login: 535 user=${SECRET} to=user@example.com code=123456`),
            { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' },
          ),
        ),
    ],
    [
      '호출이 동기 예외를 던질 때',
      () => {
        throw new Error(`boom ${SECRET}`);
      },
    ],
    ['문자열을 던질 때', () => Promise.reject(`raw ${SECRET}`)],
    ['null을 던질 때', () => Promise.reject(null)],
  ];

  it.each(failures)('%s MailUnavailableError로 바꿔 던진다', async (_name, fail) => {
    const sender = new SmtpMailSender(factoryOf(fail as never).open, FROM);

    await expect(sender.sendVerificationCode('user@example.com', '123456')).rejects.toBeInstanceOf(
      MailUnavailableError,
    );
    await expect(sender.sendAlreadyRegistered('user@example.com')).rejects.toBeInstanceOf(
      MailUnavailableError,
    );
  });

  it.each(failures)(
    '%s 오류 문구는 고정 문구뿐이다 (원인을 이어 붙이지 않는다)',
    async (_name, fail) => {
      const sender = new SmtpMailSender(factoryOf(fail as never).open, FROM);

      const error = (await sender
        .sendVerificationCode('user@example.com', '123456')
        .catch((e: unknown) => e)) as Error;

      expect(error.message).toBe(MAIL_SEND_FAILED_MESSAGE);
      expect(error.cause).toBeUndefined();
    },
  );

  it.each(failures)(
    '%s 로그에 비밀번호 · 받는 사람 · 인증번호를 남기지 않는다',
    async (_name, fail) => {
      const sender = new SmtpMailSender(factoryOf(fail as never).open, FROM);

      await sender.sendVerificationCode('user@example.com', '123456').catch(() => {});

      expect(errorLog).toHaveBeenCalledOnce();
      expect(loggedText()).not.toContain(SECRET);
      expect(loggedText()).not.toContain('user@example.com');
      expect(loggedText()).not.toContain('123456');
    },
  );

  it('로그에는 오류 종류와 SMTP 응답 코드만 남긴다 (운영자가 원인을 좁힐 수 있다)', async () => {
    const error = Object.assign(new Error('x'), {
      code: 'EAUTH',
      responseCode: 535,
      command: 'AUTH PLAIN',
    });
    const sender = new SmtpMailSender(factoryOf(() => Promise.reject(error)).open, FROM);

    await sender.sendVerificationCode('a@example.com', '123456').catch(() => {});

    expect(loggedText()).toContain('EAUTH');
    expect(loggedText()).toContain('535');
  });

  it('줄바꿈이 섞인 오류 코드는 로그에 옮기지 않는다 (로그 줄이 갈라지지 않는다)', async () => {
    const error = Object.assign(new Error('x'), {
      code: 'Evil\n[FAKE] injected line',
      command: 'RCPT',
    });
    const sender = new SmtpMailSender(factoryOf(() => Promise.reject(error)).open, FROM);

    await sender.sendVerificationCode('a@example.com', '123456').catch(() => {});

    expect(loggedText()).not.toContain('\n');
    expect(loggedText()).not.toContain('FAKE');
    expect(loggedText()).toContain('RCPT');
  });

  it('알 수 없는 오류는 unknown으로 남긴다', async () => {
    const sender = new SmtpMailSender(factoryOf(() => Promise.reject(null)).open, FROM);

    await sender.sendVerificationCode('a@example.com', '123456').catch(() => {});

    expect(loggedText()).toContain('unknown');
  });
});

describe('SmtpMailSender 연결 종료와 전송 수단', () => {
  it('발송마다 새 전송 수단을 만든다 (한 발송의 연결 종료가 다른 발송에 번지지 않는다)', async () => {
    const { open } = okTransport();
    const sender = new SmtpMailSender(open, FROM);

    await sender.sendVerificationCode('a@example.com', '111111');
    await sender.sendVerificationCode('b@example.com', '222222');
    await sender.sendAlreadyRegistered('c@example.com');

    expect(open).toHaveBeenCalledTimes(3);
  });

  it('성공한 발송은 연결을 끊지 않는다', async () => {
    const { open, abort } = okTransport();

    await new SmtpMailSender(open, FROM).sendVerificationCode('a@example.com', '111111');

    expect(abort).not.toHaveBeenCalled();
  });

  it('실패한 발송은 그 발송의 연결을 끊는다', async () => {
    const { open, abort } = factoryOf(() => Promise.reject(new Error('x')));

    await new SmtpMailSender(open, FROM)
      .sendVerificationCode('a@example.com', '111111')
      .catch(() => {});

    expect(abort).toHaveBeenCalledOnce();
  });

  it('시간 초과로 포기한 발송은 그 발송의 연결을 끊는다', async () => {
    const { open, abort } = factoryOf(() => new Promise(() => undefined));

    await new SmtpMailSender(open, FROM, 20)
      .sendVerificationCode('a@example.com', '111111')
      .catch(() => {});

    expect(abort).toHaveBeenCalledOnce();
  });

  it('연결을 끊다가 오류가 나도 원래 실패(MailUnavailableError)를 그대로 돌려준다', async () => {
    const transport: SmtpTransport = {
      sendMail: () => Promise.reject(new Error('원래 실패')),
      abort: () => {
        throw new Error('abort 중 오류');
      },
    };

    const error = await new SmtpMailSender(() => transport, FROM)
      .sendVerificationCode('a@example.com', '111111')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailUnavailableError);
    expect((error as Error).message).toBe(MAIL_SEND_FAILED_MESSAGE);
  });

  it('수신자가 올바르지 않으면 전송 수단을 만들지도 연결을 끊지도 않는다', async () => {
    const { open, abort } = okTransport();

    await new SmtpMailSender(open, FROM)
      .sendVerificationCode('x1,victim@example.com', '111111')
      .catch(() => {});

    expect(open).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
  });

  it('받는 사람 길이는 254자까지 허용하고 255자부터 거부한다 (경계)', async () => {
    const at = (n: number) => `${'a'.repeat(n - '@example.com'.length)}@example.com`;
    const { open, sendMail } = okTransport();
    const sender = new SmtpMailSender(open, FROM);

    await sender.sendVerificationCode(at(254), '111111');
    expect(sendMail).toHaveBeenCalledOnce();

    await expect(sender.sendVerificationCode(at(255), '111111')).rejects.toBeInstanceOf(
      MailUnavailableError,
    );
    expect(sendMail).toHaveBeenCalledOnce();
  });
});

describe('SmtpMailSender 시간 제한', () => {
  it('기본 제한 시간은 15초다', () => {
    expect(SMTP_SEND_TIMEOUT_MS).toBe(15_000);
  });

  it('서버가 응답하지 않으면 제한 시간 뒤에 포기하고 MailUnavailableError를 던진다', async () => {
    const hanging = factoryOf(() => new Promise(() => undefined)).open;
    const started = Date.now();

    await expect(
      new SmtpMailSender(hanging, FROM, 30).sendVerificationCode('a@example.com', '123456'),
    ).rejects.toBeInstanceOf(MailUnavailableError);

    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('시간 초과는 로그에 ETIMEDOUT으로 남는다', async () => {
    const hanging = factoryOf(() => new Promise(() => undefined)).open;

    await new SmtpMailSender(hanging, FROM, 20)
      .sendVerificationCode('a@example.com', '123456')
      .catch(() => {});

    expect(loggedText()).toContain('ETIMEDOUT');
  });

  it('제한 시간 안에 끝나면 시간 초과 타이머가 남지 않는다 (프로세스가 대기하지 않는다)', async () => {
    vi.useFakeTimers();
    const { transport } = okTransport();

    await new SmtpMailSender(transport, FROM, 5_000).sendVerificationCode(
      'a@example.com',
      '123456',
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it('실패해도 타이머가 남지 않는다', async () => {
    vi.useFakeTimers();
    const failing = factoryOf(() => Promise.reject(new Error('x'))).open;

    await new SmtpMailSender(failing, FROM, 5_000)
      .sendVerificationCode('a@example.com', '123456')
      .catch(() => {});

    expect(vi.getTimerCount()).toBe(0);
  });

  it('포기한 뒤에 늦게 실패해도 처리되지 않은 거부가 생기지 않는다', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    let rejectLate!: (e: Error) => void;
    const slow = factoryOf(
      () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
    ).open;

    await new SmtpMailSender(slow, FROM, 10)
      .sendVerificationCode('a@example.com', '123456')
      .catch(() => {});
    rejectLate(new Error('늦은 실패'));
    await new Promise((r) => setTimeout(r, 30));
    process.off('unhandledRejection', onUnhandled);

    expect(unhandled).toEqual([]);
  });
});
