import { api } from '../lib/api';
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('../lib/mock/seed', () => {
  const actual = jest.requireActual('../lib/mock/seed');
  return { ...actual, seedUser: () => ({ ...actual.seedUser(), pointBalance: 100000 }) };
});
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
it('보유한 상품을 다시 구매해도 포인트와 내역이 늘지 않는다', async () => {
  const item = (await api.shop.items({})).find((x) => x.price > 0)!;
  await api.shop.purchase(item._id);
  const owned = (await api.shop.myItems()).find((x) => x.itemId === item._id)!;
  const before = (await api.me.get()).pointBalance;
  const ledger = (await api.shop.ledger()).length;
  await api.shop.purchase(owned.itemId);
  expect((await api.me.get()).pointBalance).toBe(before);
  expect((await api.shop.ledger()).length).toBe(ledger);
});
it('테마 장착은 아바타 장착을 해제하지 않는다', async () => {
  const all = await api.shop.items({});
  const mine = await api.shop.myItems();
  const avatar = mine.find((x) => x.isOwned && x.itemCategory === 'avatar')!;
  const theme = all.find((x) => x.category === 'theme')!;
  await api.shop.equip(avatar.itemId);
  // 별도 카테고리의 기본 보유 테마 fixture를 사용한다.
  const ownedTheme = mine.find((x) => x.isOwned && x.itemCategory === 'theme');
  if (!ownedTheme) await api.shop.purchase(theme._id);
  await api.shop.equip(ownedTheme?.itemId ?? theme._id);
  const after = await api.shop.myItems();
  expect(after.find((x) => x.itemId === avatar.itemId)?.isEquipped).toBe(true);
});

it('할일 직접 입력 시각은 저장과 재조회에 보존된다', async () => {
  const item = await api.calendar.addTodo({
    dueDate: '2026-11-01',
    content: '시간',
    todoType: 'general',
    timeSlot: 'custom',
    dueTime: '09:35',
    subjectName: null,
  });
  expect((await api.calendar.todos('2026-11-01')).find((x) => x._id === item._id)?.dueTime).toBe(
    '09:35',
  );
});
