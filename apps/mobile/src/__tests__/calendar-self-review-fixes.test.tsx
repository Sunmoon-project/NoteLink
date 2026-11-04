import { fireEvent, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { RecordScreen } from '../features/progress/record';
import { TimetableScreen } from '../features/calendar/screens';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'https://api.example' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
afterEach(() => jest.restoreAllMocks());

it('수업 추가는 빈 입력으로 시작하고 고정 학기를 표시하지 않는다', async () => {
  setParams({});
  await renderScreen(<TimetableScreen />, client());
  await fireEvent.press(await screen.findByText('+ 수업 추가'));
  expect(screen.queryByDisplayValue('수학 II')).toBeNull();
  expect(screen.queryByDisplayValue('3-2 교실')).toBeNull();
  expect(screen.getByRole('button', { name: '추가하기' })).toBeDisabled();
  expect(screen.queryByText(/2026-2학기/)).toBeNull();
});

it('기록 조회가 실패하면 0이나 고정 시각 대신 실패를 안내한다', async () => {
  jest.spyOn(api.study, 'weekly').mockRejectedValue(new Error('실패'));
  jest.spyOn(api.study, 'stats').mockRejectedValue(new Error('실패'));
  setParams({});
  await renderScreen(<RecordScreen />, client());
  expect(await screen.findByText('이번주 기록을 불러오지 못했어요')).toBeTruthy();
  expect(await screen.findByText('누적 기록을 불러오지 못했어요')).toBeTruthy();
  expect(screen.queryByText('오후 9시')).toBeNull();
  expect(screen.queryByText('0시간')).toBeNull();
});
