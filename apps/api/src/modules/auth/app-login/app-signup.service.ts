import { hash } from 'bcrypt';

import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { initialNickname } from '../social-login/initial-nickname.js';
import { User, type UserDocument } from '../schemas/user.schema.js';
import {
  EMAIL_CODE_RESEND_COOLDOWN_MS,
  type IssueResult,
  EmailCodeService,
} from './email-code.service.js';
import { APP_LOGIN_ERRORS } from './app-login-errors.js';
import { EmailProofService } from './email-proof.service.js';
import { MAIL_SENDER, MailUnavailableError, type MailSender } from './mail-sender.js';

/** bcrypt 비용. 2^12번 반복 */
export const PASSWORD_HASH_COST = 12;

/** 비밀번호 해시 비용을 바꿔 끼울 때 쓰는 주입 이름. 시험에서 느린 해시를 피하려고 쓰며, 서버에서는 등록하지 않는다 */
export const PASSWORD_HASH_COST_TOKEN = 'PASSWORD_HASH_COST';

/** MongoDB 유일 인덱스 위반 */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

/**
 * 앱 자체 가입의 세 단계: 인증번호 보내기 → 인증번호 확인 → 비밀번호 정하고 가입.
 * 입력 형식은 호출하는 쪽(컨트롤러)이 `app-login-input`으로 이미 검증했다고 본다.
 */
@Injectable()
export class AppSignupService {
  constructor(
    private readonly codes: EmailCodeService,
    private readonly proofs: EmailProofService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    @Optional()
    @Inject(PASSWORD_HASH_COST_TOKEN)
    private readonly hashCost: number = PASSWORD_HASH_COST,
  ) {}

  /**
   * 가입용 인증번호를 메일로 보낸다.
   *
   * 이미 가입한 이메일이어도 **응답은 똑같이 "보냈다"**이고 발송 제한도 똑같이 걸린다. 달라지는 것은 메일 내용뿐이다
   * (인증번호 대신 "이미 가입했다"는 안내). 화면 응답으로 가입 여부를 알려 주면 남의 가입 여부를 조회할 수 있다.
   */
  async sendCode(email: string): Promise<void> {
    // 가입 여부와 상관없이 제한을 똑같이 적용하려고, 항상 먼저 발급을 시도한다
    const issued = await this.codes.issue(email, 'signup');
    if (!issued.ok) throw rateLimited(issued);

    try {
      if (await this.isRegistered(email)) {
        await this.mail.sendAlreadyRegistered(email);
      } else {
        await this.mail.sendVerificationCode(email, issued.code);
      }
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

  /**
   * 인증번호를 확인하고, 맞으면 가입 때 낼 인증 증표를 돌려준다.
   * @returns 증표와 그 수명(초)
   */
  async verifyCode(
    email: string,
    code: string,
  ): Promise<{ verificationToken: string; expiresInSeconds: number }> {
    const result = await this.codes.verify(email, 'signup', code);
    if (result.ok) {
      const { token, expiresInSeconds } = await this.proofs.issue({
        email,
        purpose: 'signup',
        verifiedAt: result.verifiedAt,
      });
      return { verificationToken: token, expiresInSeconds };
    }
    if (result.reason === 'locked') {
      throw new HttpException(
        {
          code: APP_LOGIN_ERRORS.EMAIL_CODE_LOCKED,
          message: '인증번호를 너무 많이 틀렸어요. 인증번호를 다시 받아 주세요',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    throw new BadRequestException({
      code: APP_LOGIN_ERRORS.EMAIL_CODE_INVALID,
      message: '인증번호가 맞지 않아요',
      // 틀린 경우에만 남은 횟수를 알려 준다(없음 · 만료 · 이미 씀과 구분되지 않게 그 경우엔 넣지 않는다)
      ...(result.reason === 'wrong' ? { attemptsLeft: result.attemptsLeft } : {}),
    });
  }

  /**
   * 인증을 마친 이메일로 비밀번호를 정해 계정을 만든다. 로그인은 하지 않는다(토큰을 주지 않는다).
   * 이메일은 요청에서 받지 않고 증표 안의 값만 쓴다: 인증한 이메일과 다른 이메일로 가입할 수 없다.
   */
  async signup(verificationToken: string, password: string): Promise<void> {
    const proof = await this.proofs.verify(verificationToken);
    if (!proof.ok) {
      throw new UnauthorizedException(
        proof.reason === 'expired'
          ? {
              code: APP_LOGIN_ERRORS.EMAIL_PROOF_EXPIRED,
              message: '인증 시간이 지났어요. 이메일 인증을 다시 해 주세요',
            }
          : { code: APP_LOGIN_ERRORS.EMAIL_PROOF_INVALID, message: '이메일 인증을 다시 해 주세요' },
      );
    }

    // 증표를 먼저 소비한다: 같은 증표로 두 번 가입할 수 없고, 인증번호를 다시 받았다면 이전 증표는 여기서 걸린다
    if (!(await this.codes.consume(proof.email, proof.purpose, proof.verifiedAt))) {
      throw new UnauthorizedException({
        code: APP_LOGIN_ERRORS.EMAIL_PROOF_INVALID,
        message: '이메일 인증을 다시 해 주세요',
      });
    }

    const passwordHash = await hash(password, this.hashCost);
    try {
      await this.users.create({
        email: proof.email,
        passwordHash,
        nickname: initialNickname(null),
      });
    } catch (error) {
      // 이미 가입했거나, 같은 이메일을 가진 다른 계정(소셜 포함)이 있다. 유일 인덱스가 마지막 방어선이다
      if (isDuplicateKey(error)) throw emailTaken();
      throw error;
    }
  }

  /** 탈퇴하지 않은 사용자 중 이 이메일을 가진 계정이 있는지(소셜로 가입한 계정 포함) */
  private async isRegistered(email: string): Promise<boolean> {
    return (await this.users.exists({ email, deletedAt: null })) !== null;
  }
}

function emailTaken(): ConflictException {
  return new ConflictException({
    code: APP_LOGIN_ERRORS.EMAIL_TAKEN,
    message: '이미 가입한 이메일이에요. 처음 가입한 방법으로 로그인해 주세요',
  });
}

function rateLimited(blocked: Extract<IssueResult, { ok: false }>): HttpException {
  const retryAfterSeconds = Math.ceil(blocked.retryAfterMs / 1000);
  return new HttpException(
    {
      code: APP_LOGIN_ERRORS.RATE_LIMITED,
      message:
        blocked.reason === 'cooldown'
          ? '잠시 뒤에 다시 요청해 주세요'
          : '요청이 너무 많아요. 나중에 다시 시도해 주세요',
      retryAfterSeconds,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

export { APP_LOGIN_ERRORS };

// 재발송 간격을 외부에서 참고할 수 있게 다시 내보낸다(응답 문구 · 화면 타이머 근거)
export { EMAIL_CODE_RESEND_COOLDOWN_MS };
