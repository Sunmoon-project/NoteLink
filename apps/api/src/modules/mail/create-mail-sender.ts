import { type ConfigReader } from '../../config/mongo.config.js';
import { LogMailSender, type MailSender } from './mail-sender.js';

/** 설정에 따라 발송 수단을 고른다. 설정이 없거나 알 수 없는 값이면 발송을 거부하는 쪽(안전)으로 만든다 */
export function createMailSender(config: ConfigReader): MailSender {
  const transport = config.get('MAIL_TRANSPORT')?.trim();
  return new LogMailSender(transport === 'log');
}
