import type { ShopItem } from '@notelink/shared';
import { mockApi } from '../lib/mock/api';
import { SHOP } from '../lib/mock/seed';
import { useMockFlags } from '../lib/mock/flags';
import { useNet } from '../stores/net';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
const added: ShopItem[] = [];
async function response<T>(promise: Promise<T>, elapsed = 220): Promise<T> {
  await jest.advanceTimersByTimeAsync(elapsed);
  return promise;
}
function catalogItem(id: string, category: ShopItem['category']): ShopItem {
  const template = SHOP.find((item) => item.category === 'theme')!;
  const item = { ...template, _id: id, name: `신규 ${id}`, price: 100, category };
  // 카탈로그에만 정상 상품 fixture를 추가한다. mockApi와 사용자 보유 DB는 대체·조작하지 않는다.
  SHOP.push(item);
  added.push(item);
  return item;
}
beforeEach(async () => {
  jest.useFakeTimers();
  useMockFlags.getState().reset();
  useNet.setState({ state: 'ok' });
  await response(mockApi.shop.equip('base'));
});
afterEach(() => {
  for (const item of added.splice(0)) {
    const index = SHOP.indexOf(item);
    if (index >= 0) SHOP.splice(index, 1);
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('실제 목업에서 신규 테마를 찜→구매→장착해도 테마 카테고리와 기존 아바타를 보존한다', async () => {
  const theme = catalogItem('new-theme-wishlist', 'theme');
  expect((await response(mockApi.shop.myItems())).some((item) => item.itemId === theme._id)).toBe(
    false,
  );
  await response(mockApi.shop.wish(theme._id), 60);
  const wished = (await response(mockApi.shop.myItems())).find(
    (item) => item.itemId === theme._id,
  )!;
  await response(mockApi.shop.purchase(theme._id), 500);
  const purchased = (await response(mockApi.shop.myItems())).find(
    (item) => item.itemId === theme._id,
  )!;
  await response(mockApi.shop.equip(theme._id));
  const after = await response(mockApi.shop.myItems());
  expect({
    wishedCategory: wished.itemCategory,
    purchasedCategory: purchased.itemCategory,
    themeEquipped: after.find((item) => item.itemId === theme._id)?.isEquipped,
    avatarEquipped: after.find((item) => item.itemId === 'base')?.isEquipped,
  }).toEqual({
    wishedCategory: 'theme',
    purchasedCategory: 'theme',
    themeEquipped: true,
    avatarEquipped: true,
  });
});

it('기존 찜 항목은 구매 시 현재 카탈로그 카테고리로 보정해 다른 장착을 해제하지 않는다', async () => {
  const item = catalogItem('recategorized-wishlist-item', 'avatar');
  await response(mockApi.shop.wish(item._id), 60);
  const before = (await response(mockApi.shop.myItems())).find(
    (entry) => entry.itemId === item._id,
  )!;
  expect(before.itemCategory).toBe('avatar');
  // 기존 사용자 레코드를 직접 바꾸지 않고 카탈로그의 분류가 바뀐 경우를 재현한다.
  item.category = 'theme';
  await response(mockApi.shop.purchase(item._id), 500);
  await response(mockApi.shop.equip(item._id));
  const after = await response(mockApi.shop.myItems());
  expect({
    purchasedCategory: after.find((entry) => entry.itemId === item._id)?.itemCategory,
    themeEquipped: after.find((entry) => entry.itemId === item._id)?.isEquipped,
    avatarEquipped: after.find((entry) => entry.itemId === 'base')?.isEquipped,
  }).toEqual({ purchasedCategory: 'theme', themeEquipped: true, avatarEquipped: true });
});

it('테마 카테고리 조회는 기본·신규 테마를 반환하고 아바타를 제외한다', async () => {
  const seedTheme = SHOP.find((item) => item.category === 'theme')!;
  const addedTheme = catalogItem('theme-category-visible', 'theme');
  const themes = await response(mockApi.shop.items({ category: 'theme' }));
  expect(themes.map((item) => item._id)).toEqual(
    expect.arrayContaining([seedTheme._id, addedTheme._id]),
  );
  expect(themes.every((item) => item.category === 'theme')).toBe(true);
  expect(themes.some((item) => item.category === 'avatar')).toBe(false);
});
