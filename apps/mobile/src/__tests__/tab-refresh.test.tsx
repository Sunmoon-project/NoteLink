// 탭 첫 화면의 새로 고침(useTabRefresh): 돌아올 때 · 앱이 앞으로 나올 때는 오래된 조회만,
// 아래로 당기면 강제로. 넘기지 않은 조회(다른 탭의 퀴즈 풀이 · 편집 화면)는 다시 읽지 않는다
import { AppState, Text } from 'react-native';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { QueryClient, useQuery } from '@tanstack/react-query';
import { Screen } from '../components/ui';
import { useTabRefresh } from '../hooks';
import { renderScreen } from '../test-utils';

// 포커스 콜백을 모아 두고, 테스트에서 화면을 떠나고(blur) 돌아오게(focus) 한다
let mockCleanups: (() => void)[] = [];
const mockFocus = new Set<() => (() => void) | void>();
jest.mock('expo-router', () => ({
  useIsFocused: () => true,
  useSegments: () => [],
  useFocusEffect: (cb: () => (() => void) | void) => mockFocus.add(cb),
}));
const focus = () =>
  act(() => {
    mockCleanups = [...mockFocus].map((cb) => cb() as () => void);
  });
const blur = () => act(() => mockCleanups.forEach((f) => f()));

// RN의 jest 목은 props를 넘기지 않아, 당기기(onRefresh)를 누를 수 있는 글자로 바꾼다
jest.mock('react-native/Libraries/Components/RefreshControl/RefreshControl', () => {
  const { Text: T } = jest.requireActual('react-native');
  const Pull = ({ refreshing, onRefresh }: { refreshing: boolean; onRefresh: () => void }) => (
    <T onPress={onRefresh}>{refreshing ? '새로 고치는 중' : '당기기'}</T>
  );
  return { __esModule: true, default: Pull };
});

let appState: ((s: string) => void)[] = [];
jest.spyOn(AppState, 'addEventListener').mockImplementation(((_: string, fn: (s: string) => void) => {
  appState.push(fn);
  return { remove: () => (appState = appState.filter((f) => f !== fn)) };
}) as never);
const foreground = () => act(() => appState.forEach((f) => f('active')));

const list = jest.fn(async () => ['노트']);
const solving = jest.fn(async () => ['문제']);

function Tab() {
  const q = useQuery({ queryKey: ['list'], queryFn: list });
  // 같은 화면에 떠 있어도 넘기지 않은 조회(예: 다른 탭의 퀴즈 풀이)
  useQuery({ queryKey: ['solving'], queryFn: solving });
  const refresh = useTabRefresh(q);
  return (
    <Screen refresh={refresh}>
      <Text>{q.data?.join()}</Text>
    </Screen>
  );
}

const client = () =>
  new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
// 시간만 앞당긴다(조회의 오래됨은 Date.now로 판단). 타이머는 그대로 둬 조회가 평소처럼 끝나게
let now = 0;
const later = (ms: number) =>
  act(() => {
    now += ms;
  });

beforeEach(() => {
  now = Date.UTC(2026, 10, 10);
  jest.spyOn(Date, 'now').mockImplementation(() => now);
  mockFocus.clear();
  mockCleanups = [];
  appState = [];
  list.mockClear();
  solving.mockClear();
});
afterEach(() => jest.mocked(Date.now).mockRestore());

it('처음 열 때는 한 번만 읽고, 오래되지 않았으면 돌아와도 다시 읽지 않는다', async () => {
  await renderScreen(<Tab />, client());
  expect(await screen.findByText('노트')).toBeTruthy();
  await focus();
  await blur();
  await later(10_000);
  await focus();
  expect(list).toHaveBeenCalledTimes(1);
});

it('오래된 뒤 돌아오면 넘긴 조회만 다시 읽는다', async () => {
  await renderScreen(<Tab />, client());
  await screen.findByText('노트');
  await focus();
  await blur();
  await later(31_000);
  await focus();
  expect(list).toHaveBeenCalledTimes(2);
  expect(solving).toHaveBeenCalledTimes(1);
});

it('보이는 동안 앱이 앞으로 나오면 오래된 것만, 떠난 뒤에는 다시 읽지 않는다', async () => {
  await renderScreen(<Tab />, client());
  await screen.findByText('노트');
  await focus();
  await foreground();
  expect(list).toHaveBeenCalledTimes(1);
  await later(31_000);
  await foreground();
  expect(list).toHaveBeenCalledTimes(2);
  await blur();
  await later(31_000);
  await foreground();
  expect(list).toHaveBeenCalledTimes(2);
});

it('아래로 당기면 오래되지 않았어도 서버에서 다시 읽고, 다 읽으면 표시를 거둔다', async () => {
  await renderScreen(<Tab />, client());
  await screen.findByText('노트');
  list.mockResolvedValueOnce(['새 노트']);
  await fireEvent.press(screen.getByText('당기기'));
  expect(list).toHaveBeenCalledTimes(2);
  expect(solving).toHaveBeenCalledTimes(1);
  expect(await screen.findByText('새 노트')).toBeTruthy();
  expect(screen.getByText('당기기')).toBeTruthy();
});
