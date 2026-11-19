import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Canvas } from '../components/ui';
import { Text } from '../components/text';
import { ShopScreen } from '../features/reward/shop';
import { api } from '../lib/api';
import { THEMES, themeOf, useScreenBackground } from '../lib/shop-themes';
import { useAuth } from '../stores/auth';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  selectionAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
jest.mock('../features/tutor/avatar3d', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { Avatar3D: ({ avatarId }: { avatarId: string }) => <T>{`3D:${avatarId}`}</T> };
});

const SEA_SEED_ID = '6e6f74656c696e6b73680006';
const seaMine = (isEquipped: boolean) => [
  {
    _id: 'u1',
    userId: 'me',
    itemId: 'sea',
    itemCategory: 'theme' as const,
    isOwned: true,
    isEquipped,
    isWished: false,
    purchasedAt: null,
  },
];
const color = (el: { props: { style?: unknown } }) =>
  StyleSheet.flatten(el.props.style as StyleProp<ViewStyle>)?.backgroundColor;
const bg = (label: string) =>
  color(label === '앱 바탕' ? screen.getByTestId('canvas') : screen.getByLabelText(label));

beforeEach(() => useAuth.setState({ userId: 'me' }));
afterEach(() => jest.restoreAllMocks());

describe('테마 → 바탕색', () => {
  it('앱 id와 서버 고정 시드 id 모두 바다 테마로 찾고, 모르는 id는 null', () => {
    expect(themeOf('sea')?.canvas).toBe(THEMES.sea!.canvas);
    expect(themeOf(SEA_SEED_ID)?.canvas).toBe(THEMES.sea!.canvas);
    expect(themeOf('base')).toBeNull();
    expect(themeOf(undefined)).toBeNull();
  });
});

describe('Canvas', () => {
  const ui = (cream?: boolean) => (
    <Canvas cream={cream}>
      <Text>본문</Text>
    </Canvas>
  );

  it('바다 테마를 장착하면 바탕을 그 색으로 칠한다', async () => {
    jest.spyOn(api.shop, 'myItems').mockResolvedValue(seaMine(true) as never);
    await renderScreen(ui());
    await waitFor(() => expect(bg('앱 바탕')).toBe(THEMES.sea!.canvas));
  });

  it('보유만 하고 장착 안 했으면 기본 바탕', async () => {
    const spy = jest.spyOn(api.shop, 'myItems').mockResolvedValue(seaMine(false) as never);
    await renderScreen(ui());
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(bg('앱 바탕')).toBeUndefined();
  });

  it('보관함 조회가 실패하면 기본 바탕', async () => {
    const spy = jest.spyOn(api.shop, 'myItems').mockRejectedValue(new Error('offline'));
    await renderScreen(ui());
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(bg('앱 바탕')).toBeUndefined();
  });

  it('cream(온보딩 · 로그인)은 장착해도 크림 그대로, 보관함도 묻지 않는다', async () => {
    const spy = jest.spyOn(api.shop, 'myItems').mockResolvedValue(seaMine(true) as never);
    await renderScreen(ui(true));
    expect(bg('앱 바탕')).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('로그인 전에는 보관함을 묻지 않는다', async () => {
    useAuth.setState({ userId: null });
    const spy = jest.spyOn(api.shop, 'myItems');
    await renderScreen(ui());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('상점 상세 시트', () => {
  it('바다 테마를 열면 그 바탕색으로 칠한 미니 화면 모형을 보여 준다', async () => {
    await renderScreen(<ShopScreen />);
    await fireEvent.press((await screen.findAllByText('바다 테마'))[0]!);
    expect(await screen.findByLabelText('바다 테마 바탕 미리보기')).toBeTruthy();
    expect(bg('바다 테마 바탕 미리보기')).toBe(THEMES.sea!.canvas);
  });

  it('바다 테마 설명은 실제 동작(바탕색)과 맞다', async () => {
    const sea = (await api.shop.items({})).find((i) => i._id === 'sea')!;
    expect(sea.description).toBe('앱 바탕이 시원한 바다색으로 바뀌어요.');
  });
});

describe('화면 틀(스택 · 탭바)도 장착 테마 바탕', () => {
  const Probe = () => <Text>{useScreenBackground()}</Text>;
  it('장착하면 테마 바탕색, 아니면 흰색', async () => {
    jest.spyOn(api.shop, 'myItems').mockResolvedValue(seaMine(true) as never);
    await renderScreen(<Probe />);
    expect(await screen.findByText(THEMES.sea!.canvas)).toBeTruthy();
  });
  it('장착 안 했으면 흰색', async () => {
    jest.spyOn(api.shop, 'myItems').mockResolvedValue(seaMine(false) as never);
    await renderScreen(<Probe />);
    expect(await screen.findByText('#fff')).toBeTruthy();
  });
  it('루트 스택의 화면 바탕과 탭바가 이 값을 쓴다(흰색 고정 아님)', () => {
    const read = (f: string): string => jest.requireActual('fs').readFileSync(f, 'utf8');
    expect(read('app/_layout.tsx')).toMatch(/contentStyle: \{ backgroundColor: screenBg \}/);
    expect(read('app/(tabs)/_layout.tsx')).toMatch(/tabBarStyle: \{ backgroundColor: screenBg/);
  });
});
