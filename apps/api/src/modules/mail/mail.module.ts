import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createMailSender } from './create-mail-sender.js';
import { MAIL_SENDER } from './mail-sender.js';

/**
 * 메일 발송. `MAIL_SENDER`로 발송 수단을 내보낸다. 메일을 보내야 하는 기능은 이 모듈을 가져와서
 * `@Inject(MAIL_SENDER)`로 받는다. 어떤 수단을 쓸지는 `MAIL_TRANSPORT` 환경변수가 정한다.
 */
@Module({
  providers: [
    {
      provide: MAIL_SENDER,
      inject: [ConfigService],
      useFactory: createMailSender,
    },
  ],
  exports: [MAIL_SENDER],
})
export class MailModule {}
