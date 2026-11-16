import { createConfig, dropPushEntitlement } from '../../app.config';

/** config 플러그인이 건 iOS 권한 수정(mod). ExpoConfig 타입에는 mods가 없다 */
const entitlementsMod = (config: object) =>
  (config as { mods?: { ios?: { entitlements?: unknown } } }).mods?.ios?.entitlements;

const pluginNames = (env: Record<string, string>) =>
  (createConfig(env).plugins ?? []).map((p) => (Array.isArray(p) ? p[0] : p));

describe('앱 설정(app.config.ts)', () => {
  it('기본은 푸시 알림 플러그인과 기본 번들 ID를 쓰고, 권한을 지우지 않는다', () => {
    const config = createConfig({ NOTELINK_IOS_BUNDLE_ID: 'com.me.notelink' });
    expect(pluginNames({})).toContain('expo-notifications');
    expect(config.ios?.bundleIdentifier).toBe('app.notelink.mobile');
    expect(entitlementsMod(config)).toBeUndefined();
  });

  it('무료 아이폰 설치는 푸시를 빼고, 번들 ID를 바꿀 수 있고, 권한 지우기를 건다', () => {
    const env = { NOTELINK_FREE_IOS: '1', NOTELINK_IOS_BUNDLE_ID: 'com.me.notelink' };
    const config = createConfig(env);
    expect(pluginNames(env)).not.toContain('expo-notifications');
    expect(config.ios?.bundleIdentifier).toBe('com.me.notelink');
    expect(entitlementsMod(config)).toEqual(expect.any(Function));
    expect(createConfig({ NOTELINK_FREE_IOS: '1' }).ios?.bundleIdentifier).toBe(
      'app.notelink.mobile',
    );
  });

  it('권한 목록에서 푸시(aps-environment)만 지운다', () => {
    expect(
      dropPushEntitlement({ 'aps-environment': 'development', 'com.apple.security': true }),
    ).toEqual({ 'com.apple.security': true });
  });
});
