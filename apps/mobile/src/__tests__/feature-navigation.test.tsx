import { act, renderHook } from '@testing-library/react-native';
import { router, useSitemap, type SitemapType } from 'expo-router';
import { featureRouteExists, useFeatureNavigation } from '../lib/feature-navigation';
import { useToast } from '../stores/toast';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), navigate: jest.fn() },
  useSitemap: jest.fn(() => null),
}));

function node(href: string, children: SitemapType[] = [], isInternal = false): SitemapType {
  return {
    contextKey: `${href}.tsx`,
    filename: `${href}.tsx`,
    href,
    isInitial: false,
    isInternal,
    isGenerated: false,
    children,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(useSitemap).mockReturnValue(null);
  useToast.setState({ msg: null });
});

it('없는 sitemap과 등록되지 않은 경로는 일치하지 않는다', () => {
  expect(featureRouteExists(null, '/shop')).toBe(false);
  expect(featureRouteExists(node('/', [node('/record')]), '/shop')).toBe(false);
  expect(featureRouteExists(node('/shop/item'), '/shop')).toBe(false);
});

it('중첩된 실제 화면을 찾으며 라우트 그룹과 끝 슬래시를 무시한다', () => {
  const sitemap = node('/', [node('/(tabs)', [node('/(tabs)/profile/photo/')])]);
  expect(featureRouteExists(sitemap, '/profile/photo')).toBe(true);
  expect(featureRouteExists(sitemap, '/(tabs)/profile/photo/')).toBe(true);
  expect(featureRouteExists(node('/(tabs)/'), '/')).toBe(true);
});

it('내부 노드 자체는 화면으로 취급하지 않고 실제 자식 화면은 탐색한다', () => {
  const sitemap = node('/shop', [node('/record')], true);
  expect(featureRouteExists(sitemap, '/shop')).toBe(false);
  expect(featureRouteExists(sitemap, '/record')).toBe(true);
});

it('등록된 화면은 기본 push로 열고 true를 반환한다', async () => {
  jest.mocked(useSitemap).mockReturnValue(node('/', [node('/record')]));
  const { result } = await renderHook(() => useFeatureNavigation());
  let opened: boolean | undefined;
  await act(async () => {
    opened = result.current('/record');
  });
  expect(opened).toBe(true);
  expect(router.push).toHaveBeenCalledWith('/record');
  expect(useToast.getState().msg).toBeNull();
});

it('미등록 화면은 이동하지 않고 준비 중 안내와 false를 반환한다', async () => {
  const { result } = await renderHook(() => useFeatureNavigation());
  let opened: boolean | undefined;
  await act(async () => {
    opened = result.current('/shop');
  });
  expect(opened).toBe(false);
  expect(router.push).not.toHaveBeenCalled();
  expect(router.replace).not.toHaveBeenCalled();
  expect(router.navigate).not.toHaveBeenCalled();
  expect(useToast.getState().msg).toBe('이 기능은 준비 중이에요');
});

it.each(['replace', 'navigate'] as const)(
  '%s 이동은 href 객체와 파라미터를 그대로 전달한다',
  async (method) => {
    jest.mocked(useSitemap).mockReturnValue(node('/', [node('/(tabs)/profile/photo')]));
    const href = {
      pathname: '/(tabs)/profile/photo',
      params: { source: 'settings', id: 'user-1' },
    } as const;
    const { result } = await renderHook(() => useFeatureNavigation());
    let opened: boolean | undefined;
    await act(async () => {
      opened = result.current(href, method);
    });
    expect(opened).toBe(true);
    expect(router[method]).toHaveBeenCalledWith(href);
    expect(router.push).not.toHaveBeenCalled();
  },
);

it('자리 표시 탭이 있어도 실제 기능 화면이 없으면 진입을 막는다', async () => {
  jest.mocked(useSitemap).mockReturnValue(node('/', [node('/(tabs)/note')]));
  const { result } = await renderHook(() => useFeatureNavigation());
  let opened: boolean | undefined;
  await act(async () => {
    opened = result.current('/(tabs)/note', 'navigate', '/capture/picked');
  });
  expect(opened).toBe(false);
  expect(router.navigate).not.toHaveBeenCalled();
  expect(useToast.getState().msg).toBe('이 기능은 준비 중이에요');
});

it('연결 기능까지 등록되면 자리 표시 탭 대신 실제 기능으로 이동한다', async () => {
  jest
    .mocked(useSitemap)
    .mockReturnValue(node('/', [node('/(tabs)/note'), node('/capture/picked')]));
  const { result } = await renderHook(() => useFeatureNavigation());
  let opened: boolean | undefined;
  await act(async () => {
    opened = result.current('/(tabs)/note', 'navigate', '/capture/picked');
  });
  expect(opened).toBe(true);
  expect(router.navigate).toHaveBeenCalledWith('/(tabs)/note');
});
