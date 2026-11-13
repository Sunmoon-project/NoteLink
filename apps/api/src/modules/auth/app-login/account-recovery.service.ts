import { hash } from 'bcrypt';

import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES } from '@notelink/shared';
import { Model } from 'mongoose';

import { User, type UserDocument } from '../schemas/user.schema.js';
import { TokenService } from '../token.service.js';
import { APP_LOGIN_ERRORS } from './app-login-errors.js';
import {
  PASSWORD_HASH_COST,
  PASSWORD_HASH_COST_TOKEN,
  codeRejected,
  rateLimited,
} from './app-signup.service.js';
import { EmailCodeService } from './email-code.service.js';
import { MAIL_SENDER, MailUnavailableError, type MailSender } from '../../mail/mail-sender.js';

/**
 * 아이디 찾기 · 비밀번호 재설정(FR-01). 로그인 아이디는 가입 이메일이다.
 *
 * ① 인증번호 받기(`recovery` 목적): 가입한 이메일이면 인증번호를, 아니면 「가입한 계정이 없어요」 메일을 보낸다.
 *    응답은 두 경우가 같아서 가입 여부를 응답으로 알아낼 수 없다. 발송 제한은 가입과 같은 규칙(60초 · 1시간 5번).
 * ② 아이디 찾기: 이메일 + 인증번호가 맞으면 그 이메일로 가입한 아이디를 알려 준다(인증번호는 한 번 쓰면 끝).
 * ③ 비밀번호 재설정: 아이디와 이메일이 같은 계정이고 인증번호가 맞으면 새 비밀번호로 바꾸고, 모든 기기 로그인을 끊는다.
 */
@Injectable()
export class AccountRecoveryService {
  constructor(
    private readonly codes: EmailCodeService,
    private readonly tokens: TokenService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @Optional()
    @Inject(PASSWORD_HASH_COST_TOKEN)
    private readonly hashCost: number = PASSWORD_HASH_COST,
  ) {}

  async sendCode(email: string): Promise<void> {
    const issued = await this.codes.issue(email, 'recovery');
    if (!issued.ok) throw rateLimited(issued);
    try {
      if (await this.findUser(email)) await this.mail.sendRecoveryCode(email, issued.code);
      else await this.mail.sendNoAccount(email);
    } catch (error) {
      if (error instanceof MailUnavailableError) {
        throw new ServiceUnavailableException({
          code: APP_LOGIN_ERRORS.MAIL_UNAVAILABLE,
          message: '인증 메일을 보내지 못했어요. 잠시 뒤 다시 시도해 주세요',
        });
      }
      throw error;
    }
  }

  /** 인증번호가 맞으면 그 이메일로 가입한 아이디(가입 이메일). 그사이 탈퇴했으면 null */
  async findId(email: string, code: string): Promise<{ id: string | null }> {
    await this.useCode(email, code);
    return { id: (await this.findUser(email)) ? email : null };
  }

  async resetPassword(id: string, email: string, code: string, password: string): Promise<void> {
    if (id !== email) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '아이디와 이메일이 같은 계정이 아니에요',
      });
    }
    await this.useCode(email, code);
    const user = await this.findUser(email);
    if (!user) {
      throw new BadRequestException({
        code: APP_LOGIN_ERRORS.EMAIL_CODE_INVALID,
        message: '가입한 계정이 없어요',
      });
    }
    const passwordHash = await hash(password, this.hashCost);
    await this.users.updateOne({ _id: user._id }, { $set: { passwordHash } });
    // 비밀번호를 바꾸면 다른 기기의 로그인은 끊는다(잃어버린 기기 · 남이 쓰던 세션 정리)
    await this.tokens.revokeAll(user._id);
  }

  /** 인증번호를 확인하고 바로 써 버린다(한 번만 쓸 수 있다) */
  private async useCode(email: string, code: string): Promise<void> {
    const result = await this.codes.verify(email, 'recovery', code);
    if (!result.ok) throw codeRejected(result);
    await this.codes.consume(email, 'recovery', result.verifiedAt);
  }

  private findUser(email: string) {
    return this.users.findOne({ email, deletedAt: null }).lean();
  }
}
