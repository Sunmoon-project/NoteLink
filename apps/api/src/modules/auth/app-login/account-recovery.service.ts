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
import type { AccountId } from './app-login-input.js';
import { EmailCodeService } from './email-code.service.js';
import { MAIL_SENDER, MailUnavailableError, type MailSender } from '../../mail/mail-sender.js';

/**
 * 아이디 찾기 · 비밀번호 재설정(FR-01). 아이디는 가입 때 따로 정하고, 이메일은 인증에만 쓴다(아이디를 두기 전 계정은 이메일이 아이디).
 *
 * ① 인증번호 받기(`recovery` 목적): 가입한 이메일이면 인증번호를, 아니면 「가입한 계정이 없어요」 메일을 보낸다.
 *    응답은 두 경우가 같아서 가입 여부를 응답으로 알아낼 수 없다. 발송 제한은 가입과 같은 규칙(60초 · 1시간 5번).
 * ② 아이디 찾기: 이메일 + 인증번호가 맞으면 그 이메일로 가입한 아이디를 알려 준다(인증번호는 한 번 쓰면 끝).
 * ③ 비밀번호 재설정: 인증번호가 맞고 아이디가 그 이메일의 계정이면 새 비밀번호로 바꾸고, 모든 기기 로그인을 끊는다.
 *    아이디 · 이메일이 맞는지는 인증번호를 확인한 뒤에 본다(인증번호 없이 아이디 · 이메일 짝을 알아낼 수 없게).
 *    맞지 않으면 그 인증번호는 이미 쓴 것이라 새로 받아야 한다.
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

  /** 인증번호가 맞으면 그 이메일로 가입한 아이디(아이디를 두기 전 계정은 가입 이메일). 없거나 간편 로그인 계정이면 null */
  async findId(email: string, code: string): Promise<{ id: string | null }> {
    await this.useCode(email, code);
    return { id: loginIdOf(await this.findUser(email)) };
  }

  async resetPassword(id: AccountId, email: string, code: string, password: string): Promise<void> {
    // 인증번호를 먼저 확인한다(맞으면 한 번 쓴 것이 된다) — 인증번호 없이 아이디 · 이메일 짝을 알아낼 수 없게
    await this.useCode(email, code);
    const user = await this.findUser(email);
    if (!user || loginIdOf(user) === null) {
      throw new BadRequestException({
        code: APP_LOGIN_ERRORS.EMAIL_CODE_INVALID,
        message: '가입한 계정이 없어요',
      });
    }
    // 로그인처럼 아이디 대신 가입 이메일을 넣어도 같은 계정이다
    const matches = 'loginId' in id ? user.loginId === id.loginId : user.email === id.email;
    if (!matches) {
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message:
          '이 이메일로 가입한 아이디가 아니에요. 아이디 찾기로 확인한 뒤 인증번호를 다시 받아 주세요',
      });
    }
    const passwordHash = await hash(password, this.hashCost);
    // 비밀번호를 바꾸면 다른 기기의 로그인은 끊는다(잃어버린 기기 · 남이 쓰던 세션 정리).
    // 새 해시와 끊은 시각을 한 번에 적어, 비밀번호만 바뀌고 예전 로그인이 남는 일이 없게 한다
    // 세션 버전도 같은 갱신에서 올라가므로, 이 갱신 전에 예전 비밀번호를 읽은 로그인의 토큰은 언제 만들어졌든 거절된다
    await this.tokens.revokeAll(user._id, new Date(), { passwordHash });
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

/**
 * 계정의 로그인 아이디. 아이디를 두기 전 이메일 가입 계정은 이메일이 아이디다.
 * 간편 로그인만 쓰는 계정(비밀번호 없음)은 아이디로 로그인할 수 없어 null이다
 */
function loginIdOf(
  user: { loginId?: string | null; email?: string | null; passwordHash?: string | null } | null,
): string | null {
  if (!user) return null;
  if (user.loginId) return user.loginId;
  return user.passwordHash && user.email ? user.email : null;
}
