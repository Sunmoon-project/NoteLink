import { act, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { HomeScreen } from '../features/session/home';
import { SettingsScreen } from '../features/profile/settings';
import { ChatScreen, RequestsScreen } from '../features/social/screens';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => jest.restoreAllMocks());

it('홈은 목표를 못 읽어도 임의의 21시간 목표로 계산하지 않고, 목록 실패를 안내한다', async () => {
  jest.spyOn(api.study, 'weeklyGoal').mockRejectedValue(new Error('실패'));
  jest.spyOn(api.study, 'today').mockRejectedValue(new Error('실패'));
  setParams({});
  await renderScreen(<HomeScreen />, client());
  expect(await screen.findByText('오늘 목록을 불러오지 못했어요')).toBeTruthy();
  expect(screen.queryByText(/목표 21시간/)).toBeNull();
});

it('설정은 재조회가 실패해도 불러온 내 정보를 유지한다', async () => {
  const qc = client();
  setParams({});
  await renderScreen(<SettingsScreen />, qc);
  await screen.findByText('AI 크레딧');
  jest.spyOn(api.me, 'get').mockRejectedValue(new Error('일시 오류'));
  await act(async () => {
    await qc.refetchQueries({ queryKey: ['me'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(screen.queryByText('내 정보를 불러오지 못했어요')).toBeNull();
  expect(screen.getByText('AI 크레딧')).toBeTruthy();
});

it('친구 요청 조회 실패를 안내한다', async () => {
  jest.spyOn(api.social, 'received').mockRejectedValue(new Error('실패'));
  setParams({});
  await renderScreen(<RequestsScreen />, client());
  expect(await screen.findByText('친구 요청을 불러오지 못했어요')).toBeTruthy();
});

it('홈은 주간 기록을 못 읽으면 0시간으로 표시하지 않고 다시 시도하게 한다', async () => {
  jest.spyOn(api.study, 'weekly').mockRejectedValue(new Error('실패'));
  setParams({});
  await renderScreen(<HomeScreen />, client());
  expect(await screen.findByText('이번주 기록을 불러오지 못했어요')).toBeTruthy();
  expect(screen.getByText('이번주 기록 다시 시도')).toBeTruthy();
  expect(screen.queryByText(/이번주 0/)).toBeNull();
});

it('1:1 대화 기록을 못 읽으면 빈 대화로 두지 않는다', async () => {
  jest.spyOn(api.social, 'openDirect').mockResolvedValue({ _id: 'c1' } as never);
  jest.spyOn(api.social, 'messages').mockRejectedValue(new Error('실패'));
  setParams({ id: 'u1', name: '친구' });
  await renderScreen(<ChatScreen />, client());
  expect(await screen.findByText('대화 기록을 불러오지 못했어요')).toBeTruthy();
});
