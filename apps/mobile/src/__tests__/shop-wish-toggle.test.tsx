// SHOP-004: 찜 하트를 빠르게 여러 번 누르면 찜 상태가 실제와 다르게 보였다.
// 찜은 서버에서 토글이라, 요청 중에 또 누르면 두 번 뒤집힌다. 그 아이템 요청 중엔 다시 보내지 않고,
// 응답의 isWished로 바로 그린다(내 아이템 다시 읽기를 기다리거나 먼저 시작한 다시 읽기에 덮이지 않게)
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import type { UserItem } from '@notelink/shared';
import { ShopScreen } from '../features/reward/shop';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30000 } } });
  clients.push(qc);
  return qc;
}
beforeEach(() => setParams({}));
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  jest.restoreAllMocks();
});

it('찜 요청 중에 하트를 또 눌러도 요청은 한 번만 간다', async () => {
  // 서버: 찜은 토글, 내 아이템은 지금 찜 상태를 돌려준다
  const server = new Set<string>();
  jest.spyOn(api.shop, 'myItems').mockImplementation(async () =>
    [...server].map((itemId) => ({
      _id: `ui-${itemId}`,
      itemId,
      itemCategory: 'avatar',
      isOwned: false,
      isWished: true,
      isEquipped: false,
      acquiredAt: null,
    })),
  );
  const pending = deferred<void>();
  const wish = jest.spyOn(api.shop, 'wish').mockImplementation(async (itemId) => {
    await pending.promise;
    if (server.has(itemId)) server.delete(itemId);
    else server.add(itemId);
    return server.has(itemId);
  });
  await renderScreen(<ShopScreen />, client());
  const heart = (await screen.findAllByLabelText('찜'))[0]!;
  await fireEvent.press(heart);
  await fireEvent.press(heart);
  await fireEvent.press(heart);
  expect(wish).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve());
  // 세 번 눌렀어도 한 번만 뒤집혀 찜됨 — 화면도 서버와 같다
  expect(await screen.findAllByLabelText('찜 해제')).toHaveLength(1);
  expect(server.size).toBe(1);
  // 응답이 온 뒤에는 다시 누를 수 있다
  await fireEvent.press(screen.getAllByLabelText('찜 해제')[0]!);
  await waitFor(() => expect(wish).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryAllByLabelText('찜 해제')).toHaveLength(0));
  expect(server.size).toBe(0);
});

it('응답의 isWished를 바로 그리고, 먼저 시작한 내 아이템 다시 읽기가 덮지 않는다', async () => {
  const stale = deferred<UserItem[]>();
  const pending = deferred<boolean>();
  const wish = jest.spyOn(api.shop, 'wish').mockImplementation(() => pending.promise);
  const wishedNow = (): UserItem[] => [
    {
      _id: 'ui-wished',
      itemId: wish.mock.calls[0]![0],
      itemCategory: 'avatar',
      isOwned: false,
      isWished: true,
      isEquipped: false,
      acquiredAt: null,
    },
  ];
  const fresh = deferred<UserItem[]>();
  let calls = 0;
  // 처음 읽기는 바로 [], 두 번째(찜 응답 전에 시작한 다시 읽기)는 찜 전 상태를 늦게 돌려주고,
  // 그 뒤(찜 응답 뒤) 다시 읽기는 서버의 지금 상태(찜됨)를 늦게 돌려준다
  jest
    .spyOn(api.shop, 'myItems')
    .mockImplementation(async () => [[], stale.promise][calls++] ?? fresh.promise);
  const qc = client();
  await renderScreen(<ShopScreen />, qc);
  const heart = (await screen.findAllByLabelText('찜'))[0]!;
  await fireEvent.press(heart);
  // 찜 응답 전에 다른 이유(구매 · 화면 복귀)로 내 아이템 다시 읽기가 시작됐다
  void qc.refetchQueries({ queryKey: ['my-items'] });
  await act(async () => pending.resolve(true));
  // 다시 읽기를 기다리지 않고 응답대로 빨간 하트
  expect(await screen.findAllByLabelText('찜 해제')).toHaveLength(1);
  // 늦게 온 찜 전 상태가 화면을 되돌리지 않는다
  await act(async () => stale.resolve([]));
  expect(screen.getAllByLabelText('찜 해제')).toHaveLength(1);
  // 응답 뒤 다시 읽은 서버 상태와도 같다
  await act(async () => fresh.resolve(wishedNow()));
  expect(screen.getAllByLabelText('찜 해제')).toHaveLength(1);
});

it('내 아이템을 처음 읽는 중에 찜 응답이 와도, 늦게 온 찜 전 목록이 하트를 되돌리지 않는다', async () => {
  // 처음 읽기는 찜 전 목록([])을 늦게 돌려주고, 그 뒤 다시 읽기는 서버의 지금 상태(찜됨)를 돌려준다
  const first = deferred<UserItem[]>();
  const wish = jest.spyOn(api.shop, 'wish').mockResolvedValue(true);
  let calls = 0;
  jest.spyOn(api.shop, 'myItems').mockImplementation(async () =>
    calls++
      ? [
          {
            _id: 'ui-wished',
            itemId: wish.mock.calls[0]![0],
            itemCategory: 'avatar',
            isOwned: false,
            isWished: true,
            isEquipped: false,
            acquiredAt: null,
          },
        ]
      : first.promise,
  );
  await renderScreen(<ShopScreen />, client());
  await fireEvent.press((await screen.findAllByLabelText('찜'))[0]!);
  await waitFor(() => expect(wish).toHaveBeenCalledTimes(1));
  await act(async () => first.resolve([]));
  expect(await screen.findAllByLabelText('찜 해제')).toHaveLength(1);
});
