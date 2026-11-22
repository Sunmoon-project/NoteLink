import { fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import { timeAgo } from '../lib/dates';
import { profileLine, SettingsScreen } from '../features/profile/settings';
import { PointsScreen, ShopScreen } from '../features/reward/shop';
import { api } from '../lib/api';
import { renderScreen } from '../test-utils';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UNREAD_REFETCH_MS, useUnreadCount } from '../features/notifications';

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
  return { Avatar3D: () => <T>3D</T> };
});

// TestQA 3차(iOS) 진짜 오류
describe('TestQA 3차 버그 묶음', () => {
  it('PROF-007: 1시간 안은 분 단위로 보인다', () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    expect(timeAgo(ago(20_000))).toBe('방금');
    expect(timeAgo(ago(5 * 60_000))).toBe('5분 전');
    expect(timeAgo(ago(59 * 60_000))).toBe('59분 전');
    expect(timeAgo(ago(2 * 3600_000))).toBe('2시간 전');
    expect(timeAgo(ago(3 * 86400_000))).toBe('3일 전');
  });

  it('PROF-007: 종 숫자는 보고 있는 동안 주기적으로 다시 읽는다(푸시가 없어도)', async () => {
    jest.useFakeTimers();
    const count = jest.spyOn(api.notifications, 'unreadCount').mockResolvedValue(0);
    const qc = new QueryClient();
    const { unmount } = await renderHook(() => useUnreadCount(), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(count).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(UNREAD_REFETCH_MS);
    expect(count).toHaveBeenCalledTimes(2);
    await unmount();
    count.mockRestore();
    jest.useRealTimers();
  });

  it('PROF-004: 학교 · 학년이 비면 이메일만, 있으면 앞에 붙인다', () => {
    expect(profileLine({ email: 'a@b.c' })).toBe('a@b.c');
    expect(profileLine({ school: '', grade: '', email: 'a@b.c' })).toBe('a@b.c');
    expect(profileLine({ school: '선문고등학교', grade: '2학년', email: 'a@b.c' })).toBe(
      '선문고 · 2학년 · a@b.c',
    );
    expect(profileLine({ grade: '2학년', email: 'a@b.c' })).toBe('2학년 · a@b.c');
  });

  it('PROF-001: 서버가 쓰는 양(usage)을 안 주면 0으로 꾸미지 않고 구획을 숨긴다', async () => {
    const me = await api.me.get();
    const get = jest.spyOn(api.me, 'get').mockResolvedValue({ ...me, usage: undefined });
    const view = await renderScreen(<SettingsScreen />);
    await screen.findByText(me.nickname);
    expect(screen.queryByText('저장 공간')).toBeNull();
    expect(screen.queryByText('AI 크레딧')).toBeNull();
    await view.unmount();
    get.mockResolvedValue(me);
    await renderScreen(<SettingsScreen />);
    expect(await screen.findByText('저장 공간')).toBeTruthy();
    get.mockRestore();
  });

  it('SHOP-004: 찜을 빠르게 두 번 눌러도 요청은 한 번', async () => {
    const item = (await api.shop.items({})).find((i) => i.price > 0)!;
    let release!: () => void;
    const wish = jest
      .spyOn(api.shop, 'wish')
      .mockImplementation(() => new Promise<boolean>((r) => (release = () => r(true))));
    await renderScreen(<ShopScreen />);
    await screen.findAllByText(item.name);
    const heart = screen.getAllByLabelText('찜')[0]!;
    await fireEvent.press(heart);
    await fireEvent.press(heart);
    expect(wish).toHaveBeenCalledTimes(1);
    release();
    wish.mockRestore();
  });

  it('SHOP-008: 내역이 없으면 빈 상태 안내를 보인다', async () => {
    jest.spyOn(api.shop, 'ledger').mockResolvedValue([]);
    await renderScreen(<PointsScreen />);
    await fireEvent.press(await screen.findByText('사용'));
    await waitFor(() => expect(screen.getByText('아직 사용한 포인트가 없어요')).toBeTruthy());
  });
});
