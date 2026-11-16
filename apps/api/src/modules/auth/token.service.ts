import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import type { JwtConfig } from '../../config/jwt.config.js';
import { RefreshToken, type RefreshTokenDocument } from './schemas/refresh-token.schema.js';
import { User } from './schemas/user.schema.js';

/** `createJwtConfig`로 만든 설정을 이 이름으로 넣어 둔다(auth.module에서 연결) */
export const JWT_CONFIG = 'JWT_CONFIG';

/** 앱이 401 + 이 코드를 받으면 refresh 토큰으로 새 토큰을 받아 온다(packages/shared ERROR_CODES.TOKEN_EXPIRED) */
export const TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

export type DeviceInfo = Record<string, unknown>;

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    @Inject(JWT_CONFIG) private readonly config: JwtConfig,
    @InjectModel(RefreshToken.name) private readonly refreshTokens: Model<RefreshTokenDocument>,
    @InjectModel(User.name) private readonly users: Model<User>,
  ) {}

  /**
   * 이 사용자의 모든 기기 로그인을 끊는다(비밀번호를 바꿨거나 탈퇴할 때). 끊은 시각을 사용자에 적어 그 전에 발급된
   * access · refresh 토큰을 모두 거절하고(assertActive), refresh 토큰 줄도 폐기한다.
   * @param alsoSet 끊기와 함께 사용자에 적을 값(예: 새 비밀번호 해시). 한 번의 갱신으로 적어서, 비밀번호는 바뀌었는데
   *   로그인은 안 끊기는 일이 없게 한다. 줄 폐기가 실패해도 끊은 시각이 이미 적혀 있어 토큰은 거절된다
   */
  async revokeAll(
    userId: Types.ObjectId,
    now = new Date(),
    alsoSet: Record<string, unknown> = {},
  ): Promise<void> {
    // 세션 버전을 같은 갱신에서 올린다: 이 갱신 전에 사용자를 읽고 만든 토큰은 버전이 달라 모두 거절된다
    await this.users.updateOne(
      { _id: userId },
      { $set: { ...alsoSet, sessionsRevokedAt: now }, $inc: { sessionVersion: 1 } },
    );
    // 이미 폐기된 줄도 덮어쓴다: 갱신 중이던 토큰의 표시(claimId)를 지워 되살아나지 않게(rotate)
    await this.refreshTokens.updateMany({ userId }, { revokedAt: now, claimId: null });
  }

  /**
   * 토큰을 받아도 되는 사용자인지: 탈퇴하지 않았고, 토큰 발급 시각이 로그인을 끊은 시각보다 늦어야 한다(같은 밀리초도 거절).
   * 발급 시각은 밀리초(iatMs)로 비교한다 — 초 단위 iat만 보면 끊기 직전 같은 초에 받은 토큰이 통과한다.
   * iatMs가 없는 예전 토큰은 iat(초)를 내림해 쓰므로, 끊은 그 초에 받았어도 거절된다.
   */
  private async assertActive(
    userId: string,
    payload: { iat?: unknown; iatMs?: unknown; sv?: unknown },
    /** 주면 사용자의 비밀번호 해시가 아직 이 값과 같아야 한다(로그인이 확인한 비밀번호가 그사이 바뀌지 않았는지) */
    passwordHash?: string,
  ): Promise<void> {
    const user = await this.users
      .findOne(
        { _id: new Types.ObjectId(userId) },
        {
          deletedAt: 1,
          sessionsRevokedAt: 1,
          sessionVersion: 1,
          ...(passwordHash === undefined ? {} : { passwordHash: 1 }),
        },
      )
      .lean<{
        deletedAt?: Date | null;
        sessionsRevokedAt?: Date | null;
        sessionVersion?: number;
        passwordHash?: string | null;
      }>();
    if (!user || user.deletedAt) throw invalidToken();
    // 세션 버전이 다르면 그사이 로그인이 끊겼다(sv가 없는 예전 토큰은 0으로 본다)
    if ((user.sessionVersion ?? 0) !== (typeof payload.sv === 'number' ? payload.sv : 0)) {
      throw invalidToken();
    }
    if (passwordHash !== undefined && user.passwordHash !== passwordHash) throw invalidToken();
    const revoked = user.sessionsRevokedAt;
    if (revoked) {
      const issuedMs =
        typeof payload.iatMs === 'number'
          ? payload.iatMs
          : typeof payload.iat === 'number'
            ? payload.iat * 1000
            : 0;
      if (issuedMs <= revoked.getTime()) throw invalidToken();
    }
  }

  /**
   * 로그인할 때마다 호출한다. 기기마다 자기 refresh 토큰 한 줄이 생긴다
   * @param authorizedAt 로그인을 확인한 시각(비밀번호를 읽기 직전). 그 뒤에 로그인이 끊겼으면(비밀번호 재설정 ·
   *   탈퇴) 확인에 쓴 비밀번호가 이미 바뀐 것이라, 만든 토큰을 지우고 거절한다. 끊기가 발급 뒤에 오면 revokeAll이 지운다
   * @param passwordHash 로그인이 확인한 비밀번호 해시. 토큰을 만든 뒤 DB의 해시가 이것과 다르면(그사이 재설정) 거절한다.
   *   끊은 시각은 재설정이 DB에 쓰기 직전에 정해져서, 그 틈에 예전 해시를 읽은 로그인은 시각만으로는 걸러지지 않는다
   */
  async issue(
    userId: string,
    device?: DeviceInfo,
    authorizedAt?: Date,
    passwordHash?: string,
    /** 로그인이 비밀번호와 함께 읽은 세션 버전. 주지 않으면 지금 값을 읽어 쓴다 */
    sessionVersion?: number,
  ): Promise<IssuedTokens> {
    const next = await this.mint(userId, device, sessionVersion);
    if (authorizedAt) {
      try {
        await this.assertActive(
          userId,
          { iatMs: authorizedAt.getTime(), sv: next.sessionVersion },
          passwordHash,
        );
      } catch (error) {
        await this.discard(next.rowId);
        throw error;
      }
    }
    return next.tokens;
  }

  /**
   * refresh 토큰을 새 토큰 한 쌍으로 바꾼다. 쓴 토큰은 폐기한다.
   *
   * 순서가 중요하다: 새 토큰을 먼저 저장하고, 성공하면 기존 토큰을 폐기한다.
   * 저장이 실패해도 기존 토큰은 그대로 살아 있어 앱이 다시 시도할 수 있다(세션을 잃지 않음).
   * MongoDB 트랜잭션은 레플리카셋이 필요해 로컬 단독 서버(mongod)에서 쓸 수 없어 이 방식을 쓴다.
   */
  async rotate(refreshToken: string): Promise<IssuedTokens> {
    const payload = await this.verifyRefresh(refreshToken);
    // 탈퇴했거나 로그인을 끊은 뒤라면 남은 refresh 토큰으로도 갱신하지 않는다
    await this.assertActive(payload.sub, payload);
    const tokenHash = hashToken(refreshToken);
    const current = await this.refreshTokens.findOne({
      tokenHash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });
    if (!current) throw invalidToken();

    // 세션 버전은 쓴 토큰의 것을 이어 간다(위 assertActive가 지금 값과 같은지 확인했다)
    const next = await this.mint(payload.sub, current.device, payload.sv ?? 0);

    // 조회와 폐기를 한 번에 해서, 같은 토큰으로 동시에 두 번 요청해도 한쪽만 이긴다.
    // 위에서 확인한 뒤 새 토큰을 만드는 사이에 기존 토큰이 만료될 수 있어 만료 조건도 다시 건다
    const claimedAt = new Date();
    const claimId = randomUUID();
    const claimed = await this.refreshTokens.findOneAndUpdate(
      { tokenHash, revokedAt: null, expiresAt: { $gt: claimedAt } },
      { revokedAt: claimedAt, claimId },
    );
    if (!claimed) {
      // 동시 요청에 졌거나 그사이 만료됐다. 앱에 돌려주지 않은 새 토큰의 줄을 지운다
      await this.discard(next.rowId);
      throw invalidToken();
    }
    // 처음 확인한 뒤 새 토큰을 만드는 사이에 로그인이 끊겼으면(revokeAll) 새 토큰은 끊기 뒤에 만들어져 살아남는다.
    // 쓴 토큰을 다시 확인해서 그때도 막는다
    try {
      await this.assertActive(payload.sub, payload);
    } catch (error) {
      await this.discard(next.rowId);
      if (!(error instanceof UnauthorizedException)) {
        // 끊긴 게 아니라 DB를 읽지 못했다: 쓴 토큰을 되살려 앱이 같은 토큰으로 다시 갱신할 수 있게 한다.
        // 우리 표시(claimId)가 그대로일 때만 되살린다 — 그사이 로그아웃 · revokeAll이 표시를 지웠으면 그대로 둔다.
        // 그사이 로그인이 끊겼다면 다음 갱신의 첫 확인(assertActive)도 막는다
        await this.refreshTokens
          .updateOne({ tokenHash, claimId }, { revokedAt: null, claimId: null })
          .catch(() => undefined);
      }
      throw error;
    }
    return next.tokens;
  }

  /** 앱에 돌려주지 않은 새 토큰의 줄을 지운다. 못 지워도 그 토큰을 가진 쪽이 없어서 쓰일 수 없다 */
  private async discard(rowId: Types.ObjectId): Promise<void> {
    try {
      await this.refreshTokens.deleteOne({ _id: rowId });
    } catch {
      // 정리 실패는 무시한다
    }
  }

  /** 로그아웃. 이미 폐기됐거나 없는 토큰이어도 오류 없이 끝낸다 */
  async revoke(refreshToken: string): Promise<void> {
    // 이미 폐기된 줄도 덮어쓴다: 갱신 중이던 토큰의 표시(claimId)를 지워 rotate가 되살리지 않게 한다
    await this.refreshTokens.updateOne(
      { tokenHash: hashToken(refreshToken) },
      { revokedAt: new Date(), claimId: null },
    );
  }

  private async mint(
    userId: string,
    device?: DeviceInfo,
    sessionVersion?: number,
  ): Promise<{ tokens: IssuedTokens; rowId: Types.ObjectId; sessionVersion: number }> {
    // iatMs: 로그인 끊기와 밀리초로 비교하려고 넣는다(assertActive)
    const iatMs = Date.now();
    // sv: 세션 버전(assertActive). 모르면 지금 값을 읽는다
    const sv = sessionVersion ?? (await this.currentSessionVersion(userId));
    const accessToken = await this.jwt.signAsync(
      { sub: userId, iatMs, sv },
      { secret: this.config.accessSecret, expiresIn: this.config.accessTTL },
    );
    // jti: 같은 사용자가 같은 초에 두 번 로그인해도 토큰이 서로 달라지게 한다(tokenHash가 unique)
    const refreshToken = await this.jwt.signAsync(
      { sub: userId, jti: randomUUID(), iatMs, sv },
      { secret: this.config.refreshSecret, expiresIn: this.config.refreshTTL },
    );
    const { exp } = this.jwt.decode<{ exp: number }>(refreshToken);
    const row = await this.refreshTokens.create({
      userId: new Types.ObjectId(userId),
      tokenHash: hashToken(refreshToken),
      device,
      expiresAt: new Date(exp * 1000),
    });
    return { tokens: { accessToken, refreshToken }, rowId: row._id, sessionVersion: sv };
  }

  private async currentSessionVersion(userId: string): Promise<number> {
    const user = await this.users
      .findOne({ _id: new Types.ObjectId(userId) }, { sessionVersion: 1 })
      .lean<{ sessionVersion?: number }>();
    return user?.sessionVersion ?? 0;
  }

  /**
   * access 토큰을 검증해 사용자 id를 돌려준다(요청을 인증할 때 쓴다). 서명 · 만료에 더해 탈퇴 · 로그인 끊기를 본다.
   * 만료 · 위조 · 형식 오류를 구분하지 않고 모두 401 + AUTH_TOKEN_EXPIRED로 돌려준다:
   * 앱은 이 코드를 받으면 refresh 토큰으로 갱신을 시도하고, 갱신도 안 되면 로그인 화면으로 보낸다.
   * refresh 토큰은 다른 시크릿으로 서명하므로 access 자리에 내밀어도 통과하지 못한다.
   */
  async verifyAccess(accessToken: string): Promise<{ userId: string }> {
    let payload: { sub?: unknown; iat?: unknown; iatMs?: unknown; sv?: unknown };
    try {
      payload = await this.jwt.verifyAsync<{
        sub?: unknown;
        iat?: unknown;
        iatMs?: unknown;
        sv?: unknown;
      }>(accessToken, {
        secret: this.config.accessSecret,
      });
    } catch {
      throw invalidToken();
    }
    // 서버가 발급한 토큰의 sub는 항상 사용자 id(ObjectId 16진수 24자리)다
    if (typeof payload.sub !== 'string' || !OBJECT_ID_PATTERN.test(payload.sub)) {
      throw invalidToken();
    }
    // 탈퇴 · 로그인 끊기를 만료 전에도 바로 반영한다(요청마다 사용자 한 명을 읽는다)
    await this.assertActive(payload.sub, payload);
    return { userId: payload.sub };
  }

  private async verifyRefresh(
    refreshToken: string,
  ): Promise<{ sub: string; iat?: number; iatMs?: number; sv?: number }> {
    try {
      return await this.jwt.verifyAsync<{ sub: string; iat?: number; iatMs?: number; sv?: number }>(
        refreshToken,
        {
          secret: this.config.refreshSecret,
        },
      );
    } catch {
      throw invalidToken();
    }
  }
}

/** DB에는 토큰 원문 대신 해시를 저장한다. DB가 유출돼도 토큰을 그대로 쓸 수 없다 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function invalidToken(): UnauthorizedException {
  return new UnauthorizedException({ code: TOKEN_EXPIRED, message: '다시 로그인해 주세요' });
}
