import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as SecureStore from 'expo-secure-store';
import {
  CalSharedScreen,
  HolidayScreen,
  TimetableScreen,
  CalShareScreen,
} from '../features/calendar/screens';
import { RepeatGoalScreen } from '../features/progress/goals';
import { AddTodoSheet, TodoSheet } from '../features/calendar/todo';
import { RecordScreen } from '../features/progress/record';
import { api } from '../lib/api';
import { useToast } from '../stores/toast';
import { today } from '../lib/dates';
import { useAuth } from '../stores/auth';
import { renderScreen, setParams } from '../test-utils';

const mockStored = new Map<string, string>();
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'https://api.example' } }));
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
  useToast.getState().hide();
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

it('직접 입력한 할일 시각은 저장 후 다시 조회해도 유지된다', async () => {
  const item = await api.calendar.addTodo({
    dueDate: publicDay,
    content: '시간 보존',
    todoType: 'general',
    timeSlot: 'custom',
    dueTime: '09:35',
    subjectName: null,
  });
  expect((await api.calendar.todos(publicDay)).find((x) => x._id === item._id)?.dueTime).toBe(
    '09:35',
  );
});
it('두 번째 반복 목표도 기록에서 편집할 수 있다', async () => {
  jest.spyOn(api.study, 'recurringGoals').mockResolvedValue([
    { _id: 'one', name: '첫 목표', streak: 1, days: [1], targetMin: 30 },
    { _id: 'two', name: '둘째 목표', streak: 2, days: [2], targetMin: 30 },
  ] as never);
  await renderScreen(<RecordScreen />, client());
  await fireEvent.press(await screen.findByText('둘째 목표 · 연속 2일째'));
  expect(router.push).toHaveBeenCalledWith({ pathname: '/repeat', params: { id: 'two' } });
});
it('시간표는 이른 아침과 늦은 밤 수업도 그리드 안에 배치한다', async () => {
  jest.spyOn(api.timetable, 'get').mockResolvedValue({
    _id: 'tt',
    updatedAt: '',
    classes: [
      {
        _id: 'early',
        subjectName: '새벽 수업',
        days: [1],
        startTime: '07:00',
        endTime: '08:00',
        location: '',
        color: '#fff',
        source: 'manual',
      },
      {
        _id: 'late',
        subjectName: '밤 수업',
        days: [2],
        startTime: '22:00',
        endTime: '23:00',
        location: '',
        color: '#fff',
        source: 'manual',
      },
    ],
  });
  await renderScreen(<TimetableScreen />, client());
  await screen.findByText('새벽 수업');
  expect(screen.getByText('07')).toBeTruthy();
  expect(screen.getByText('22')).toBeTruthy();
});
it('캘린더 링크 생성 값과 결과·폐기 후 재조회를 검증한다', async () => {
  let shares: Awaited<ReturnType<typeof api.calendar.shares>> = [];
  const get = jest.spyOn(api.calendar, 'shares').mockImplementation(async () => shares);
  const create = jest.spyOn(api.calendar, 'createShare').mockImplementation(async () => {
    shares = [
      {
        _id: 'new-share',
        rangeStart: publicDay,
        rangeEnd: customDay,
        createdAt: new Date().toISOString(),
        token: 'new-share-token',
        ownerId: 'me',
        scopes: ['todos', 'study'],
        expiresAt: null,
        revokedAt: null,
        subscribers: [],
      },
    ];
    return { ...shares[0]!, url: 'notelink.test/new-share' };
  });
  const revoke = jest.spyOn(api.calendar, 'revokeShare').mockImplementation(async () => {
    shares = [];
  });
  await renderScreen(<CalShareScreen />, client());
  await fireEvent.press(screen.getByText('7일'));
  await fireEvent.press(screen.getByText('공유 링크 생성'));
  await screen.findByText('notelink.test/new-share');
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({
      expiresInDays: 7,
      rangeStart: expect.stringMatching(/^\d{4}-\d{2}-01$/),
      rangeEnd: expect.any(String),
    }),
  );
  await fireEvent.press(await screen.findByText('삭제'));
  await waitFor(() => expect(revoke.mock.calls[0]?.[0]).toBe('new-share'));
  await waitFor(() => expect(screen.queryByText('삭제')).toBeNull());
  expect(screen.queryByText('notelink.test/new-share')).toBeNull();
  expect(screen.queryByText('복사')).toBeNull();
  expect(screen.queryByText('카카오톡으로 공유')).toBeNull();
  expect(get.mock.calls.length).toBeGreaterThan(1);
});
it('캘린더 링크 생성 실패를 안내하고 다시 시도할 수 있다', async () => {
  const create = jest.spyOn(api.calendar, 'createShare').mockRejectedValue(new Error('offline'));
  await renderScreen(<CalShareScreen />, client());
  await fireEvent.press(screen.getByText('공유 링크 생성'));
  await waitFor(() => expect(create).toHaveBeenCalled());
  await waitFor(() => expect(useToast.getState().msg).toMatch(/생성.*못/));
});

it.each([
  [0, '오전 12시'],
  [9, '오전 9시'],
  [12, '오후 12시'],
  [21, '오후 9시'],
] as const)('주요 공부 시간 %s시를 올바르게 표시한다', async (peakHour, label) => {
  const data = await api.study.stats('all');
  jest.spyOn(api.study, 'stats').mockResolvedValue({ ...data, peakHour });
  await renderScreen(<RecordScreen />, client());
  expect(await screen.findByText(label)).toBeTruthy();
});
it('공부 기록이 없어 주요 공부 시간이 -1이면 -로 표시한다', async () => {
  const data = await api.study.stats('all');
  jest.spyOn(api.study, 'stats').mockResolvedValue({ ...data, peakHour: -1 });
  await renderScreen(<RecordScreen />, client());
  expect(await screen.findByText('주로 공부한 시간')).toBeTruthy();
  expect(screen.queryByText(/오[전후] -?\d+시/)).toBeNull();
});
it('주간 보기도 07시와 23시 수업을 시간 범위 안에 표시한다', async () => {
  jest.spyOn(api.timetable, 'get').mockResolvedValue({
    _id: 'tt',
    updatedAt: '',
    classes: [
      {
        _id: 'early',
        subjectName: '주간 아침',
        days: [1],
        startTime: '07:00',
        endTime: '08:00',
        location: '',
        color: '#fff',
        source: 'manual',
      },
      {
        _id: 'late',
        subjectName: '주간 밤',
        days: [2],
        startTime: '23:00',
        endTime: '23:59',
        location: '',
        color: '#fff',
        source: 'manual',
      },
    ],
  });
  setParams({ mode: '주간' });
  await renderScreen(<RecordScreen />, client());
  await screen.findByText('주간 아침');
  expect(screen.getByText('07시')).toBeTruthy();
  expect(screen.getByText('23시')).toBeTruthy();
});

it('화면에서 직접 입력한 시각은 할 일 목록을 다시 열어도 표시된다', async () => {
  const close = jest.fn();
  const view = await renderScreen(<AddTodoSheet open date={publicDay} onClose={close} />, client());
  await fireEvent.changeText(
    screen.getByPlaceholderText('수학 워크북 3단원 제출'),
    '직접 시각 화면 검증',
  );
  await fireEvent.press(screen.getByText('직접 입력'));
  await fireEvent.changeText(screen.getByPlaceholderText('HH:MM (24시간)'), '09:35');
  await fireEvent.press(screen.getByText('추가하기'));
  await waitFor(() => expect(close).toHaveBeenCalled());
  await view.unmount();
  await renderScreen(
    <TodoSheet open date={publicDay} onClose={jest.fn()} onAdd={jest.fn()} />,
    client(),
  );
  await screen.findByText('직접 시각 화면 검증');
  expect(screen.getAllByText('일반 · 09:35').length).toBeGreaterThan(0);
});

// 시트 본문은 스크롤 영역이라 첫 줄에 음수 여백을 주면 윗부분이 잘리고, 줄이 남은 폭을 넘으면 오른쪽이 잘린다
it('할 일 시트의 안내 문구와 긴 할 일이 잘리지 않게 배치된다', async () => {
  const view = await renderScreen(
    <AddTodoSheet open date={publicDay} onClose={jest.fn()} />,
    client(),
  );
  const guide = screen.getByText('과제 · 시험으로 고르면 홈 화면에 D-day로 표시돼요');
  expect(String(guide.props.className)).not.toMatch(/(^|\s)-m[ty]-/);
  await view.unmount();
  const long = '아주 긴 할 일 이름이 한 줄을 넘어가도 시트 오른쪽 밖으로 잘리지 않아야 한다';
  await api.calendar.addTodo({
    content: long,
    todoType: 'general',
    dueDate: publicDay,
    timeSlot: 'none',
    subjectName: null,
  });
  await renderScreen(
    <TodoSheet open date={publicDay} onClose={jest.fn()} onAdd={jest.fn()} />,
    client(),
  );
  // 글을 감싼 칸(가로 줄 바로 안쪽)이 남은 폭을 차지해야 줄이 바뀐다
  let box = (await screen.findByText(long)).parent;
  while (box?.parent && !String(box.parent.props.className).includes('flex-row')) box = box.parent;
  expect(String(box?.props.className)).toMatch(/\bflex-1\b/);
});

function sharedCalendar(id: string): Awaited<ReturnType<typeof api.calendar.createShare>> {
  return {
    _id: id,
    token: id,
    ownerId: 'me',
    rangeStart: publicDay,
    rangeEnd: customDay,
    scopes: ['todos'],
    expiresAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    subscribers: [],
    url: `notelink.test/${id}`,
  };
}
it('링크 폐기 실패는 목록·현재 링크를 보존하고 같은 링크로 다시 시도할 수 있다', async () => {
  const created = sharedCalendar('revoke-retry');
  let shares = [created];
  jest.spyOn(api.calendar, 'shares').mockImplementation(async () => shares);
  jest.spyOn(api.calendar, 'createShare').mockResolvedValue(created);
  const revoke = jest
    .spyOn(api.calendar, 'revokeShare')
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementation(async () => {
      shares = [];
    });
  await renderScreen(<CalShareScreen />, client());
  await fireEvent.press(screen.getByText('공유 링크 생성'));
  await screen.findByText(created.url);
  await fireEvent.press(screen.getByText('삭제'));
  await waitFor(() => expect(useToast.getState().msg).toMatch(/삭제.*못/));
  expect(screen.getByText(created.url)).toBeTruthy();
  await waitFor(() => {
    expect(screen.getByText('복사')).toBeEnabled();
    expect(screen.getByText('삭제')).toBeEnabled();
  });
  await fireEvent.press(screen.getByText('삭제'));
  await waitFor(() => expect(screen.queryByText(created.url)).toBeNull());
  expect(revoke.mock.calls.map(([id]) => id)).toEqual([created._id, created._id]);
});
it('이전 링크 폐기 응답이 늦게 와도 새로 생성한 링크를 지우지 않는다', async () => {
  const first = sharedCalendar('older-link'),
    second = sharedCalendar('newer-link');
  let shares: (typeof first)[] = [];
  jest.spyOn(api.calendar, 'shares').mockImplementation(async () => shares);
  jest.spyOn(api.calendar, 'createShare').mockImplementation(async () => {
    const result = shares.length ? second : first;
    shares = [...shares, result];
    return result;
  });
  let complete!: () => void;
  const pending = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const revoke = jest.spyOn(api.calendar, 'revokeShare').mockImplementation(async (id) => {
    await pending;
    shares = shares.filter((s) => s._id !== id);
  });
  const view = await renderScreen(<CalShareScreen />, client());
  try {
    await fireEvent.press(screen.getByText('공유 링크 생성'));
    await screen.findByText(first.url);
    await fireEvent.press(await screen.findByText('삭제'));
    await waitFor(() => expect(revoke.mock.calls[0]?.[0]).toBe(first._id));
    await waitFor(() => expect(screen.getByText('복사')).toBeDisabled());
    await fireEvent.press(screen.getByText('공유 링크 생성'));
    await screen.findByText(second.url);
    await act(async () => complete());
    await waitFor(() => expect(screen.getAllByText('삭제')).toHaveLength(1));
    expect(screen.getByText(second.url)).toBeTruthy();
    expect(screen.getByText('복사')).toBeEnabled();
  } finally {
    complete();
    await view.unmount();
  }
});
it('공유 목록 조회 실패는 빈 목록 대신 오류와 재시도를 제공한다', async () => {
  const shares = jest
    .spyOn(api.calendar, 'shares')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([sharedCalendar('loaded-after-retry')]);
  await renderScreen(<CalShareScreen />, client());
  await screen.findByText('공유 목록을 불러오지 못했어요');
  await fireEvent.press(screen.getByRole('button', { name: '공유 목록 다시 시도' }));
  await screen.findByText('삭제');
  expect(shares).toHaveBeenCalledTimes(2);
});
