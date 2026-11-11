import net from 'node:net';

import { createTransport } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import { type ConfigReader } from '../../config/mongo.config.js';
import { LogMailSender, type MailSender } from './mail-sender.js';
import {
  SmtpMailSender,
  type SmtpOutgoingMail,
  type SmtpTransport,
  type SmtpTransportFactory,
} from './smtp-mail-sender.js';

/** 보내는 사람 주소 모양(공백 · 줄바꿈이 없고 @와 점이 있는 한 줄). 헤더에 줄바꿈이 들어가는 일을 막는다 */
const SENDER_ADDRESS_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
/** SMTP 서버 주소: 영문 · 숫자 · 점 · 하이픈만(주소에 경로나 공백이 섞여 엉뚱한 곳으로 가지 않게) */
const HOST_PATTERN = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
/** 이 포트는 연결하자마자 암호화(SMTPS)한다. 그 밖의 포트는 연결 뒤 STARTTLS로 암호화를 올린다 */
const IMPLICIT_TLS_PORT = 465;

/** SMTP 서버에 연결하는 데 필요한 값 */
export interface SmtpConnection {
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** nodemailer 옵션 중 이 파일이 직접 정하는 것(암호화 · 연결 시간 제한 · 안전 설정). 연결 대상과 소켓은 따로 넘긴다 */
type TransportOptions = SMTPTransport.Options;

/** 서비스가 쓰는 nodemailer 설정. 항상 암호화하고, 연결 · 응답 대기를 짧게 둔다 */
export function baseOptions(connection: SmtpConnection): TransportOptions {
  const secure = connection.port === IMPLICIT_TLS_PORT;
  return {
    host: connection.host,
    port: connection.port,
    secure,
    requireTLS: !secure,
    auth: { user: connection.user, pass: connection.pass },
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    disableFileAccess: true,
    disableUrlAccess: true,
  };
}

/**
 * 주어진 옵션으로 **한 통만 보내는** 전송 수단을 만들고, 그 전송이 여는 연결을 추적한다.
 * `abort()`가 불리면 이 전송의 소켓만 끊는다(다른 전송 수단의 연결은 건드리지 않는다).
 *
 * 라이브러리는 전송 중인 연결을 밖에서 끊을 방법을 주지 않고, 기다림만 포기하면 연결이 살아 있다가
 * 서버가 늦게 응답했을 때 메일이 나중에 나갈 수 있다. 그래서 연결할 소켓을 직접 열어 기록해 둔다.
 * TLS는 라이브러리가 이 소켓 위에서 직접 올리므로(465는 연결 직후, 그 밖은 STARTTLS) 소켓을 끊으면 TLS 세션도 끝난다.
 * 테스트에서 암호화 없는 가짜 서버에 붙을 수 있도록 옵션을 받지만, 운영 경로는 항상 `baseOptions`를 쓴다.
 */
export function createTrackedTransport(
  options: TransportOptions,
  target: { host: string; port: number },
): SmtpTransport {
  const sockets = new Set<net.Socket>();
  let aborted = false;

  const transporter = createTransport({
    ...options,
    getSocket(_options: unknown, callback: (error: Error | null, socketOptions: unknown) => void) {
      // 이미 포기한 발송이면 새 연결을 열지 않는다
      if (aborted) return callback(new Error('aborted'), false);
      const socket = net.connect({ host: target.host, port: target.port });
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.once('connect', () => callback(null, { connection: socket }));
      socket.once('error', (error) => callback(error, false));
    },
  } as TransportOptions);

  return {
    sendMail: (message: SmtpOutgoingMail) => transporter.sendMail(message),
    abort() {
      aborted = true;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

/**
 * 메일 **한 통을 보내기 위한** SMTP 전송 수단을 만든다. 발송마다 새로 만들고, 연결도 이 전송만의 것이다.
 * - 항상 암호화한다: 465는 처음부터, 그 밖의 포트는 STARTTLS를 **반드시** 올린다(올리지 못하면 연결을 포기한다).
 *   아이디와 비밀번호가 평문으로 오가는 일이 없다.
 * - TLS 1.2 미만은 쓰지 않는다.
 * - 메일에 파일 경로나 주소가 섞여 서버 파일을 읽거나 외부 주소를 부르는 기능은 끈다.
 * - 라이브러리의 연결 · 응답 대기 시간을 짧게 둔다(기본값은 2분 · 30초라 가입 화면이 오래 멈춘다).
 */
export function createSmtpTransport(connection: SmtpConnection): SmtpTransport {
  return createTrackedTransport(baseOptions(connection), connection);
}

function requiredText(config: ConfigReader, key: string): string {
  const value = config.get(key)?.trim();
  if (!value) throw new Error(`MAIL_TRANSPORT=smtp에는 ${key} 환경변수가 필요합니다`);
  return value;
}

function readSmtpConnection(config: ConfigReader): SmtpConnection {
  const host = requiredText(config, 'SMTP_HOST');
  if (!HOST_PATTERN.test(host))
    throw new Error('SMTP_HOST는 서버 주소만 적어야 합니다 (예: smtp.example.com)');

  const rawPort = requiredText(config, 'SMTP_PORT');
  const port = Number(rawPort);
  if (!/^\d{1,5}$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT는 1~65535 사이의 숫자여야 합니다 (예: 587)');
  }

  return {
    host,
    port,
    user: requiredText(config, 'SMTP_USER'),
    pass: requiredText(config, 'SMTP_PASS'),
  };
}

function readSenderAddress(config: ConfigReader): string {
  const from = requiredText(config, 'MAIL_FROM');
  if (!SENDER_ADDRESS_PATTERN.test(from)) {
    throw new Error('MAIL_FROM은 이메일 주소 하나여야 합니다 (예: noreply@example.com)');
  }
  return from;
}

/**
 * 설정에 따라 메일 발송 수단을 고른다.
 *
 * - `MAIL_TRANSPORT=smtp`: SMTP 서버로 보낸다. `SMTP_HOST` · `SMTP_PORT` · `SMTP_USER` · `SMTP_PASS` · `MAIL_FROM`이 필요하다.
 *   설정이 빠졌거나 틀렸으면 서버를 띄우기 전에 실패한다(운영에서 모르고 지나가는 것보다 낫다).
 * - `MAIL_TRANSPORT=log`: 서버 로그에 남긴다. 개발 전용.
 * - 그 밖(없음 · 알 수 없는 값): 발송을 거부하는 쪽(안전)으로 만든다.
 *
 * 오류 문구에는 환경변수 이름만 넣고 값은 넣지 않는다.
 */
export function createMailSender(
  config: ConfigReader,
  createTransportFor: (connection: SmtpConnection) => SmtpTransport = createSmtpTransport,
): MailSender {
  const transport = config.get('MAIL_TRANSPORT')?.trim();

  if (transport === 'smtp') {
    const connection = readSmtpConnection(config);
    const from = readSenderAddress(config);
    // 발송마다 새 전송 수단을 만든다(시간 초과 때 그 발송의 연결만 끊기 위해)
    const openTransport: SmtpTransportFactory = () => createTransportFor(connection);
    return new SmtpMailSender(openTransport, from);
  }

  return new LogMailSender(transport === 'log');
}
