/* global jest */
// 화면 테스트용: 애니메이션 · 워클릿 네이티브 모듈 대신 목을 쓴다
jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));
// 화면 테스트는 기기 저장소 대신 시드가 든 가짜 API를 쓴다 (앱 번들에는 들어가지 않는다)
jest.mock('./src/lib/local/api', () => ({
  localApi: require('./src/__tests__/fixtures/api').mockApi,
}));
jest.mock('./src/lib/local/storage', () => ({ keepFile: (uri) => ({ uri, size: 0 }) }));
// lucide 아이콘은 ESM이라 jest가 변환하지 않는다 — 이름만 맞는 빈 컴포넌트로 바꾼다
jest.mock('lucide-react-native', () => new Proxy({}, { get: () => () => null }));
// 화면 테스트는 라우터 없이 그린다. 파라미터가 필요한 테스트는 mockParams를 바꾼다
global.mockParams = {};
// 닫히는 Modal을 기다리지 않는다. 기다림은 modal-navigation-sim-review 테스트에서만 켠다
global.MODAL_CLOSE_MS = 0;
jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), dismissAll: jest.fn() },
  useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn() }),
  useSegments: () => [],
  useSitemap: jest.fn(() => null),
  useLocalSearchParams: () => global.mockParams,
  useFocusEffect: () => {},
  Redirect: () => null,
  Link: ({ children }) => children,
}));
