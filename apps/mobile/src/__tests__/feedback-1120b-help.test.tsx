import { Linking } from 'react-native';
import { fireEvent, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { SettingsScreen } from '../features/profile/settings';
import { LegalDocScreen } from '../features/auth/legal';
import { HELP_DOCS } from '../features/profile/help-docs';
import { seedUser } from './fixtures/seed';
import { renderScreen, setParams } from '../test-utils';

// 실기기 피드백(2026-11-20): 「도움말 및 지원」이 우리 사이트가 아닌 notelink.app 을 열었다
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
const mockApi = { me: { get: jest.fn(), update: jest.fn() } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));

beforeEach(() => {
  jest.clearAllMocks();
  setParams({});
  mockApi.me.get.mockResolvedValue(seedUser());
});

it('도움말은 외부 주소 없이 앱 안 화면으로 열고, 받는 사람 없는 문의 메일 줄은 없다', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
  await renderScreen(<SettingsScreen />, new QueryClient());
  await fireEvent.press(await screen.findByText('도움말 및 지원'));
  expect(screen.queryByText('1:1 문의하기')).toBeNull();
  await fireEvent.press(screen.getByText('자주 묻는 질문'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/legal/[doc]', params: { doc: 'faq' } });
  await fireEvent.press(screen.getByText('도움말 및 지원'));
  await fireEvent.press(screen.getByText('노트링크 사용 가이드'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/legal/[doc]', params: { doc: 'guide' } });
  await fireEvent.press(screen.getByText('사업자 정보'));
  expect(screen.queryByText(/help@notelink\.app/)).toBeNull();
  expect(open).not.toHaveBeenCalled();
});

it.each(['faq', 'guide'] as const)('%s 도움말 화면은 제목과 첫 항목을 보여 준다', async (doc) => {
  setParams({ doc });
  await renderScreen(<LegalDocScreen />);
  expect(screen.getByText(HELP_DOCS[doc].title)).toBeTruthy();
  expect(screen.getByText(HELP_DOCS[doc].sections[0]!.heading)).toBeTruthy();
});
