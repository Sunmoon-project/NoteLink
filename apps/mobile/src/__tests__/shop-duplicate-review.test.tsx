import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import type { UserItem } from '@notelink/shared';
import { ShopScreen, BoxScreen } from '../features/reward/shop';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

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
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30000 } } });
  clients.push(qc);
  return qc;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it('느린 구매 중 같은 상품을 다시 열어도 첫 성공 뒤 남은 확인창이 이중 구매하지 않는다', async () => {
  setParams({});
  const item = (await api.shop.items({})).find((entry) => entry.price > 0)!;
  const me = await api.me.get();
  jest.spyOn(api.me, 'get').mockResolvedValue({ ...me, pointBalance: 100000 });
  let purchased = false;
  const owned: UserItem = {
    _id: 'owned-after-purchase',
    itemId: item._id,
    itemCategory: item.category,
    isOwned: true,
    isWished: false,
    isEquipped: false,
    acquiredAt: null,
  };
  const myItems = jest
    .spyOn(api.shop, 'myItems')
    .mockImplementation(async () => (purchased ? [owned] : []));
  const pending = deferred<{ balance: number }>();
  const buy = jest.spyOn(api.shop, 'purchase').mockImplementation(() => pending.promise);
  await renderScreen(<ShopScreen />, client());
  await fireEvent.press((await screen.findAllByText(item.name))[0]!);
  await fireEvent.press(screen.getByText('구매'));
  await fireEvent.press(screen.getByText('구매'));
  await waitFor(() => expect(buy).toHaveBeenCalledTimes(1));

  // 첫 응답 대기 중 그리드에서 동일 상품을 다시 열고 확인창을 다시 열어 본다.
  await fireEvent.press(screen.getAllByText(item.name)[0]!);
  const reopenBuy = screen.queryByText('구매');
  if (reopenBuy) await fireEvent.press(reopenBuy);
  purchased = true;
  await act(async () => pending.resolve({ balance: 100000 - item.price }));
  await screen.findByText(`🎉 구매 완료 · ${item.name}`);
  await waitFor(() => expect(myItems.mock.calls.length).toBeGreaterThan(1));
  await waitFor(() => expect(screen.getAllByText('보유중').length).toBeGreaterThan(0));

  // 진행 중 진입 자체를 차단한 구현도 허용한다. 남은 확인창이 있으면 실제로 눌러 본다.
  if (screen.queryByText(`${item.name}를 구매할까요?`)) {
    const staleBuy = screen.queryByRole('button', { name: '구매' });
    if (staleBuy) await fireEvent.press(staleBuy);
  }
  await act(async () => {});
  expect(buy).toHaveBeenCalledTimes(1);
});

it('테마가 먼저 장착 목록에 있어도 현재 아바타는 아바타 카테고리로 표시한다', async () => {
  setParams({});
  const all = await api.shop.items({});
  const avatar = {
    ...all.find((entry) => entry.category === 'avatar')!,
    _id: 'selected-avatar',
    name: '선택한 아바타',
    thumbnailUrl: 'https://example.test/avatar.png',
  };
  const theme = {
    ...all.find((entry) => entry.category === 'theme')!,
    _id: 'selected-theme',
    name: '선택한 테마',
    thumbnailUrl: 'https://example.test/theme.png',
  };
  jest.spyOn(api.shop, 'items').mockResolvedValue([theme, avatar]);
  jest.spyOn(api.shop, 'myItems').mockResolvedValue(
    [theme, avatar].map((entry) => ({
      _id: `owned-${entry._id}`,
      itemId: entry._id,
      itemCategory: entry.category,
      isOwned: true,
      isWished: false,
      isEquipped: true,
      acquiredAt: null,
    })),
  );
  await renderScreen(<BoxScreen />, client());
  await screen.findByText(avatar.name);
  await waitFor(() => {
    const previews = screen.getAllByLabelText(`${avatar.name} 미리보기`);
    expect(previews).toHaveLength(2);
    expect(previews[0]!.props.source.uri).toBe(avatar.thumbnailUrl);
  });
});
