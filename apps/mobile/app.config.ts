import type { ExpoConfig } from 'expo/config';
import { type ConfigPlugin, withEntitlementsPlist } from 'expo/config-plugins';

/**
 * 아이폰 무료 Apple ID로 기기에 직접 설치할 때(`npm run ios:device`). 무료(개인) 팀은 푸시 알림 권한을 줄 수 없어
 * expo-notifications 플러그인을 빼고, 번들 ID가 이미 쓰이고 있으면 NOTELINK_IOS_BUNDLE_ID로 바꿀 수 있다.
 */
const FREE_IOS = process.env.NOTELINK_FREE_IOS === '1';
/**
 * 무료(개인) 팀은 푸시 권한을 서명할 수 없다. expo-notifications는 설치만 돼 있어도 자동으로 권한을 넣으므로
 * 플러그인 목록에서 빼는 것만으로는 부족해, 마지막에 권한을 지운다
 */
const withoutPushEntitlement: ConfigPlugin = (config) =>
  withEntitlementsPlist(config, (c) => {
    delete c.modResults['aps-environment'];
    return c;
  });
/** EAS 프로젝트 ID(`eas init`이 알려 준 값). 비어 있으면 EAS 빌드 전에 채운다 */
const EAS_PROJECT_ID: string | undefined = undefined;

const config: ExpoConfig = {
  name: 'NoteLink',
  slug: 'notelink',
  scheme: 'notelink',
  version: '0.1.0',
  // 기본은 코드에서 세로로 고정하고, 순공시간 자동 측정 화면만 가로로 돌린다 (p.49)
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  icon: './assets/icon.png',
  ios: {
    bundleIdentifier: (FREE_IOS && process.env.NOTELINK_IOS_BUNDLE_ID) || 'app.notelink.mobile',
    supportsTablet: false,
    requireFullScreen: true,
  },
  android: {
    package: 'app.notelink.mobile',
    adaptiveIcon: {
      backgroundColor: '#3B6E5B',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    '@livekit/react-native-expo-plugin',
    '@config-plugins/react-native-webrtc',
    'expo-status-bar',
    [
      'expo-font',
      {
        // 앱 글꼴: Pretendard (SIL OFL 1.1, assets/fonts/LICENSE-Pretendard.txt). 굵기는 fontWeight로 고른다
        ios: {
          fonts: (['Regular', 'Medium', 'SemiBold', 'Bold'] as const).map(
            (w) => `./assets/fonts/Pretendard-${w}.otf`,
          ),
        },
        android: {
          fonts: [
            {
              fontFamily: 'Pretendard',
              fontDefinitions: [
                { path: './assets/fonts/Pretendard-Regular.otf', weight: 400 },
                { path: './assets/fonts/Pretendard-Medium.otf', weight: 500 },
                { path: './assets/fonts/Pretendard-SemiBold.otf', weight: 600 },
                { path: './assets/fonts/Pretendard-Bold.otf', weight: 700 },
              ],
            },
          ],
        },
      },
    ],
    'expo-secure-store',
    'expo-sharing',
    [
      'expo-splash-screen',
      { image: './assets/splash-icon.png', imageWidth: 120, backgroundColor: '#2F5A4A' },
    ],
    ['expo-screen-orientation', { initialOrientation: 'DEFAULT' }],
    [
      'expo-camera',
      {
        cameraPermission: '필기와 문서를 촬영하고 스터디룸에서 캠을 켜기 위해 카메라를 사용해요.',
        microphonePermission: '스터디룸 음성을 위해 마이크를 사용해요.',
        barcodeScannerEnabled: false,
      },
    ],
    [
      'expo-image-picker',
      { photosPermission: '갤러리의 필기 사진을 올리기 위해 사진 접근이 필요해요.' },
    ],
    [
      'expo-audio',
      {
        microphonePermission: '강의를 녹음하기 위해 마이크를 사용해요.',
        enableBackgroundRecording: true,
      },
    ],
    [
      'expo-calendar',
      { calendarPermission: '스터디 일정을 기기 캘린더에 추가하기 위해 필요해요.' },
    ],
    // 무료 Apple ID 설치에서는 푸시 권한(aps-environment)을 서명할 수 없어 지운다
    ...(FREE_IOS ? [] : [['expo-notifications', { color: '#3B6E5B' }] as [string, object]]),
  ],
  experiments: { typedRoutes: true },
  ...(EAS_PROJECT_ID ? { extra: { eas: { projectId: EAS_PROJECT_ID } } } : {}),
};

export default FREE_IOS ? withoutPushEntitlement(config) : config;
