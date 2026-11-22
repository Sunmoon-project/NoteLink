// SHOP-008: 포인트 내역이 0건이면 아무것도 없는 빈 화면이었다. 탭마다 빈 문구를 보여 준다
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { PointsScreen } from '../features/reward/shop';
import { api } from '../lib/api';
import { renderScreen } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const clients: QueryClient[] = [];
function client() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(qc);
  return qc;
}
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  jest.restoreAllMocks();
});

it('내역이 0건이면 탭마다 빈 문구를 보여 준다', async () => {
  jest.spyOn(api.shop, 'ledger').mockResolvedValue([]);
  await renderScreen(<PointsScreen />, client());
  expect(await screen.findByText('아직 포인트 내역이 없어요')).toBeTruthy();
  await fireEvent.press(screen.getByText('적립'));
  expect(await screen.findByText('아직 적립한 포인트가 없어요')).toBeTruthy();
  await fireEvent.press(screen.getByText('사용'));
  expect(await screen.findByText('아직 사용한 포인트가 없어요')).toBeTruthy();
});

it('내역이 있으면 빈 문구는 없다', async () => {
  const description = (await api.shop.ledger()).find((l) => l.description)?.description;
  expect(description).toBeTruthy();
  await renderScreen(<PointsScreen />, client());
  expect(await screen.findAllByText(description!)).not.toHaveLength(0);
  expect(screen.queryByText('아직 포인트 내역이 없어요')).toBeNull();
});

it('포인트 · 내 아이템을 아직 읽는 중이면 빈 문구를 로딩과 겹쳐 그리지 않는다', async () => {
  jest.spyOn(api.shop, 'ledger').mockResolvedValue([]);
  let done!: (v: Awaited<ReturnType<typeof api.shop.myItems>>) => void;
  jest.spyOn(api.shop, 'myItems').mockImplementation(() => new Promise((r) => (done = r)));
  await renderScreen(<PointsScreen />, client());
  await waitFor(() => expect(api.shop.ledger).toHaveBeenCalled());
  await act(async () => {});
  expect(screen.queryByText('아직 포인트 내역이 없어요')).toBeNull();
  await act(async () => done([]));
  expect(await screen.findByText('아직 포인트 내역이 없어요')).toBeTruthy();
});
