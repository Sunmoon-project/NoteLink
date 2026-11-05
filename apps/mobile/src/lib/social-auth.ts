import { PATHS, type SocialProvider } from '@notelink/shared';
import { env } from './env';
import { loadBrowser, loadCrypto } from './web-browser-loader';

// 카카오 · 네이버 · Google 키와 시크릿은 서버에만 둔다(README 5장). 앱은 서버의 시작 주소를 시스템 브라우저로 열고,
// 서버가 제공자 인증을 마친 뒤 notelink://auth/callback?code=…&state=… 로 돌려준 1회용 코드를 POST /auth/social/:provider로 보낸다.
// 사용자 지정 주소는 다른 앱이 가로챌 수 있어 state와 PKCE로 이번 시도에 묶는다.
const REDIRECT = 'notelink://auth/callback';

/** 간편 로그인은 서버가 있어야 동작한다 */
export const socialLoginReady = !env.useMock;

const FAILED = '간편 로그인을 마치지 못했어요. 다시 시도해 주세요';
const base64url = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export async function getProviderToken(
  provider: SocialProvider,
): Promise<{ token: string; codeVerifier: string }> {
  const { openAuthSessionAsync } = await loadBrowser();
  const crypto = await loadCrypto();
  const state = hex(crypto.getRandomBytes(16));
  const codeVerifier = hex(crypto.getRandomBytes(32));
  const challenge = base64url(
    await crypto.digestStringAsync(crypto.CryptoDigestAlgorithm.SHA256, codeVerifier, {
      encoding: crypto.CryptoEncoding.BASE64,
    }),
  );
  const query = [
    `redirect=${encodeURIComponent(REDIRECT)}`,
    `state=${state}`,
    `code_challenge=${challenge}`,
    'code_challenge_method=S256',
  ].join('&');
  const r = await openAuthSessionAsync(
    `${env.apiUrl}${PATHS.socialStart(provider)}?${query}`,
    REDIRECT,
  );
  if (r.type !== 'success') throw new Error('간편 로그인을 취소했어요');
  // 복귀 주소와 state가 정확히 맞을 때만 코드를 믿는다
  const [base, search = ''] = r.url.split('?');
  const params = new URLSearchParams(search.split('#')[0]);
  const token = params.get('code');
  if (base !== REDIRECT || params.get('state') !== state || !token) throw new Error(FAILED);
  return { token, codeVerifier };
}
