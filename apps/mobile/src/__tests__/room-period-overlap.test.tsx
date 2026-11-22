import { fireEvent, screen } from '@testing-library/react-native';
import { TimerScreen } from '../features/studyroom/tools';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';

// TestQA 3차 TC-ROOM-013(iOS): 교시가 겹쳐도 안내가 안 보였다 — iOS에서 대화상자(Modal)는 따로 뜬 창이라
// 앱 맨 아래에 그리는 토스트가 그 뒤에 가려진다. 안내는 대화상자 안에 보인다
const mockApi = { rooms: { get: jest.fn(), schedule: jest.fn(), setTimer: jest.fn() } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: () => () => {} } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-calendar', () => ({}));

const periods = [
  { start: '09:00', end: '09:50', label: '1교시' },
  { start: '10:00', end: '10:50', label: '2교시' },
];
const rule = { enabled: true, type: 'period', focusMin: 50, breakMin: 10, repeat: 4, periods };

beforeEach(() => {
  setParams({ id: 'r1' });
  useAuth.setState({ userId: 'host' });
  mockApi.rooms.get.mockResolvedValue({
    _id: 'r1',
    title: '방',
    hostId: 'host',
    members: [],
    timerRule: rule,
  });
});

it('교시 시간이 겹치면 교시 편집 대화상자 안에 안내가 보이고, 고치면 사라진다', async () => {
  await renderScreen(<TimerScreen />);
  await fireEvent.press(await screen.findByLabelText('2교시 편집'));
  await fireEvent.changeText(screen.getByLabelText('교시 시작'), '09:30');
  await fireEvent.press(screen.getByText('교시 적용'));
  expect(screen.getByText('다른 교시와 시간이 겹치지 않게 입력해 주세요')).toBeTruthy();
  expect(screen.getByText('교시 편집')).toBeTruthy();
  await fireEvent.changeText(screen.getByLabelText('교시 시작'), '10:00');
  expect(screen.queryByText('다른 교시와 시간이 겹치지 않게 입력해 주세요')).toBeNull();
});
