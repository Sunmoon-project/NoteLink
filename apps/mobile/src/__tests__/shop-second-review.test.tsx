import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import type { UserItem } from '@notelink/shared';
import { ShopScreen, PointsScreen, BoxScreen } from '../features/reward/shop';
import { api, NetworkError } from '../lib/api';
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
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30000, gcTime: Infinity } },
  });
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
beforeEach(() => {
  setParams({});
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it('A 구매 응답이 미확정이면 B 구매도 A 결과 확인 전에는 실행하지 않는다', async () => {
  const [a, b] = (await api.shop.items({})).filter((item) => item.price > 0).slice(0, 2);
  expect(a).toBeDefined();
  expect(b).toBeDefined();
  const me = await api.me.get();
  jest.spyOn(api.me, 'get').mockResolvedValue({ ...me, pointBalance: 100000 });
  jest.spyOn(api.shop, 'myItems').mockResolvedValue([]);
  const buy = jest
    .spyOn(api.shop, 'purchase')
    .mockRejectedValueOnce(new NetworkError('A response lost'))
    .mockResolvedValue({ balance: 90000 });
  await renderScreen(<ShopScreen />, client());
  await fireEvent.press((await screen.findAllByText(a!.name))[0]!);
  await fireEvent.press(screen.getByText('구매'));
  await fireEvent.press(screen.getByText('구매'));
  await screen.findByText('구매 결과를 확인해주세요');
  await fireEvent.press(screen.getByText('닫기'));

  await fireEvent.press(screen.getAllByText(b!.name)[0]!);
  await fireEvent.press(screen.getByText('구매'));
  if (screen.queryByText(`${b!.name}를 구매할까요?`)) {
    await fireEvent.press(screen.getByRole('button', { name: '구매' }));
  }
  await act(async () => {});
  expect(buy).toHaveBeenCalledTimes(1);
  expect(buy).toHaveBeenCalledWith(a!._id);

  await fireEvent.press(await screen.findByText('구매 결과 확인'));
  await screen.findByText(/현재 보유 내역에 없어요/);
  await fireEvent.press(screen.getAllByText(b!.name)[0]!);
  await fireEvent.press(screen.getByText('구매'));
  await fireEvent.press(screen.getByText('구매'));
  await waitFor(() => expect(buy).toHaveBeenCalledTimes(2));
  expect(buy).toHaveBeenLastCalledWith(b!._id);
});

it.each(['items', 'me', 'myItems'] as const)(
  '상점 %s 조회 실패는 오류와 재시도를 표시하고 복구한다',
  async (failed) => {
    const [first] = await api.shop.items({});
    const query =
      failed === 'me'
        ? jest.spyOn(api.me, 'get')
        : failed === 'items'
          ? jest.spyOn(api.shop, 'items')
          : jest.spyOn(api.shop, 'myItems');
    query.mockRejectedValueOnce(new Error('조회 거절'));
    await renderScreen(<ShopScreen />, client());
    expect(await screen.findByText(/불러오지 못했어요/)).toBeTruthy();
    expect(screen.queryByText('준비 중인 아이템이에요')).toBeNull();
    await fireEvent.press(screen.getByText('다시 시도'));
    await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(screen.queryByText(/불러오지 못했어요/)).toBeNull());
    expect(await screen.findByText(first!.name)).toBeTruthy();
  },
);

it('포인트 내역 조회 실패는 빈 화면 대신 오류와 재시도로 복구한다', async () => {
  const query = jest.spyOn(api.shop, 'ledger').mockRejectedValueOnce(new Error('내역 조회 거절'));
  await renderScreen(<PointsScreen />, client());
  expect(await screen.findByText(/불러오지 못했어요/)).toBeTruthy();
  await fireEvent.press(screen.getByText('다시 시도'));
  await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(1));
  await waitFor(() => expect(screen.queryByText(/불러오지 못했어요/)).toBeNull());
  expect(screen.getByText('포인트 내역')).toBeTruthy();
});

it('보유 목록 실패를 아이템 없음으로 표시하지 않고 재시도로 복구한다', async () => {
  const query = jest
    .spyOn(api.shop, 'myItems')
    .mockRejectedValueOnce(new Error('보유 목록 조회 거절'));
  await renderScreen(<BoxScreen />, client());
  expect(await screen.findByText(/불러오지 못했어요/)).toBeTruthy();
  expect(screen.queryByText('아직 보유한 아이템이 없어요')).toBeNull();
  await fireEvent.press(screen.getByText('다시 시도'));
  await waitFor(() => expect(query.mock.calls.length).toBeGreaterThan(1));
  await waitFor(() => expect(screen.queryByText(/불러오지 못했어요/)).toBeNull());
  expect(await screen.findByText('현재 아바타')).toBeTruthy();
});

it('보유 목록을 기다리는 동안에도 아이템 없음으로 단정하지 않는다', async () => {
  const pending = deferred<UserItem[]>();
  jest.spyOn(api.shop, 'myItems').mockReturnValue(pending.promise);
  await renderScreen(<BoxScreen />, client());
  expect(screen.queryByText('아직 보유한 아이템이 없어요')).toBeNull();
  await act(async () => pending.resolve([]));
  expect(await screen.findByText('아직 보유한 아이템이 없어요')).toBeTruthy();
});
