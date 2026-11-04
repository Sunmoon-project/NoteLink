import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { ShopScreen, PointsScreen, BoxScreen } from '../features/reward/shop';
import { api, NetworkError } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

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

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
it('포인트 필터는 적립과 사용을 실제 조회하고 가짜 더보기는 없다', async () => {
  const ledger = jest.spyOn(api.shop, 'ledger');
  await renderScreen(<PointsScreen />, client());
  await fireEvent.press(await screen.findByText('적립'));
  await waitFor(() => expect(ledger).toHaveBeenCalledWith('earn'));
  await fireEvent.press(await screen.findByText('사용'));
  await waitFor(() => expect(ledger).toHaveBeenCalledWith('spend'));
  expect(screen.queryByText('이전 내역 더 보기')).toBeNull();
});
it('구매 응답 유실은 재구매하지 않고 소유 상태와 잔액, 내역을 다시 확인한다', async () => {
  const qc = client();
  const me = await api.me.get();
  jest.spyOn(api.me, 'get').mockResolvedValue({ ...me, pointBalance: 100000 });
  const items = await api.shop.items({ sort: 'price' });
  const cheap = items.find((i) => i.price > 0)!;
  const buy = jest.spyOn(api.shop, 'purchase').mockRejectedValue(new NetworkError('lost response'));
  const myItems = jest.spyOn(api.shop, 'myItems');
  const ledger = jest.spyOn(api.shop, 'ledger');
  await renderScreen(<ShopScreen />, qc);
  await fireEvent.press((await screen.findAllByText(cheap.name))[0]!);
  await fireEvent.press(await screen.findByText('구매'));
  await screen.findByText(/구매할까요/);
  await fireEvent.press(screen.getAllByText('구매').at(-1)!);
  expect(await screen.findByText('구매 결과를 확인해주세요')).toBeTruthy();
  expect(screen.queryByText(/포인트는 차감되지 않았어요/)).toBeNull();
  const before = myItems.mock.calls.length;
  await fireEvent.press(await screen.findByText('구매 결과 확인'));
  await waitFor(() => expect(myItems.mock.calls.length).toBeGreaterThan(before));
  expect(ledger).toHaveBeenCalled();
  expect(buy).toHaveBeenCalledTimes(1);
});
it('보유하지 않은 장착 파라미터는 장착 화면을 열지 않는다', async () => {
  const all = await api.shop.items({});
  jest.spyOn(api.shop, 'myItems').mockResolvedValue([]);
  setParams({ equip: all.find((i) => i.price > 0)!._id });
  await renderScreen(<BoxScreen />, client());
  await screen.findByText('아직 보유한 아이템이 없어요');
  expect(screen.queryByText('장착하기')).toBeNull();
});
it('보유한 아이템 장착은 API와 보관함 갱신을 수행한다', async () => {
  const all = await api.shop.items({});
  const it = all.find((i) => i.price > 0)!;
  jest
    .spyOn(api.shop, 'myItems')
    .mockResolvedValue([
      { itemId: it._id, isOwned: true, isWished: false, isEquipped: false },
    ] as never);
  const equip = jest.spyOn(api.shop, 'equip').mockResolvedValue(undefined);
  const qc = client();
  const invalid = jest.spyOn(qc, 'invalidateQueries');
  setParams({ equip: it._id });
  await renderScreen(<BoxScreen />, qc);
  await fireEvent.press(await screen.findByText('장착하기'));
  await waitFor(() => expect(equip).toHaveBeenCalledWith(it._id));
  expect(invalid).toHaveBeenCalledWith({ queryKey: ['my-items'] });
});

it('구매 미완료 확인 후 같은 상품을 다시 선택할 수 있다', async () => {
  const qc = client();
  const me = await api.me.get();
  jest.spyOn(api.me, 'get').mockResolvedValue({ ...me, pointBalance: 100000 });
  jest.spyOn(api.shop, 'myItems').mockResolvedValue([]);
  const item = (await api.shop.items({})).find((i) => i.price > 0)!;
  const buy = jest
    .spyOn(api.shop, 'purchase')
    .mockRejectedValueOnce(new NetworkError('not sent'))
    .mockResolvedValue({ balance: 100 });
  await renderScreen(<ShopScreen />, qc);
  await fireEvent.press((await screen.findAllByText(item.name))[0]!);
  await fireEvent.press(await screen.findByText('구매'));
  await screen.findByText(/구매할까요/);
  await fireEvent.press(screen.getAllByText('구매').at(-1)!);
  await fireEvent.press(await screen.findByText('구매 결과 확인'));
  await screen.findByText(/현재 보유 내역에 없어요/);
  await fireEvent.press(await screen.findByLabelText('닫기'));
  await fireEvent.press(screen.getAllByText(item.name)[0]!);
  await fireEvent.press(await screen.findByText('구매'));
  await screen.findByText(/구매할까요/);
  await fireEvent.press(screen.getAllByText('구매').at(-1)!);
  await waitFor(() => expect(buy).toHaveBeenCalledTimes(2));
});
it('구매 완료 후 응답만 유실되면 재구매 없이 소유를 확인한다', async () => {
  const qc = client();
  const me = await api.me.get();
  const item = (await api.shop.items({})).find((i) => i.price > 0)!;
  jest.spyOn(api.me, 'get').mockResolvedValue({ ...me, pointBalance: 100000 });
  let owned = false;
  jest.spyOn(api.shop, 'myItems').mockImplementation(async () =>
    owned
      ? [
          {
            _id: 'owned-item',
            itemCategory: item.category,
            acquiredAt: null,
            itemId: item._id,
            isOwned: true,
            isWished: false,
            isEquipped: false,
          },
        ]
      : [],
  );
  const buy = jest.spyOn(api.shop, 'purchase').mockImplementation(async () => {
    owned = true;
    throw new NetworkError('response lost');
  });
  await renderScreen(<ShopScreen />, qc);
  await fireEvent.press((await screen.findAllByText(item.name))[0]!);
  await fireEvent.press(await screen.findByText('구매'));
  await screen.findByText(/구매할까요/);
  await fireEvent.press(screen.getAllByText('구매').at(-1)!);
  await fireEvent.press(await screen.findByText('구매 결과 확인'));
  expect(await screen.findByText('구매 완료를 확인했어요')).toBeTruthy();
  expect(buy).toHaveBeenCalledTimes(1);
});
it('캐시된 소유 목록이 갱신되면 장착 진입 파라미터를 다시 처리한다', async () => {
  const qc = client();
  const item = (await api.shop.items({})).find((i) => i.price > 0)!;
  jest.spyOn(api.shop, 'myItems').mockResolvedValue([]);
  setParams({ equip: item._id });
  await renderScreen(<BoxScreen />, qc);
  await screen.findByText('아직 보유한 아이템이 없어요');
  await act(async () =>
    qc.setQueryData(
      ['my-items'],
      [
        {
          _id: 'owned-item',
          itemCategory: item.category,
          acquiredAt: null,
          itemId: item._id,
          isOwned: true,
          isWished: false,
          isEquipped: false,
        },
      ],
    ),
  );
  expect(await screen.findByText('장착하기')).toBeTruthy();
});

it('상품 URL은 이미지로 표시하고 null은 대체 미리보기를 표시한다', async () => {
  const item = (await api.shop.items({}))[0]!;
  jest.spyOn(api.shop, 'items').mockResolvedValue([
    { ...item, thumbnailUrl: 'https://example.test/item.png' },
    { ...item, _id: 'no-image', name: '이미지 없음', thumbnailUrl: null },
  ]);
  await renderScreen(<ShopScreen />, client());
  await screen.findByText(item.name);
  expect(screen.getByLabelText(`${item.name} 미리보기`).props.source.uri).toBe(
    'https://example.test/item.png',
  );
  expect(screen.queryByText('https://example.test/item.png')).toBeNull();
  expect(screen.getByLabelText('이미지 없음 미리보기')).toBeTruthy();
});
