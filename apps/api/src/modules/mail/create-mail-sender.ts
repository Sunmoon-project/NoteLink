import { createTransport } from 'nodemailer';

import { type ConfigReader } from '../../config/mongo.config.js';
import { LogMailSender, type MailSender } from './mail-sender.js';
import { SmtpMailSender, type SmtpTransport } from './smtp-mail-sender.js';

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

/**
 * nodemailer 전송 수단을 만든다.
 * - 항상 암호화한다: 465는 처음부터, 그 밖의 포트는 STARTTLS를 **반드시** 올린다(올리지 못하면 연결을 포기한다).
 *   아이디와 비밀번호가 평문으로 오가는 일이 없다.
 * - TLS 1.2 미만은 쓰지 않는다.
 * - 메일에 파일 경로나 주소가 섞여 서버 파일을 읽거나 외부 주소를 부르는 기능은 끈다.
 * - 라이브러리의 연결 · 응답 대기 시간을 짧게 둔다(기본값은 2분 · 30초라 가입 화면이 오래 멈춘다).
 */
export function createSmtpTransport(connection: SmtpConnection): SmtpTransport {
  const secure = connection.port === IMPLICIT_TLS_PORT;
  return createTransport({
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
  });
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
    return new SmtpMailSender(createTransportFor(connection), from);
  }

  return new LogMailSender(transport === 'log');
}
