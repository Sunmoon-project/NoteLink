import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { ShopScreen } from '../features/reward/shop';
import { api } from '../lib/api';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
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

// PR #40 리뷰
describe('상점', () => {
  it('찜 탭도 고른 정렬을 따른다', async () => {
    const all = await api.shop.items({ sort: 'price' });
    const wished = all
      .filter((i) => i.price > 0)
      .slice(0, 2)
      .reverse();
    for (const w of wished) await api.shop.wish(w._id);
    const items = jest.spyOn(api.shop, 'items');
    await renderScreen(<ShopScreen />);
    await fireEvent.press(await screen.findByText('찜'));
    await fireEvent.press(await screen.findByText(/최신순/));
    await fireEvent.press(await screen.findByText('낮은 가격순'));
    await waitFor(() =>
      expect(items).toHaveBeenLastCalledWith({ category: undefined, sort: 'price' }),
    );
    const names = wished
      .map((w) => w.name)
      .sort((a, b) => all.findIndex((i) => i.name === a) - all.findIndex((i) => i.name === b));
    await waitFor(() => {
      const shown = screen
        .getAllByText(new RegExp(names.join('|')))
        .map((t) => String(t.props.children));
      expect(shown.filter((n) => names.includes(n))).toEqual(names);
    });
  });

  it('구매하면 포인트 내역 캐시도 갱신한다', async () => {
    const qc = new QueryClient();
    const spy = jest.spyOn(qc, 'invalidateQueries');
    const cheap = (await api.shop.items({ sort: 'price' })).find((i) => i.price > 0)!;
    jest.spyOn(api.shop, 'purchase');
    await renderScreen(<ShopScreen />, qc);
    await fireEvent.press((await screen.findAllByText(cheap.name))[0]!);
    await fireEvent.press(await screen.findByText('구매'));
    const buys = await screen.findAllByText('구매');
    await fireEvent.press(buys[buys.length - 1]!);
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['ledger'] }));
  });
});
