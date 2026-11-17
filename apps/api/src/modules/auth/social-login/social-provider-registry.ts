import { Inject, Injectable } from '@nestjs/common';

import type { SocialProviderName } from '../schemas/social-login-attempt.schema.js';
import { SOCIAL_PROVIDER_ADAPTERS } from './social-login.constants.js';
import type { SocialProviderAdapter } from './social-provider.js';

/** 제공자 이름(`google` · `kakao` · `naver`)으로 어댑터를 찾는다. 아직 구현하지 않은 제공자는 찾지 못한다 */
@Injectable()
export class SocialProviderRegistry {
  private readonly byName: ReadonlyMap<string, SocialProviderAdapter>;

  constructor(@Inject(SOCIAL_PROVIDER_ADAPTERS) adapters: SocialProviderAdapter[]) {
    const byName = new Map<string, SocialProviderAdapter>();
    for (const adapter of adapters) {
      if (byName.has(adapter.name)) {
        // 같은 제공자를 두 번 등록하면 어느 쪽이 쓰일지 알 수 없다. 시작할 때 바로 드러낸다
        throw new Error(`소셜 로그인 제공자가 중복 등록됐습니다: ${adapter.name}`);
      }
      byName.set(adapter.name, adapter);
    }
    this.byName = byName;
  }

  /** 이름은 요청 주소에서 온 문자열이라 정확히 같은 이름만 찾는다(대소문자 구분). 없으면 undefined */
  find(name: string): SocialProviderAdapter | undefined {
    return this.byName.get(name);
  }

  /** 등록된 제공자 이름 목록(테스트 · 로그용) */
  names(): SocialProviderName[] {
    return [...this.byName.values()].map((a) => a.name);
  }
}
