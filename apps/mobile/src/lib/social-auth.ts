import { PATHS, type SocialProvider } from '@notelink/shared';
import { env } from './env';
import { loadBrowser } from './web-browser-loader';

// 카카오 · 네이버 · Google 키와 시크릿은 서버에만 둔다(README 5장). 앱은 서버의 시작 주소를 시스템 브라우저로 열고,
// 서버가 제공자 인증을 마친 뒤 notelink://auth/callback?code=… 로 돌려준 1회용 코드를 POST /auth/social/:provider로 보낸다.
const REDIRECT = 'notelink://auth/callback';

/** 간편 로그인은 서버가 있어야 동작한다 */
export const socialLoginReady = !env.useMock;

/** 사용자가 브라우저를 닫은 경우. 오류 안내를 띄우지 않는다 */
export class SocialLoginCanceled extends Error {}

export async function getProviderToken(provider: SocialProvider): Promise<string> {
  const { openAuthSessionAsync } = await loadBrowser();
  const start = `${env.apiUrl}${PATHS.socialStart(provider)}?redirect=${encodeURIComponent(REDIRECT)}`;
  const r = await openAuthSessionAsync(start, REDIRECT);
  if (r.type !== 'success') throw new SocialLoginCanceled();
  const code = new URL(r.url).searchParams.get('code');
  if (!code) throw new Error('간편 로그인을 마치지 못했어요. 다시 시도해 주세요');
  return code;
}
