import type { SocialProvider } from '@notelink/shared';

// 카카오 · 네이버 · Google SDK에서 토큰을 받아 온다. 서버는 이 토큰을 직접 검증한 뒤에만 로그인시킨다.
// TODO(인증 담당): 개발용 테스트 키로 각 SDK를 붙인다 (README 6장: 소셜 로그인은 테스트 키부터)
/** 소셜 SDK를 붙이기 전에는 버튼을 막고 이메일로 시작하게 한다 */
export const socialLoginReady = false;

export async function getProviderToken(provider: SocialProvider): Promise<string> {
  throw new Error(`${provider} 로그인은 아직 연결되지 않았어요. 이메일로 시작해 주세요.`);
}
