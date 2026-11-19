/* global jest */
// 화면 테스트는 서버 없이 돈다. 서버 모드는 server-mode.test.ts가 따로 본다
process.env.EXPO_PUBLIC_USE_LOCAL_DATA = 'true';
// 화면 테스트용: 애니메이션 · 워클릿 네이티브 모듈 대신 목을 쓴다
// 공식 mock에서 빠지는 것: useReducedMotion은 '동작 줄이기 꺼짐', LayoutAnimationConfig는 자식만 그림,
// useFrameCallback은 프레임을 돌리지 않음(녹음 재생 시계는 멈춘 위치 그대로)
jest.mock('react-native-reanimated', () => ({
  ...require('react-native-reanimated/mock'),
  useReducedMotion: () => false,
  LayoutAnimationConfig: ({ children }) => children,
  useFrameCallback: () => ({ setActive: () => {}, isActive: false, callbackId: -1 }),
}));
// 화면 테스트는 기기 저장소 대신 시드가 든 가짜 API를 쓴다 (앱 번들에는 들어가지 않는다)
jest.mock('./src/lib/local/api', () => ({
  localApi: require('./src/__tests__/fixtures/api').mockApi,
}));
jest.mock('./src/lib/local/storage', () => ({
  keepFile: (uri) => ({ uri, size: 0 }),
  readDb: () => null,
  writeDb: () => {},
}));
// lucide 아이콘은 ESM이라 jest가 변환하지 않는다 — 이름만 맞는 빈 컴포넌트로 바꾼다
jest.mock('lucide-react-native', () => new Proxy({}, { get: () => () => null }));
// 화면 테스트는 라우터 없이 그린다. 파라미터가 필요한 테스트는 mockParams를 바꾼다
global.mockParams = {};
// 닫히는 Modal을 기다리지 않는다. 기다림은 modal-navigation-sim-review 테스트에서만 켠다
global.MODAL_CLOSE_MS = 0;
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: jest.fn(() => true),
    dismissAll: jest.fn(),
    dismissTo: jest.fn(),
  },
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useSegments: () => [],
  useSitemap: jest.fn(() => null),
  useLocalSearchParams: () => global.mockParams,
  useFocusEffect: () => {},
  useIsFocused: () => global.mockFocused ?? true,
  Redirect: () => null,
  Link: ({ children }) => children,
}));

// 아바타 선생님 3D(expo-gl · three · GLB)는 기기에서만 그린다. 화면 테스트는 자리만 둔다
jest.mock('./src/features/tutor/avatar3d', () => ({ Avatar3D: () => null }));

// expo-audio는 네이티브 모듈이라 시험 환경에 없다. 퀴즈 「음성으로 듣기」가 무음 모드 설정에 쓰므로 기본 대역을 둔다
// (녹음 · 재생 시험은 파일마다 더 자세한 대역으로 덮어쓴다)
jest.mock('expo-audio', () => ({ setAudioModeAsync: jest.fn(async () => {}) }));

// 밀어서 여는 줄(ReanimatedSwipeable)은 네이티브 제스처라 시험 환경에서 돌지 않는다.
// 숨은 동작 버튼을 함께 그려, 화면 테스트가 「밀면 나오는 버튼」을 눌러 볼 수 있게 한다
jest.mock('react-native-gesture-handler/ReanimatedSwipeable', () => {
  const React = require('react');
  const Swipeable = React.forwardRef(({ children, renderRightActions }, ref) => {
    React.useImperativeHandle(ref, () => ({
      close: () => {},
      openLeft: () => {},
      openRight: () => {},
      reset: () => {},
    }));
    // createElement를 그대로 쓰면 nativewind 변환이 바깥 변수로 바꿔 jest.mock이 거부한다
    const h = React['create' + 'Element'];
    return h(React.Fragment, null, children, renderRightActions?.());
  });
  Swipeable.displayName = 'ReanimatedSwipeable';
  return { __esModule: true, default: Swipeable };
});
