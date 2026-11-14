import { randomBytes } from 'node:crypto';

import { compare, hash } from 'bcrypt';

import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, type UserDocument } from '../schemas/user.schema.js';
import { type AppUser, toAppUser } from '../to-app-user.js';
import { TokenService } from '../token.service.js';
import { APP_LOGIN_ERRORS } from './app-login-errors.js';
import { PASSWORD_HASH_COST, PASSWORD_HASH_COST_TOKEN } from './app-signup.service.js';
import { LoginThrottleService } from './login-throttle.service.js';

/** bcrypt는 앞 72바이트만 반영한다. 가입 때 72바이트를 넘는 비밀번호는 받지 않으므로, 넘는 입력은 맞을 수 없다 */
const PASSWORD_MAX_BYTES = 72;

/** 로그인 응답: `{ data }` 로 감싸기 전의 내용(packages/shared AuthTokens) */
export interface AppLoginResult {
  accessToken: string;
  refreshToken: string;
  user: AppUser;
}

const INVALID_CREDENTIALS_MESSAGE = '이메일 또는 비밀번호가 맞지 않아요';

/** 이메일 + 비밀번호로 로그인한다(앱 자체 가입 계정) */
@Injectable()
export class AppLoginService {
  /** 계정이 없을 때 비교할 가짜 해시. 처음 필요할 때 한 번 만들어 재사용한다 */
  private dummyHash: Promise<string> | null = null;

  constructor(
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly tokens: TokenService,
    private readonly throttle: LoginThrottleService,
    @Optional()
    @Inject(PASSWORD_HASH_COST_TOKEN)
    private readonly hashCost: number = PASSWORD_HASH_COST,
  ) {}

  /**
   * 입력 형식은 호출하는 쪽(컨트롤러)이 `app-login-input`으로 이미 검증했다고 본다.
   *
   * 실패 이유를 알리지 않는다: 없는 이메일 · 소셜로만 가입한 계정(비밀번호 없음) · 탈퇴한 계정 · 틀린 비밀번호가
   * 모두 같은 401이다. 응답 시간도 같게 하려고, 어떤 경우든 bcrypt 비교를 한 번씩 한다
   * (계정이 없다고 비교를 건너뛰면 빨리 끝나서 응답 시간으로 가입 여부를 알아낼 수 있다).
   */
  async login(email: string, password: string): Promise<AppLoginResult> {
    // 비밀번호를 확인하기 전에 시도를 하나 먼저 쓴다. 이메일 기준이라 계정이 있는지와 상관없이 똑같이 잠긴다
    const slot = await this.throttle.reserve(email);
    if (!slot.ok) throw loginLocked(slot.retryAfterMs);

    // 비밀번호를 읽기 직전 시각. 확인하는 사이에 비밀번호가 재설정되면 이 로그인의 토큰은 거절된다(TokenService.issue)
    const authorizedAt = new Date();
    const user = await this.users.findOne({ email, deletedAt: null }).lean();

    // 비교할 해시: 비밀번호를 가진 계정이면 그 해시, 아니면 같은 비용의 가짜 해시
    const storedHash = user?.passwordHash ?? null;
    const target = storedHash ?? (await this.getDummyHash());
    // 가입 때 받지 않는 길이의 입력은 앞 72바이트만 보는 bcrypt에서 엉뚱하게 맞을 수 있어 맞지 않는 것으로 본다.
    // 그래도 비교는 한 번 해서 시간 차이를 만들지 않는다
    const tooLong = Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES;
    const matched = await compare(password, target);

    if (!user || storedHash === null || tooLong || !matched) throw invalidCredentials();

    // 성공하면 횟수를 지운다(정상 사용자가 몇 번 틀리고 맞춘 경우)
    await this.throttle.clear(email);
    await this.users.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    const { accessToken, refreshToken } = await this.tokens.issue(
      String(user._id),
      undefined,
      authorizedAt,
      storedHash,
      user.sessionVersion ?? 0,
    );
    return { accessToken, refreshToken, user: toAppUser(user) };
  }

  /** 실제 계정의 해시와 같은 비용으로 만든 해시(어떤 입력과도 맞지 않는 임의의 값) */
  private getDummyHash(): Promise<string> {
    this.dummyHash ??= hash(randomBytes(16).toString('hex'), this.hashCost);
    return this.dummyHash;
  }
}

function loginLocked(retryAfterMs: number): HttpException {
  return new HttpException(
    {
      code: APP_LOGIN_ERRORS.LOGIN_LOCKED,
      message: '로그인을 너무 많이 시도했어요. 잠시 뒤에 다시 시도해 주세요',
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

function invalidCredentials(): UnauthorizedException {
  return new UnauthorizedException({
    code: APP_LOGIN_ERRORS.INVALID_CREDENTIALS,
    message: INVALID_CREDENTIALS_MESSAGE,
  });
}
