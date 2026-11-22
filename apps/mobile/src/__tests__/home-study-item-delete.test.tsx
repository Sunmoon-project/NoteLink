import { ERROR_CODES, type DailyRecord, type StudyItem } from '@notelink/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ApiError } from '../lib/api/http';
import { HomeScreen } from '../features/session/home';
import { useSession } from '../stores/session';
import { useToast } from '../stores/toast';
import { renderScreen } from '../test-utils';

// HOME-002: 홈 「오늘 공부할 목록」의 항목을 길게 눌러 지운다(기록은 서버에 남고 목록에서만 사라진다)

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-sensors', () => ({
  Accelerometer: { addListener: jest.fn(() => ({ remove() {} })), setUpdateInterval: jest.fn() },
}));
jest.mock('expo-keep-awake', () => ({ useKeepAwake: () => {} }));
jest.mock('expo-haptics', () => ({
  selectionAsync: jest.fn(),
  impactAsync: jest.fn(),
  ImpactFeedbackStyle: {},
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  useIsFocused: () => true,
  router: { push: jest.fn(), back: jest.fn(), replace: jest.fn() },
  useLocalSearchParams: () => ({}),
  useFocusEffect: (callback: () => (() => void) | void) =>
    jest.requireActual<typeof import('react')>('react').useEffect(callback, [callback]),
}));

const CONFIRM = '공부 항목을 삭제할까요?';
const item = (id: string, title: string): StudyItem => ({
  _id: id,
  title,
  subjectId: null,
  subjectName: '수학',
  goalMin: 60,
  accumulatedSec: 600,
});
const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 0 } },
  });

let items: StudyItem[];
let remove: jest.SpyInstance;
beforeEach(() => {
  useToast.setState({ msg: null } as never);
  items = [item('a', '영어 단어'), item('b', '수학 문제집')];
  jest.spyOn(api.study, 'today').mockImplementation(
    async () =>
      ({
        _id: 'dr',
        studyDate: '2026-11-22',
        totalSec: 1200,
        personalSec: 1200,
        roomSec: 0,
        streakOk: true,
        items: structuredClone(items),
      }) satisfies DailyRecord,
  );
  // 서버처럼 지운 항목은 다음 목록에서 빠진다
  remove = jest.spyOn(api.study, 'removeItem').mockImplementation(async (id: string) => {
    items = items.filter((i) => i._id !== id);
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  useSession.getState().reset();
});

it('항목을 길게 누르면 확인 창이 뜨고, 삭제를 누르면 지우고 목록에서 사라진다', async () => {
  await renderScreen(<HomeScreen />, client());
  fireEvent(await screen.findByText('영어 단어'), 'longPress');
  expect(await screen.findByText(CONFIRM)).toBeTruthy();

  fireEvent.press(screen.getByText('삭제'));

  await waitFor(() => expect(remove).toHaveBeenCalledWith('a'));
  await waitFor(() => expect(screen.queryByText('영어 단어')).toBeNull());
  expect(screen.getByText('수학 문제집')).toBeTruthy();
  expect(useToast.getState().msg).toBe('공부 항목을 삭제했어요');
});

it('확인 창에서 취소하면 지우지 않는다', async () => {
  await renderScreen(<HomeScreen />, client());
  fireEvent(await screen.findByText('영어 단어'), 'longPress');
  fireEvent.press(await screen.findByText('취소'));

  await waitFor(() => expect(screen.queryByText(CONFIRM)).toBeNull());
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByText('영어 단어')).toBeTruthy();
});

it('지우지 못하면 안내하고 항목을 그대로 둔다', async () => {
  remove.mockRejectedValueOnce(new ApiError('SERVER_ERROR', 'x', 500));
  await renderScreen(<HomeScreen />, client());
  fireEvent(await screen.findByText('영어 단어'), 'longPress');
  fireEvent.press(await screen.findByText('삭제'));

  await waitFor(() =>
    expect(useToast.getState().msg).toBe('공부 항목을 삭제하지 못했어요. 다시 시도해 주세요'),
  );
  expect(screen.getByText('영어 단어')).toBeTruthy();
});

it('서버가 측정 중이라 거절하면(409) 공부를 끝낸 뒤 지우라고 안내한다', async () => {
  remove.mockRejectedValueOnce(new ApiError(ERROR_CODES.STUDY_ITEM_IN_SESSION, 'x', 409));
  await renderScreen(<HomeScreen />, client());
  fireEvent(await screen.findByText('영어 단어'), 'longPress');
  fireEvent.press(await screen.findByText('삭제'));

  await waitFor(() =>
    expect(useToast.getState().msg).toBe('측정 중인 항목은 공부를 끝낸 뒤 삭제할 수 있어요'),
  );
  expect(screen.getByText('영어 단어')).toBeTruthy();
});

it('지금 측정 중(일시정지 포함)인 항목은 확인 창 없이 끝낸 뒤 지우라고 안내한다', async () => {
  await act(async () =>
    useSession.setState({ itemId: 'a', sessionId: 's1', since: null, pausedAt: Date.now() }),
  );
  await renderScreen(<HomeScreen />, client());
  // 일시정지 중인 항목은 큰 타이머 카드에도 제목이 보이므로 목록의 행(마지막)을 누른다
  const rows = await screen.findAllByText('영어 단어');
  fireEvent(rows[rows.length - 1]!, 'longPress');

  expect(useToast.getState().msg).toBe('측정 중인 항목은 공부를 끝낸 뒤 삭제할 수 있어요');
  expect(screen.queryByText(CONFIRM)).toBeNull();
  expect(remove).not.toHaveBeenCalled();
});
