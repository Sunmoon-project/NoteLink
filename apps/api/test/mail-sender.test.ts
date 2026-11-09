import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMailSender } from '../src/modules/mail/create-mail-sender.js';
import {
  LogMailSender,
  MAIL_SENDER,
  MailUnavailableError,
} from '../src/modules/mail/mail-sender.js';

const config = (values: Record<string, string | undefined>) => ({ get: (k: string) => values[k] });

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('LogMailSender (개발용: 메일 대신 서버 로그)', () => {
  describe('켜져 있을 때', () => {
    it('인증번호를 받는 사람과 함께 로그에 남긴다', async () => {
      await new LogMailSender(true).sendVerificationCode('a@example.com', '012345');

      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain('a@example.com');
      expect(String(warn.mock.calls[0]![0])).toContain('012345');
    });

    it('앞자리가 0인 인증번호도 그대로 남긴다', async () => {
      await new LogMailSender(true).sendVerificationCode('a@example.com', '000042');

      expect(String(warn.mock.calls[0]![0])).toContain('000042');
    });

    it('이미 가입한 이메일 안내는 인증번호 없이 받는 사람만 남긴다', async () => {
      await new LogMailSender(true).sendAlreadyRegistered('a@example.com');

      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain('a@example.com');
      expect(String(warn.mock.calls[0]![0])).not.toMatch(/\d{6}/);
    });

    it('이미 가입한 이메일 안내는 인증번호 메일과 구분되는 문구다', async () => {
      const sender = new LogMailSender(true);
      await sender.sendVerificationCode('a@example.com', '123456');
      await sender.sendAlreadyRegistered('a@example.com');

      expect(String(warn.mock.calls[0]![0])).not.toBe(String(warn.mock.calls[1]![0]));
    });
  });

  describe('꺼져 있을 때 (운영 기본값)', () => {
    it('인증번호 메일은 보내지 않고 MailUnavailableError를 던진다', async () => {
      await expect(
        new LogMailSender(false).sendVerificationCode('a@example.com', '123456'),
      ).rejects.toThrow(MailUnavailableError);
    });

    it('이미 가입한 이메일 안내도 거부한다', async () => {
      await expect(new LogMailSender(false).sendAlreadyRegistered('a@example.com')).rejects.toThrow(
        MailUnavailableError,
      );
    });

    it('인증번호를 로그에 남기지 않는다 (운영 로그로 인증번호가 새면 안 된다)', async () => {
      await new LogMailSender(false)
        .sendVerificationCode('a@example.com', '987654')
        .catch(() => {});

      expect(warn).not.toHaveBeenCalled();
    });

    it('오류 문구에 인증번호나 이메일을 넣지 않는다', async () => {
      const error = await new LogMailSender(false)
        .sendVerificationCode('secret@example.com', '987654')
        .catch((e: Error) => e);

      expect((error as Error).message).not.toContain('987654');
      expect((error as Error).message).not.toContain('secret@example.com');
    });

    it('오류 문구는 고정된 안내뿐이다 (설정값이나 입력값이 섞여 들어가지 않는다)', async () => {
      const error = await new LogMailSender(false)
        .sendVerificationCode('secret@example.com', '987654')
        .catch((e: Error) => e);

      expect((error as Error).message).toBe(
        '메일 발송 수단이 설정되지 않았습니다 (MAIL_TRANSPORT)',
      );
    });

    it('오류 이름은 MailUnavailableError이다 (호출하는 쪽이 503으로 바꿀 수 있다)', async () => {
      const error = await new LogMailSender(false)
        .sendVerificationCode('a@example.com', '123456')
        .catch((e: Error) => e);

      expect((error as Error).name).toBe('MailUnavailableError');
    });
  });
});

describe('createMailSender (설정에서 발송 수단 고르기)', () => {
  it('MAIL_TRANSPORT=log이면 로그로 남긴다', async () => {
    await createMailSender(config({ MAIL_TRANSPORT: 'log' })).sendVerificationCode(
      'a@example.com',
      '123456',
    );

    expect(warn).toHaveBeenCalledOnce();
  });

  it('앞뒤 공백이 있어도 log로 본다', async () => {
    await createMailSender(config({ MAIL_TRANSPORT: ' log \n' })).sendVerificationCode(
      'a@example.com',
      '123456',
    );

    expect(warn).toHaveBeenCalledOnce();
  });

  it.each([
    ['설정 없음', undefined],
    ['빈 문자열', ''],
    ['공백뿐', '   '],
    ['알 수 없는 값', 'smtp'],
    ['대소문자가 다름(LOG)', 'LOG'],
    ['비슷한 값(logs)', 'logs'],
    ['true', 'true'],
  ])(
    'MAIL_TRANSPORT가 %s이면 발송을 거부한다 (명시적으로 log라고 했을 때만 허용)',
    async (_r, value) => {
      const sender = createMailSender(config({ MAIL_TRANSPORT: value }));

      await expect(sender.sendVerificationCode('a@example.com', '123456')).rejects.toThrow(
        MailUnavailableError,
      );
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('NODE_ENV가 development여도 MAIL_TRANSPORT를 명시하지 않으면 거부한다 (환경 이름에 기대지 않는다)', async () => {
    const sender = createMailSender(config({ NODE_ENV: 'development' }));

    await expect(sender.sendVerificationCode('a@example.com', '123456')).rejects.toThrow(
      MailUnavailableError,
    );
  });
});

describe('주입 이름', () => {
  it('MAIL_SENDER 이름표를 쓴다', () => {
    expect(MAIL_SENDER).toBe('MAIL_SENDER');
  });
});
