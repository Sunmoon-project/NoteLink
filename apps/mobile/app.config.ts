import type { ExpoConfig } from 'expo/config';

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
    bundleIdentifier: 'app.notelink.mobile',
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
    ['expo-build-properties', { ios: { enableSceneSupport: true } }],
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
    ['expo-notifications', { color: '#3B6E5B' }],
  ],
  experiments: { typedRoutes: true },
};

export default config;
