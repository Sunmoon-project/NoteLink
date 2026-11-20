import { renderHook } from '@testing-library/react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useRoomOrientation } from '../features/studyroom/room-orientation';

let mockFocus: () => void | (() => void);
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: typeof mockFocus) => {
    mockFocus = effect;
  },
}));
jest.mock('expo-screen-orientation', () => ({
  OrientationLock: { DEFAULT: 0, PORTRAIT_UP: 3 },
  lockAsync: jest.fn(() => Promise.resolve()),
}));
const lock = jest.mocked(ScreenOrientation.lockAsync);
const { DEFAULT, PORTRAIT_UP } = ScreenOrientation.OrientationLock;

beforeEach(() => lock.mockClear());

it('방이 보이는 동안 가로 회전을 풀고, 다른 화면으로 가면 세로로 되돌린다', async () => {
  await renderHook(useRoomOrientation);
  const blur = mockFocus();
  blur?.();
  mockFocus(); // 설정 · 카드 화면에서 돌아오면 다시 푼다
  expect(lock.mock.calls.map(([o]) => o)).toEqual([DEFAULT, PORTRAIT_UP, DEFAULT]);
});

it('회전을 바꿀 수 없는 기기에서도 오류를 밖으로 던지지 않는다', async () => {
  lock.mockRejectedValueOnce(new Error('unsupported'));
  await renderHook(useRoomOrientation);
  expect(() => mockFocus()).not.toThrow();
  await Promise.resolve();
});
