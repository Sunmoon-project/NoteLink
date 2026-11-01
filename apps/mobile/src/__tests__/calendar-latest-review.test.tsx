import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import { CalSharedScreen, HolidayScreen } from '../features/calendar/screens';
import { RepeatGoalScreen } from '../features/progress/goals';
import { RecordScreen } from '../features/progress/record';
import { api } from '../lib/api';
import { today } from '../lib/dates';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';

const mockStored = new Map<string, string>();
jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'https://api.example' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStored.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStored.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStored.delete(key);
  }),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
const clients: QueryClient[] = [];
const client = () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(qc);
  return qc;
};
const monthKey = today().slice(0, 7);
const publicDay = `${monthKey}-05`;
const hiddenDay = `${monthKey}-06`;
const customDay = `${monthKey}-07`;
const preferenceKey = 'notelink.holiday-auto.calendar-review-user';
beforeEach(() => {
  jest.clearAllMocks();
  mockStored.clear();
  setParams({});
  useAuth.setState({ userId: 'calendar-review-user' });
  jest.spyOn(api.calendar, 'holidays').mockResolvedValue([
    { _id: publicDay, name: '표시할 공휴일', hidden: false },
    { _id: hiddenDay, name: '숨긴 공휴일', hidden: true },
  ]);
  jest
    .spyOn(api.calendar, 'customHolidays')
    .mockResolvedValue([{ _id: 'custom-holiday', date: customDay, name: '학교 쉬는 날' }]);
});
afterEach(() => {
  clients.splice(0).forEach((qc) => qc.clear());
  jest.restoreAllMocks();
});

describe('PR35 반복 목표 생성 진입과 ID', () => {
  it('목표가 없어도 생성할 수 있고 마지막 목표 삭제 후 새 ID로 다시 만든다', async () => {
    for (const goal of await api.study.recurringGoals())
      await api.study.deleteRecurringGoal(goal._id);
    let view = await renderScreen(<RecordScreen />, client());
    await fireEvent.press(await screen.findByText('+ 반복 목표 추가'));
    expect(router.push).toHaveBeenCalledWith('/repeat');
    await view.unmount();
    setParams({});
    const save = jest.spyOn(api.study, 'saveRecurringGoal');
    view = await renderScreen(<RepeatGoalScreen />, client());
    await fireEvent.changeText(
      screen.getByPlaceholderText('매일 30분 영어 단어 암기'),
      '처음 만든 목표',
    );
    await fireEvent.press(screen.getByLabelText('월요일'));
    await fireEvent.press(screen.getByText('저장하기'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).not.toHaveProperty('_id');
    const first = await save.mock.results[0]!.value;
    expect(first._id).toEqual(expect.any(String));
    expect(first._id.length).toBeGreaterThan(0);
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(1));
    await view.unmount();
    setParams({ id: first._id });
    view = await renderScreen(<RepeatGoalScreen />, client());
    await screen.findByDisplayValue('처음 만든 목표');
    await fireEvent.press(screen.getByText('목표 삭제'));
    await fireEvent.press(await screen.findByRole('button', { name: '삭제' }));
    await waitFor(async () => expect(await api.study.recurringGoals()).toHaveLength(0));
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(2));
    await view.unmount();
    setParams({});
    view = await renderScreen(<RecordScreen />, client());
    await fireEvent.press(await screen.findByText('+ 반복 목표 추가'));
    expect(router.push).toHaveBeenLastCalledWith('/repeat');
    await view.unmount();
    view = await renderScreen(<RepeatGoalScreen />, client());
    await fireEvent.changeText(
      screen.getByPlaceholderText('매일 30분 영어 단어 암기'),
      '삭제 뒤 새 목표',
    );
    await fireEvent.press(screen.getByLabelText('화요일'));
    await fireEvent.press(screen.getByText('저장하기'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0]).not.toHaveProperty('_id');
    const second = await save.mock.results[1]!.value;
    expect(second._id).toEqual(expect.any(String));
    expect(second._id).not.toBe(first._id);
    await waitFor(() => expect(router.back).toHaveBeenCalledTimes(3));
    await view.unmount();
    expect((await api.study.recurringGoals()).map((goal) => goal._id)).toEqual([second._id]);
  });
});

describe('PR35 공휴일 표시 설정', () => {
  it('자동 연동 설정은 SecureStore에 저장되어 새 화면과 새 조회 캐시에서도 유지된다', async () => {
    let view = await renderScreen(<HolidayScreen />, client());
    await waitFor(() => expect(SecureStore.getItemAsync).toHaveBeenCalledWith(preferenceKey));
    await fireEvent(screen.getByLabelText('공휴일 자동 연동'), 'valueChange', false);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(preferenceKey, 'false');
    await waitFor(() => expect(screen.getByLabelText('공휴일 자동 연동').props.value).toBe(false));
    await view.unmount();
    view = await renderScreen(<HolidayScreen />, client());
    await waitFor(() => expect(screen.getByLabelText('공휴일 자동 연동').props.value).toBe(false));
    await view.unmount();
  });
  it('기록 화면은 숨긴 공휴일을 제외하고 자동 연동을 꺼도 사용자 휴일을 표시한다', async () => {
    let view = await renderScreen(<RecordScreen />, client());
    await screen.findByLabelText(`${publicDay} 표시할 공휴일`);
    await screen.findByLabelText(`${customDay} 학교 쉬는 날`);
    expect(screen.queryByLabelText(`${hiddenDay} 숨긴 공휴일`)).toBeNull();
    expect(screen.queryByText(`${hiddenDay} · 숨긴 공휴일`)).toBeNull();
    await view.unmount();
    view = await renderScreen(<HolidayScreen />, client());
    await fireEvent(screen.getByLabelText('공휴일 자동 연동'), 'valueChange', false);
    await waitFor(() => expect(mockStored.get(preferenceKey)).toBe('false'));
    await view.unmount();
    view = await renderScreen(<RecordScreen />, client());
    await screen.findByLabelText(`${customDay} 학교 쉬는 날`);
    await waitFor(() => expect(screen.queryByLabelText(`${publicDay} 표시할 공휴일`)).toBeNull());
    expect(screen.getByLabelText(publicDay)).toBeTruthy();
    expect(screen.queryByText(`${publicDay} · 표시할 공휴일`)).toBeNull();
    expect(screen.getByText(`${customDay} · 학교 쉬는 날`)).toBeTruthy();
    await view.unmount();
  });
});

it('주간 기록에는 API 수업만 표시하고 화학 스터디 예시를 끼워 넣지 않는다', async () => {
  jest.spyOn(api.timetable, 'get').mockResolvedValue({
    _id: 'timetable-review',
    updatedAt: '2026-11-01T00:00:00.000Z',
    classes: [
      {
        _id: 'actual-class',
        subjectName: '실제 API 수업',
        days: [1],
        startTime: '11:00',
        endTime: '12:00',
        location: '',
        color: '#abcdef',
        source: 'manual',
      },
    ],
  });
  setParams({ mode: '주간' });
  await renderScreen(<RecordScreen />, client());
  await screen.findByText('실제 API 수업');
  expect(screen.queryByText('스터디룸 · 화학')).toBeNull();
});

it('공유받은 두 번째 소유자를 고르고 공유 시작 월에서 이전·다음 달을 조회한다', async () => {
  const share = (id: string, name: string, from: string, to: string) => ({
    _id: id,
    ownerId: `owner-${id}`,
    ownerNickname: name,
    token: id,
    rangeStart: from,
    rangeEnd: to,
    scopes: ['study'],
    expiresAt: null,
    revokedAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    subscribers: [],
    days: [from],
  });
  jest
    .spyOn(api.calendar, 'received')
    .mockResolvedValue([
      share('share-one', '첫 번째 소유자', '2027-02-03', '2027-03-15'),
      share('share-two', '두 번째 소유자', '2028-08-09', '2028-09-20'),
    ]);
  const subscribe = jest.spyOn(api.calendar, 'subscribe').mockResolvedValue(undefined);
  await renderScreen(<CalSharedScreen />, client());
  await screen.findByText('첫 번째 소유자님이 공유한 캘린더');
  expect(screen.getByText('2027년 2월')).toBeTruthy();
  await fireEvent.press(screen.getByText('두 번째 소유자'));
  expect(screen.getByText('두 번째 소유자님이 공유한 캘린더')).toBeTruthy();
  expect(screen.getByText('2028년 8월')).toBeTruthy();
  expect(screen.getByLabelText('2028-08-09')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '다음 달' }));
  expect(screen.getByText('2028년 9월')).toBeTruthy();
  await fireEvent.press(screen.getByRole('button', { name: '이전 달' }));
  expect(screen.getByText('2028년 8월')).toBeTruthy();
  await fireEvent.press(screen.getByText('내 캘린더에 추가'));
  await waitFor(() => expect(subscribe.mock.calls[0]?.[0]).toBe('share-two'));
  await fireEvent.press(screen.getByText('첫 번째 소유자'));
  expect(screen.getByText('2027년 2월')).toBeTruthy();
});
