import { useState } from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { Chip, Sheet, Tap } from '../components/ui';
import { mockApi as mockTimetableApi } from './fixtures/api';
import { renderScreen } from '../test-utils';
import { MOTION } from '../theme';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../lib/socket', () => ({
  localSocket: { emit: jest.fn() },
  socket: { on: jest.fn(() => () => {}), emit: jest.fn() },
}));
afterEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

it.each([false, true])('Chip small=%s의 실제 터치 요소는 최소 44 크기다', async (small) => {
  await render(
    <Chip small={small} onPress={jest.fn()}>
      과목
    </Chip>,
  );
  expect(screen.getByRole('button')).toHaveStyle({ minWidth: 44, minHeight: 44 });
});

it('Tap 자체가 작은 콘텐츠에도 최소 44 터치 영역을 제공한다', async () => {
  await render(
    <Tap accessibilityRole="button" onPress={jest.fn()}>
      <Text>+</Text>
    </Tap>,
  );
  expect(screen.getByRole('button')).toHaveStyle({ minWidth: 44, minHeight: 44 });
});

it('시트를 닫고 종료 애니메이션 전에 다시 열면 이전 닫기 타이머가 새 화면을 닫지 않는다', async () => {
  jest.useFakeTimers();
  let changeOpen!: (open: boolean) => void;
  function Harness() {
    const [open, setOpen] = useState(true);
    changeOpen = setOpen;
    return (
      <Sheet open={open} onClose={() => setOpen(false)}>
        <Text>다시 연 시트</Text>
      </Sheet>
    );
  }
  await renderScreen(<Harness />);
  await act(async () => changeOpen(false));
  await act(async () => jest.advanceTimersByTime(MOTION.exit - 1));
  await act(async () => changeOpen(true));
  await act(async () => jest.advanceTimersByTime(MOTION.exit + 1));
  expect(screen.getByText('다시 연 시트')).toBeTruthy();
  await act(async () => changeOpen(false));
  await act(async () => jest.advanceTimersByTime(MOTION.exit + 1));
  expect(screen.queryByText('다시 연 시트')).toBeNull();
});

it('시간표 공유는 기존 친구의 모드를 바꾸고 중복 공유를 만들지 않는다', async () => {
  const before = await mockTimetableApi.timetable.shares();
  const shared = before.find((entry) => entry.friendId === 'u-jiwoo');
  expect(shared?.mode).toBe('full');
  await mockTimetableApi.timetable.share({ friendIds: ['u-jiwoo'], mode: 'free_only' });
  const after = await mockTimetableApi.timetable.shares();
  expect(after.filter((entry) => entry.friendId === 'u-jiwoo')).toHaveLength(1);
  expect(after.find((entry) => entry.friendId === 'u-jiwoo')).toEqual(
    expect.objectContaining({
      _id: shared!._id,
      mode: 'free_only',
    }),
  );
});

it('시간표 공유에 새 친구를 추가할 때 선택한 모드를 저장한다', async () => {
  await mockTimetableApi.timetable.share({ friendIds: ['u-sumin'], mode: 'free_only' });
  const shares = await mockTimetableApi.timetable.shares();
  expect(shares.filter((entry) => entry.friendId === 'u-sumin')).toHaveLength(1);
  expect(shares.find((entry) => entry.friendId === 'u-sumin')?.mode).toBe('free_only');
});
