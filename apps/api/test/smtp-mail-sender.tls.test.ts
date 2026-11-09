import { Logger } from '@nestjs/common';
import { SMTPServer, type SMTPServerOptions } from 'smtp-server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { baseOptions, createTrackedTransport } from '../src/modules/mail/create-mail-sender.js';
import { MailUnavailableError } from '../src/modules/mail/mail-sender.js';
import { SmtpMailSender, type SmtpTransportFactory } from '../src/modules/mail/smtp-mail-sender.js';
import { startFakeSmtpServer } from './support/fake-smtp-server.js';

/**
 * 암호화된 연결(SMTPS · STARTTLS)에서도 시간 초과 때 그 발송의 연결이 닫히는지 확인하는 회귀 테스트.
 *
 * `smtp-wire` 테스트는 암호화를 끈 평문 서버에 붙는다. 하지만 운영은 항상 TLS 위에서 보내고, 소켓을 직접 열어 넘긴 뒤
 * 라이브러리가 그 소켓 위에 TLS를 올린다(465는 연결 직후, 그 밖은 STARTTLS). 소켓을 끊어도 TLS 구간까지 연결이 끝나는지는
 * 평문 테스트로는 알 수 없다.
 *
 * 전송 수단은 서비스가 실제로 쓰는 옵션(`baseOptions`)을 그대로 쓰고, 시험용 서버의 자체 서명 인증서를 받아들이도록
 * `rejectUnauthorized: false`만 더한다. SMTPS는 포트를 465로 고정할 수 없어 `secure`만 명시적으로 켠다.
 */

const FROM = 'noreply@example.com';
const WAIT = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(condition: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await WAIT(10);
  }
  return condition();
}

/** `smtp-server`(실제 SMTP · STARTTLS 구현, 내장 시험용 인증서)를 띄우고 연결 상태를 센다 */
async function startTlsServer(options: SMTPServerOptions) {
  let open = 0;
  let total = 0;
  const delivered: { to: string[]; secure: boolean }[] = [];
  const hungSecure: boolean[] = [];

  const server = new SMTPServer({
    authOptional: true,
    logger: false,
    ...options,
    onConnect(_session, callback) {
      open += 1;
      total += 1;
      callback();
    },
    onClose() {
      open -= 1;
    },
    onAuth(auth, _session, callback) {
      callback(null, { user: auth.username });
    },
    onData(stream, session, callback) {
      const to = session.envelope.rcptTo.map((r) => r.address);
      stream.resume();
      stream.on('end', () => {
        // 받는 사람 이름에 stuck이 있으면 끝을 알리지 않는다(본문까지 받아 놓고 멈춘다)
        if (to.some((a) => a.startsWith('stuck'))) {
          hungSecure.push(session.secure);
          return;
        }
        delivered.push({ to, secure: session.secure });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as { port: number }).port;

  return {
    port,
    delivered,
    hungSecure,
    openConnections: () => open,
    totalConnections: () => total,
    async close() {
      server.close();
    },
  };
}

type TlsServer = Awaited<ReturnType<typeof startTlsServer>>;

/** 서비스 설정 그대로(STARTTLS) — 자체 서명 인증서를 받아들이는 옵션만 더한다 */
const starttlsFactory =
  (server: { port: number }): SmtpTransportFactory =>
  () =>
    createTrackedTransport(
      {
        ...baseOptions({ host: '127.0.0.1', port: server.port, user: 'u', pass: 'p' }),
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: false },
      },
      { host: '127.0.0.1', port: server.port },
    );

/** 서비스 설정 그대로이되 연결 직후 암호화(SMTPS)를 켠다 — 465 포트를 쓸 수 없는 테스트 환경을 위해 secure만 덮어쓴다 */
const smtpsFactory =
  (server: { port: number }): SmtpTransportFactory =>
  () =>
    createTrackedTransport(
      {
        ...baseOptions({ host: '127.0.0.1', port: server.port, user: 'u', pass: 'p' }),
        secure: true,
        requireTLS: false,
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: false },
      },
      { host: '127.0.0.1', port: server.port },
    );

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ['SMTPS (연결 직후 암호화)', { secure: true } as SMTPServerOptions, smtpsFactory],
  ['STARTTLS (연결 뒤 암호화로 올림)', { secure: false } as SMTPServerOptions, starttlsFactory],
])('%s', (_label, serverOptions, makeFactory) => {
  let server: TlsServer;
  beforeEach(async () => {
    server = await startTlsServer(serverOptions);
  });
  afterEach(async () => {
    await server.close();
  });

  it('암호화된 연결 위에서 정상 발송된다 (소켓을 직접 열어 넘겨도 TLS가 올라간다)', async () => {
    await new SmtpMailSender(makeFactory(server), FROM).sendVerificationCode(
      'user@example.com',
      '123456',
    );

    expect(server.delivered).toEqual([{ to: ['user@example.com'], secure: true }]);
  });

  it('암호화된 연결에서 서버가 끝을 알리지 않으면 시간 초과로 실패하고, 그 발송의 연결이 닫힌다', async () => {
    const started = Date.now();

    await expect(
      new SmtpMailSender(makeFactory(server), FROM, 500).sendVerificationCode(
        'stuck@example.com',
        '123456',
      ),
    ).rejects.toBeInstanceOf(MailUnavailableError);

    expect(Date.now() - started).toBeLessThan(3000);
    // 서버가 본 연결은 TLS였다 = 암호화가 올라간 뒤에 멈췄고, 그 상태에서도 연결이 끊겼다
    expect(server.hungSecure).toEqual([true]);
    expect(await until(() => server.openConnections() === 0)).toBe(true);
  });

  it('포기한 뒤에는 나중에도 메일이 마저 나가지 않고 연결도 다시 열리지 않는다', async () => {
    await new SmtpMailSender(makeFactory(server), FROM, 400)
      .sendVerificationCode('stuck@example.com', '123456')
      .catch(() => undefined);
    const connections = server.totalConnections();

    await WAIT(600);

    expect(server.delivered).toEqual([]);
    expect(server.totalConnections()).toBe(connections);
    expect(server.openConnections()).toBe(0);
  });

  it('한 발송이 시간 초과로 끊겨도 같은 시각의 다른 발송은 성공한다 (암호화된 연결끼리 독립)', async () => {
    const sender = new SmtpMailSender(makeFactory(server), FROM, 1500);

    const results = await Promise.all([
      sender.sendVerificationCode('stuck@example.com', '111111').catch((e: unknown) => e),
      sender.sendVerificationCode('ok1@example.com', '222222').then(() => 'sent'),
      sender.sendVerificationCode('ok2@example.com', '333333').then(() => 'sent'),
      sender.sendAlreadyRegistered('ok3@example.com').then(() => 'sent'),
    ]);

    expect(results[0]).toBeInstanceOf(MailUnavailableError);
    expect(results.slice(1)).toEqual(['sent', 'sent', 'sent']);
    expect(server.delivered.flatMap((m) => m.to).sort()).toEqual([
      'ok1@example.com',
      'ok2@example.com',
      'ok3@example.com',
    ]);
    expect(server.delivered.every((m) => m.secure)).toBe(true);
    expect(await until(() => server.openConnections() === 0)).toBe(true);
  });

  it('정상 발송은 연결을 끊어 망치지 않고 깔끔하게 닫힌다', async () => {
    await new SmtpMailSender(makeFactory(server), FROM, 5000).sendVerificationCode(
      'user@example.com',
      '123456',
    );

    expect(server.delivered).toHaveLength(1);
    expect(await until(() => server.openConnections() === 0)).toBe(true);
  });

  it('수신자 검사는 암호화 연결에서도 같다 (거부된 입력은 연결을 열지 않는다)', async () => {
    const before = server.totalConnections();

    await expect(
      new SmtpMailSender(makeFactory(server), FROM).sendVerificationCode(
        'x1,victim@example.com',
        '123456',
      ),
    ).rejects.toBeInstanceOf(MailUnavailableError);

    expect(server.totalConnections()).toBe(before);
    expect(server.delivered).toEqual([]);
  });
});

describe('STARTTLS: 평문으로 내려가지 않는다', () => {
  it('STARTTLS를 지원하지 않는 서버에는 보내지 않고 실패한다 (아이디 · 비밀번호 · 본문이 평문으로 나가지 않는다)', async () => {
    const server = await startTlsServer({ secure: false, disabledCommands: ['STARTTLS'] });

    await expect(
      new SmtpMailSender(starttlsFactory(server), FROM, 3000).sendVerificationCode(
        'user@example.com',
        '123456',
      ),
    ).rejects.toBeInstanceOf(MailUnavailableError);

    expect(server.delivered).toEqual([]);
    expect(await until(() => server.openConnections() === 0)).toBe(true);
    await server.close();
  });
});

describe('암호화로 올라가는 도중 멈추는 서버', () => {
  it('SMTPS: TLS 핸드셰이크에 응하지 않아도 시간 초과 뒤 연결이 닫힌다', async () => {
    // 아무 말도 하지 않는 서버에 암호화 연결을 시도하면 클라이언트는 핸드셰이크 응답을 기다리며 멈춘다
    const silent = await startFakeSmtpServer('silent');
    const started = Date.now();

    await expect(
      new SmtpMailSender(smtpsFactory(silent), FROM, 400).sendVerificationCode(
        'user@example.com',
        '123456',
      ),
    ).rejects.toBeInstanceOf(MailUnavailableError);

    expect(Date.now() - started).toBeLessThan(3000);
    expect(await until(() => silent.openConnections() === 0)).toBe(true);
    await silent.close();
  });

  it('STARTTLS: 암호화로 올라가는 협상 도중에 멈춰도 시간 초과 뒤 연결이 닫힌다', async () => {
    const stalling = await startFakeSmtpServer('hang-at-starttls');
    const started = Date.now();

    await expect(
      new SmtpMailSender(starttlsFactory(stalling), FROM, 400).sendVerificationCode(
        'user@example.com',
        '123456',
      ),
    ).rejects.toBeInstanceOf(MailUnavailableError);

    expect(Date.now() - started).toBeLessThan(3000);
    expect(stalling.mails).toHaveLength(0);
    expect(await until(() => stalling.openConnections() === 0)).toBe(true);
    await stalling.close();
  });
});
