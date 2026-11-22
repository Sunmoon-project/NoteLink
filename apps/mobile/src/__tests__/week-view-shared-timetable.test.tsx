import { AppState } from 'react-native';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import type { SharedTimetable } from '@notelink/shared';
import { RecordScreen } from '../features/progress/record';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

// SOC-009: 친구가 공유한 시간표를 내 주간 보기에 겹쳐 그린다(친구별 색 · 켜기/끄기 · 빈 상태 · 못 읽음)
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'https://api.example' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });

// jest.setup.js 의 expo-router 목은 useFocusEffect 가 아무것도 하지 않는다. 이 파일에서만 포커스 콜백을 모아 두고,
// 화면에 처음 들어오고(focus) · 떠나고(blur) · 돌아오게 한다
const routerMock = jest.requireMock<{ useFocusEffect: (cb: () => unknown) => void }>('expo-router');
const noFocus = routerMock.useFocusEffect;
const focusCallbacks = new Set<() => (() => void) | void>();
let cleanups: (() => void)[] = [];
const focus = () =>
  act(() => {
    cleanups = [...focusCallbacks].map((cb) => cb()).filter((f): f is () => void => !!f);
  });
const blur = () => act(() => cleanups.forEach((f) => f()));
// 앱이 다시 앞으로 나옴
let appListeners: ((s: string) => void)[] = [];
const foreground = () => act(() => appListeners.forEach((f) => f('active')));

beforeEach(() => {
  focusCallbacks.clear();
  cleanups = [];
  appListeners = [];
  routerMock.useFocusEffect = (cb) => void focusCallbacks.add(cb as () => (() => void) | void);
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _: string,
    fn: (s: string) => void,
  ) => {
    appListeners.push(fn);
    return { remove: () => (appListeners = appListeners.filter((f) => f !== fn)) };
  }) as never);
});
afterEach(() => {
  routerMock.useFocusEffect = noFocus;
  qc.clear();
  jest.restoreAllMocks();
});

const mine = () =>
  jest.spyOn(api.timetable, 'get').mockResolvedValue({
    _id: 't',
    updatedAt: '2026-11-01T00:00:00.000Z',
    classes: [
      {
        _id: 'c1',
        subjectName: '내 수업',
        days: [1],
        startTime: '09:00',
        endTime: '10:00',
        location: '',
        color: '#abcdef',
        source: 'manual',
      },
    ],
  });

const FRIENDS: SharedTimetable[] = [
  {
    ownerId: 'u-minji',
    nickname: '민지',
    mode: 'full',
    sharedAt: '2026-11-20T00:00:00.000Z',
    classes: [
      {
        days: [1],
        startTime: '09:00',
        endTime: '10:30',
        subjectName: '수학 II',
        location: '공학관',
      },
    ],
  },
  {
    ownerId: 'u-junho',
    nickname: '준호',
    mode: 'free_only',
    sharedAt: '2026-11-21T00:00:00.000Z',
    classes: [
      { days: [3], startTime: '13:00', endTime: '15:00', subjectName: null, location: null },
    ],
  },
];

const open = async () => {
  setParams({ mode: '주간' });
  await renderScreen(<RecordScreen />, qc);
};

it('공유받은 친구 수업을 내 수업과 함께 주간 보기에 그린다(빈 시간만이면 과목 대신 「바쁨」)', async () => {
  mine();
  jest.spyOn(api.timetable, 'shared').mockResolvedValue(FRIENDS);
  await open();
  expect(await screen.findByText('민지 · 수학 II')).toBeTruthy();
  expect(screen.getByText('준호 · 바쁨')).toBeTruthy();
  expect(screen.getByText('내 수업')).toBeTruthy();
  // 친구마다 다른 색
  const color = (text: string) => {
    let node: ReturnType<typeof screen.getByText> | null = screen.getByText(text);
    while (node && !node.props.style?.backgroundColor) node = node.parent;
    return node?.props.style.backgroundColor as string | undefined;
  };
  expect(color('민지 · 수학 II')).toBeTruthy();
  expect(color('민지 · 수학 II')).not.toBe(color('준호 · 바쁨'));
});

it('친구 칩을 누르면 그 친구 수업만 숨기고, 다시 누르면 보인다', async () => {
  mine();
  jest.spyOn(api.timetable, 'shared').mockResolvedValue(FRIENDS);
  await open();
  await screen.findByText('민지 · 수학 II');
  await fireEvent.press(screen.getByTestId('friend-chip-u-minji'));
  expect(screen.queryByText('민지 · 수학 II')).toBeNull();
  expect(screen.getByText('준호 · 바쁨')).toBeTruthy();
  expect(screen.getByText('내 수업')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('friend-chip-u-minji'));
  expect(screen.getByText('민지 · 수학 II')).toBeTruthy();
});

it('주간 보기를 다시 열면 친구 시간표를 다시 읽어, 끊긴 친구의 수업이 캐시로 남지 않는다', async () => {
  mine();
  const shared = jest.spyOn(api.timetable, 'shared').mockResolvedValue(FRIENDS);
  await open();
  await screen.findByText('민지 · 수학 II');
  // 월간으로 갔다가(주간 보기가 내려감) 그사이 친구를 끊고(서버는 더 이상 주지 않는다) 주간으로 돌아온다
  await fireEvent.press(screen.getByText('월간'));
  await waitFor(() => expect(screen.queryByText('민지 · 수학 II')).toBeNull());
  shared.mockResolvedValue([]);
  await fireEvent.press(screen.getByText('주간'));
  expect(await screen.findByText('공유받은 친구 시간표가 없어요')).toBeTruthy();
  expect(screen.queryByText('민지 · 수학 II')).toBeNull();
  expect(shared).toHaveBeenCalledTimes(2);
});

it('다른 화면에 다녀오면 친구 시간표를 다시 읽는다(30초 안이어도)', async () => {
  mine();
  const shared = jest.spyOn(api.timetable, 'shared').mockResolvedValue(FRIENDS);
  await open();
  await screen.findByText('민지 · 수학 II');
  await focus(); // 처음 들어옴: 쿼리가 이미 읽었으므로 다시 읽지 않는다
  expect(shared).toHaveBeenCalledTimes(1);
  await blur();
  shared.mockResolvedValue([]); // 그사이 친구를 끊었다
  await focus();
  expect(await screen.findByText('공유받은 친구 시간표가 없어요')).toBeTruthy();
  expect(screen.queryByText('민지 · 수학 II')).toBeNull();
  expect(shared).toHaveBeenCalledTimes(2);
});

it('주간 보기가 떠 있는 동안 앱이 다시 앞으로 나오면 친구 시간표를 다시 읽는다', async () => {
  mine();
  const shared = jest.spyOn(api.timetable, 'shared').mockResolvedValue(FRIENDS);
  await open();
  await screen.findByText('민지 · 수학 II');
  await focus();
  shared.mockResolvedValue([]);
  await foreground();
  expect(await screen.findByText('공유받은 친구 시간표가 없어요')).toBeTruthy();
  expect(shared).toHaveBeenCalledTimes(2);
  // 화면을 떠나면 더는 듣지 않는다
  await blur();
  await foreground();
  expect(shared).toHaveBeenCalledTimes(2);
});

it('이전에 받은 내용이 있어도 다시 읽기에 실패하면 알리고 다시 시도할 수 있다', async () => {
  mine();
  const shared = jest.spyOn(api.timetable, 'shared').mockResolvedValue(FRIENDS);
  await open();
  await screen.findByText('민지 · 수학 II');
  await focus();
  await blur();
  shared.mockRejectedValueOnce(new Error('network'));
  await focus();
  expect(
    await screen.findByText('친구 시간표를 새로 고치지 못했어요. 이전에 받은 내용이에요'),
  ).toBeTruthy();
  shared.mockResolvedValue([]);
  await fireEvent.press(screen.getByText('친구 시간표 다시 시도'));
  expect(await screen.findByText('공유받은 친구 시간표가 없어요')).toBeTruthy();
  expect(
    screen.queryByText('친구 시간표를 새로 고치지 못했어요. 이전에 받은 내용이에요'),
  ).toBeNull();
  expect(shared).toHaveBeenCalledTimes(3);
});

it('공유받은 시간표가 없으면 안내 한 줄만 보인다', async () => {
  mine();
  jest.spyOn(api.timetable, 'shared').mockResolvedValue([]);
  await open();
  expect(await screen.findByText('공유받은 친구 시간표가 없어요')).toBeTruthy();
  expect(screen.queryByTestId('friend-chip-u-minji')).toBeNull();
});

it('친구 시간표를 못 읽으면 내 시간표는 그대로 두고 다시 시도할 수 있다', async () => {
  mine();
  const shared = jest
    .spyOn(api.timetable, 'shared')
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue(FRIENDS);
  await open();
  expect(await screen.findByText('친구 시간표를 불러오지 못했어요')).toBeTruthy();
  expect(screen.getByText('내 수업')).toBeTruthy();
  await fireEvent.press(screen.getByText('친구 시간표 다시 시도'));
  expect(await screen.findByText('민지 · 수학 II')).toBeTruthy();
  expect(shared).toHaveBeenCalledTimes(2);
});
