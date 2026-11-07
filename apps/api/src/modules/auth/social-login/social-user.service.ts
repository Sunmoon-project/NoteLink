import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';

import { User, type UserDocument } from '../schemas/user.schema.js';
import type { SocialProviderName } from '../schemas/social-login-attempt.schema.js';
import { initialNickname } from './initial-nickname.js';
import type { SocialProfile } from './social-provider.js';

export type SocialUserResult =
  /** 로그인에 성공했다. 처음 오는 사용자면 이번에 계정을 만들었다(created) */
  | { kind: 'signed_in'; userId: Types.ObjectId; created: boolean }
  /** 같은 인증된 이메일의 다른 계정이 있어 만들지 않았다. 지금은 합치지 않고 안내만 한다 */
  | { kind: 'account_exists' };

/** MongoDB 유일 인덱스 위반 */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

/** 소셜 로그인으로 온 사람이 어느 사용자인지 정한다(찾기 · 만들기 · 이메일 겹침 판단) */
@Injectable()
export class SocialUserService {
  constructor(@InjectModel(User.name) private readonly users: Model<UserDocument>) {}

  async findOrCreate(
    provider: SocialProviderName,
    profile: SocialProfile,
  ): Promise<SocialUserResult> {
    // 1. 이미 이 소셜 계정으로 가입한 사용자. 이메일이 아니라 제공자 고유 번호로 찾는다(이메일은 바뀔 수 있다)
    const existing = await this.signIn(provider, profile.providerUid);
    if (existing) return { kind: 'signed_in', userId: existing, created: false };

    // 2. 인증된 같은 이메일의 다른 계정이 있으면 합치지 않고 막는다.
    //    다만 그 계정이 방금 같은 구글 계정의 다른 요청이 만든 것일 수 있다(거의 동시에 두 번 로그인).
    //    그래서 겹친다고 나오면 소셜 계정으로 한 번 더 찾아, 같은 사람이면 로그인으로 처리한다
    if (profile.email !== null && (await this.emailTaken(profile.email))) {
      const sameAccount = await this.signIn(provider, profile.providerUid);
      if (sameAccount) return { kind: 'signed_in', userId: sameAccount, created: false };
      return { kind: 'account_exists' };
    }

    // 3. 새 사용자
    try {
      const created = await this.users.create({
        nickname: initialNickname(profile.name),
        email: profile.email,
        socialAccounts: [
          {
            provider,
            providerUid: profile.providerUid,
            email: profile.email,
            linkedAt: new Date(),
          },
        ],
        lastLoginAt: new Date(),
      });
      return { kind: 'signed_in', userId: created._id, created: true };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      // 거의 동시에 들어온 다른 요청이 먼저 만들었다. 그 결과를 따른다
      const winner = await this.signIn(provider, profile.providerUid);
      if (winner) return { kind: 'signed_in', userId: winner, created: false };
      return { kind: 'account_exists' }; // 같은 이메일을 가진 다른 계정과 겹쳤다
    }
  }

  /** 탈퇴하지 않은 사용자 중 이 소셜 계정을 가진 사람을 찾아 마지막 로그인 시각을 갱신한다 */
  private async signIn(provider: SocialProviderName, providerUid: string) {
    const user = await this.users.findOneAndUpdate(
      { socialAccounts: { $elemMatch: { provider, providerUid } }, deletedAt: null },
      { lastLoginAt: new Date() },
      { projection: { _id: 1 } },
    );
    return user?._id ?? null;
  }

  private async emailTaken(email: string): Promise<boolean> {
    return (await this.users.exists({ email, deletedAt: null })) !== null;
  }
}
