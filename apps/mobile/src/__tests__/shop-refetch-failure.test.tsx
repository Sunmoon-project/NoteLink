import { act, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { ShopScreen } from '../features/reward/shop';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

afterEach(() => jest.restoreAllMocks());

it('재조회가 실패해도 이미 불러온 상점 화면을 유지한다', async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  setParams({});
  await renderScreen(<ShopScreen />, qc);
  await screen.findByText('보유 포인트');
  await screen.findByText('보관함');
  jest.spyOn(api.me, 'get').mockRejectedValue(new Error('일시 오류'));
  await act(async () => {
    await qc.refetchQueries({ queryKey: ['me'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByText('상점 정보를 불러오지 못했어요')).toBeNull();
  expect(screen.getByText('보유 포인트')).toBeTruthy();
});
