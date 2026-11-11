import { Logger } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTrackedTransport } from '../src/modules/mail/create-mail-sender.js';
import { MailUnavailableError } from '../src/modules/mail/mail-sender.js';
import { SmtpMailSender, type SmtpTransportFactory } from '../src/modules/mail/smtp-mail-sender.js';
import { startFakeSmtpServer } from './support/fake-smtp-server.js';

/**
 * 실제 SMTP 프로토콜을 말하는 가짜 서버에 붙어 확인하는 회귀 테스트.
 * 서비스 설정은 STARTTLS를 요구해 평문 서버에 붙을 수 없으므로, 암호화 옵션만 끈 설정으로 같은 전송 코드
 * (소켓 추적 · abort)를 쓴다. 확인하는 것은 서버가 **실제로 받은** 봉투와 연결 상태다.
 */

const FROM = 'noreply@example.com';
const WAIT = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 받은 메일의 본문을 읽는다. 한글이 있으면 base64로 오므로 풀어서 비교한다 */
function bodyOf(data: string): string {
  const body = data.split('\r\n\r\n').slice(1).join('\r\n\r\n');
  return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
}

/** 서버가 받은 연결이 끊길 때까지(또는 시간이 다할 때까지) 기다린다 */
async function until(condition: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (condition()) return true;
    await WAIT(10);
  }
  return condition();
}

let server: Awaited<ReturnType<typeof startFakeSmtpServer>>;

/** 평문 가짜 서버에 붙는, 발송마다 새로 만드는 전송 수단 */
const plainFactory = (): SmtpTransportFactory => () =>
  createTrackedTransport(
    {
      host: '127.0.0.1',
      port: server.port,
      secure: false,
      ignoreTLS: true,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 8000,
      disableFileAccess: true,
      disableUrlAccess: true,
    },
    { host: '127.0.0.1', port: server.port },
  );

beforeAll(async () => {
  server = await startFakeSmtpServer('accept');
});
afterAll(async () => {
  await server.close();
});
beforeEach(() => {
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  server.mails.length = 0;
  server.setMode('accept');
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('받는 사람 (실제 SMTP 봉투)', () => {
  it('정상 주소는 수신자 한 명(RCPT TO 한 번)으로 나간다', async () => {
    await new SmtpMailSender(plainFactory(), FROM).sendVerificationCode(
      'user@example.com',
      '123456',
    );

    expect(server.mails).toHaveLength(1);
    expect(server.mails[0]!.rcptTo).toEqual(['user@example.com']);
    expect(server.mails[0]!.mailFrom).toBe(FROM);
  });

  it('이미 가입한 이메일 안내도 수신자 한 명으로 나간다', async () => {
    await new SmtpMailSender(plainFactory(), FROM).sendAlreadyRegistered('user@example.com');

    expect(server.mails[0]!.rcptTo).toEqual(['user@example.com']);
  });

  it.each([
    ['쉼표로 다른 사람을 끼워 넣음', 'x1,victim@example.com'],
    ['쉼표로 두 주소', 'a@example.com,b@example.com'],
    ['세미콜론으로 두 주소', 'a@example.com;b@example.com'],
    ['공백으로 두 주소', 'a@example.com b@example.com'],
    ['줄바꿈으로 헤더 끼워 넣기', 'a@example.com\r\nBcc: evil@example.com'],
    ['이름이 붙은 형식', 'Name <a@example.com>'],
    ['꺾쇠 주소', '<a@example.com>'],
    ['따옴표 로컬 파트', '"x,y"@example.com'],
    ['빈 문자열', ''],
    ['@ 없음', 'plain'],
    ['매우 긴 주소', `${'a'.repeat(250)}@example.com`],
  ])('수신자로 쓸 수 없는 입력(%s)은 거부하고 서버에 아무것도 보내지 않는다', async (_name, to) => {
    const connectionsBefore = server.totalConnections();

    await expect(
      new SmtpMailSender(plainFactory(), FROM).sendVerificationCode(to, '123456'),
    ).rejects.toBeInstanceOf(MailUnavailableError);

    expect(server.mails).toHaveLength(0);
    // 연결조차 열지 않는다(거부는 라이브러리에 넘기기 전에 일어난다)
    expect(server.totalConnections()).toBe(connectionsBefore);
  });

  it('x1,victim@example.com 은 victim에게도 가지 않는다 (옛 방식에서는 victim에게 갔다)', async () => {
    await new SmtpMailSender(plainFactory(), FROM)
      .sendVerificationCode('x1,victim@example.com', '123456')
      .catch(() => undefined);

    const everyone = server.mails.flatMap((m) => m.rcptTo);
    expect(everyone.some((r) => r.includes('victim'))).toBe(false);
    expect(everyone).toEqual([]);
  });

  it('주소 객체로 넘기면 라이브러리가 쉼표를 나누지 않는다 (방어 심층: 검증을 우회해도 수신자는 늘지 않는다)', async () => {
    // 검증을 거치지 않고 전송 수단에 직접 쉼표 주소를 넘겨도 수신자가 늘지 않는지 확인한다
    const transport = plainFactory()();
    await transport.sendMail({
      from: FROM,
      to: { address: 'x1,victim@example.com' },
      subject: 's',
      text: 't',
    });

    expect(server.mails).toHaveLength(1);
    expect(server.mails[0]!.rcptTo).toHaveLength(1);
    expect(server.mails[0]!.rcptTo.some((r) => r === 'victim@example.com')).toBe(false);
  });

  it('보낸 메일의 본문에 To 헤더가 받는 사람 한 명만 담긴다', async () => {
    await new SmtpMailSender(plainFactory(), FROM).sendVerificationCode(
      'user@example.com',
      '123456',
    );

    const headers = server.mails[0]!.data.split('\r\n\r\n')[0]!;
    expect(headers).toMatch(/^To: .*user@example\.com/im);
    expect(headers).not.toMatch(/^(Cc|Bcc):/im);
  });

  it('여러 통을 연달아 보내도 통마다 수신자는 한 명이다 (이전 수신자가 다음 통에 남지 않는다)', async () => {
    const sender = new SmtpMailSender(plainFactory(), FROM);

    await sender.sendVerificationCode('a@example.com', '111111');
    await sender.sendVerificationCode('b@example.com', '222222');

    expect(server.mails.map((m) => m.rcptTo)).toEqual([['a@example.com'], ['b@example.com']]);
  });
});

describe('시간 초과와 연결 종료', () => {
  it('서버가 끝을 알리지 않으면 시간 초과로 실패하고, 그 발송의 연결을 끊는다', async () => {
    server.setMode('hang-after-data');
    const started = Date.now();

    await expect(
      new SmtpMailSender(plainFactory(), FROM, 300).sendVerificationCode(
        'user@example.com',
        '123456',
      ),
    ).rejects.toBeInstanceOf(MailUnavailableError);

    expect(Date.now() - started).toBeLessThan(2000);
    // 서버 쪽에서 본 연결이 실제로 닫힌다(기다림만 포기하고 연결을 방치하지 않는다)
    expect(await until(() => server.openConnections() === 0)).toBe(true);
  });

  it('인사조차 하지 않는 서버에서도 시간 초과 뒤 연결이 닫힌다', async () => {
    server.setMode('silent');

    await expect(
      new SmtpMailSender(plainFactory(), FROM, 300).sendVerificationCode(
        'user@example.com',
        '123456',
      ),
    ).rejects.toBeInstanceOf(MailUnavailableError);

    expect(await until(() => server.openConnections() === 0)).toBe(true);
  });

  it('시간 초과로 포기한 뒤에는 나중에도 서버의 응답으로 메일이 마저 나가지 않는다', async () => {
    server.setMode('hang-after-data');
    await new SmtpMailSender(plainFactory(), FROM, 300)
      .sendVerificationCode('user@example.com', '123456')
      .catch(() => undefined);
    const mailsAtGiveUp = server.mails.length;

    await WAIT(500); // 포기한 뒤에도 한참 지켜본다

    // 서버가 본문을 받은 뒤 끝을 알리지 않았으므로 서버에는 한 통이 쌓여 있지만, 연결이 닫혀 더 늘지 않는다
    expect(server.mails.length).toBe(mailsAtGiveUp);
    expect(server.openConnections()).toBe(0);
  });

  it('포기한 발송은 연결이 끊긴 채로 끝난다 (라이브러리가 뒤늦게 재시도해 연결을 다시 열지 않는다)', async () => {
    server.setMode('silent');
    const before = server.totalConnections();

    await new SmtpMailSender(plainFactory(), FROM, 300)
      .sendVerificationCode('user@example.com', '123456')
      .catch(() => undefined);
    await WAIT(500);

    expect(server.totalConnections() - before).toBe(1);
    expect(server.openConnections()).toBe(0);
  });

  it('정상 발송은 연결을 끊지 않고 서버가 QUIT로 정리하게 둔다 (abort가 성공한 발송을 깨지 않는다)', async () => {
    await new SmtpMailSender(plainFactory(), FROM, 5000).sendVerificationCode(
      'user@example.com',
      '123456',
    );

    expect(server.mails).toHaveLength(1);
    expect(await until(() => server.openConnections() === 0)).toBe(true);
  });
});

describe('동시 발송은 서로 영향을 주지 않는다', () => {
  it('한 발송이 시간 초과로 끊겨도 같은 시각에 진행 중인 다른 발송은 성공한다', async () => {
    const sender = new SmtpMailSender(plainFactory(), FROM, 1500);

    // 첫 연결만 응답하지 않게 하고, 그 직후 연결부터는 정상 응답하게 한다
    server.setMode('silent');
    const stuck = sender
      .sendVerificationCode('stuck@example.com', '111111')
      .catch((e: unknown) => e);
    await WAIT(100);
    server.setMode('accept');
    const fine = [
      sender.sendVerificationCode('ok1@example.com', '222222'),
      sender.sendVerificationCode('ok2@example.com', '333333'),
      sender.sendAlreadyRegistered('ok3@example.com'),
    ];

    const results = await Promise.all([stuck, ...fine.map((p) => p.then(() => 'sent'))]);

    expect(results[0]).toBeInstanceOf(MailUnavailableError);
    expect(results.slice(1)).toEqual(['sent', 'sent', 'sent']);
    const delivered = server.mails.flatMap((m) => m.rcptTo).sort();
    expect(delivered).toEqual(['ok1@example.com', 'ok2@example.com', 'ok3@example.com']);
    expect(await until(() => server.openConnections() === 0)).toBe(true);
  });

  it('서로 다른 발송은 서로 다른 연결을 쓴다 (한 발송의 abort가 다른 발송의 소켓을 끊지 않는다)', async () => {
    const factory = plainFactory();
    const a = factory();
    const b = factory();

    server.setMode('accept');
    const sendingB = b.sendMail({
      from: FROM,
      to: { address: 'b@example.com' },
      subject: 's',
      text: 't',
    });
    a.abort(); // a를 끊는다 (a는 아직 연결을 열지도 않았다)
    await sendingB;

    expect(server.mails.map((m) => m.rcptTo)).toEqual([['b@example.com']]);
  });

  it('끊긴 전송 수단은 이후 새 연결을 열지 않는다', async () => {
    const transport = plainFactory()();
    transport.abort();
    const before = server.totalConnections();

    await expect(
      transport.sendMail({ from: FROM, to: { address: 'a@example.com' }, subject: 's', text: 't' }),
    ).rejects.toBeDefined();

    expect(server.totalConnections()).toBe(before);
    expect(server.mails).toHaveLength(0);
  });

  it('abort는 여러 번 불러도, 연결이 없어도 오류 없이 끝난다', () => {
    const transport = plainFactory()();

    expect(() => {
      transport.abort();
      transport.abort();
    }).not.toThrow();
  });

  it('동시에 여러 통을 보내면 통마다 수신자가 맞게 나간다 (섞이지 않는다)', async () => {
    const sender = new SmtpMailSender(plainFactory(), FROM, 5000);
    const to = Array.from({ length: 8 }, (_, i) => `user${i}@example.com`);

    await Promise.all(
      to.map((address, i) => sender.sendVerificationCode(address, String(100000 + i))),
    );

    expect(server.mails).toHaveLength(8);
    for (const mail of server.mails) expect(mail.rcptTo).toHaveLength(1);
    expect(server.mails.flatMap((m) => m.rcptTo).sort()).toEqual([...to].sort());
    // 각 통의 본문에는 자기 수신자의 인증번호가 들어 있다
    for (const [i, address] of to.entries()) {
      const mail = server.mails.find((m) => m.rcptTo[0] === address)!;
      expect(bodyOf(mail.data)).toContain(String(100000 + i));
    }
  });
});
