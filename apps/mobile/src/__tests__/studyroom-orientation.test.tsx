import { act, renderHook } from '@testing-library/react-native';
import * as ScreenOrientation from 'expo-screen-orientation';
import { useRoomOrientation } from '../features/studyroom/room-orientation';

let mockFocus: () => void | (() => void);
jest.mock('expo-router', () => ({
  useFocusEffect: (callback: typeof mockFocus) => {
    mockFocus = callback;
  },
}));
jest.mock('expo-screen-orientation', () => ({
  OrientationLock: { DEFAULT: 0, PORTRAIT_UP: 3 },
  lockAsync: jest.fn(async () => {}),
}));
const lock = jest.mocked(ScreenOrientation.lockAsync);
beforeEach(() => jest.clearAllMocks());

it('방에 포커스가 있을 때만 세로·가로 회전을 허용하고 떠날 때 세로로 복원한다', async () => {
  const hook = await renderHook(useRoomOrientation);
  expect(lock).not.toHaveBeenCalled();
  const blur = mockFocus();
  expect(lock).toHaveBeenLastCalledWith(ScreenOrientation.OrientationLock.DEFAULT);
  await hook.rerender({});
  expect(lock).toHaveBeenCalledTimes(1);
  blur?.();
  expect(lock).toHaveBeenLastCalledWith(ScreenOrientation.OrientationLock.PORTRAIT_UP);
});

it('다른 화면에서 방으로 돌아오면 다시 회전을 허용한다', async () => {
  await renderHook(useRoomOrientation);
  const blur = mockFocus();
  blur?.();
  mockFocus();
  expect(lock.mock.calls.map(([policy]) => policy)).toEqual([
    ScreenOrientation.OrientationLock.DEFAULT,
    ScreenOrientation.OrientationLock.PORTRAIT_UP,
    ScreenOrientation.OrientationLock.DEFAULT,
  ]);
});

it('방향 변경을 지원하지 않는 기기에서 실패해도 미처리 오류를 남기지 않는다', async () => {
  lock.mockRejectedValue(new Error('unsupported'));
  await renderHook(useRoomOrientation);
  await act(async () => {
    const blur = mockFocus();
    blur?.();
  });
  expect(lock).toHaveBeenCalledTimes(2);
  lock.mockResolvedValue(undefined);
});
