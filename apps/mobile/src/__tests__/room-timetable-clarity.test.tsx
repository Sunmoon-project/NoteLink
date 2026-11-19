import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import * as Calendar from 'expo-calendar';
import { ScheduleScreen } from '../features/studyroom/tools';
import { renderScreen, setParams } from '../test-utils';

const mockApi = { rooms: { get: jest.fn(), schedule: jest.fn() } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-calendar', () => ({
  requestCalendarPermissionsAsync: jest.fn(async () => ({ granted: true })),
  createEventInCalendarAsync: jest.fn(async () => ({ action: 'saved' })),
}));

// 월 9시 = 노트(제목 공개) · 구글(제목 비공개) 겹침, 월 10시 = 노트만, 월 11시 = 아무도 없음(모두 빔)
const schedule = {
  members: [
    {
      id: 'u1',
      nickname: '노트',
      emoji: '✏️',
      blocks: [{ day: 0, start: '09:00', end: '11:00', title: '자료구조' }],
    },
    {
      id: 'u2',
      nickname: '구글',
      emoji: '✏️',
      blocks: [{ day: 0, start: '09:30', end: '10:00', title: null }],
    },
    { id: 'u3', nickname: '한결', emoji: '✏️', blocks: [] },
  ],
  startHour: 9,
  grid: [
    [1, 2, 2, 2, 2, 2, 2],
    [1, 2, 2, 2, 2, 2, 2],
    [2, 2, 2, 2, 2, 2, 2],
  ],
  matches: [{ day: '화요일', label: '화요일 09:00부터', start: '09:00', end: '12:00', best: true }],
};

beforeEach(() => {
  jest.clearAllMocks();
  setParams({ id: 'r1' });
  mockApi.rooms.get.mockResolvedValue({ _id: 'r1', title: '방' });
  mockApi.rooms.schedule.mockResolvedValue(schedule);
});

it('화면 설명과 멤버 범례를 보여 주고, 아무도 없는 칸은 비워 둔다', async () => {
  await renderScreen(<ScheduleScreen />);
  expect(await screen.findByText(/칸을 누르면/)).toBeTruthy();
  for (const n of ['노트', '구글', '한결']) expect(screen.getByLabelText(`범례 ${n}`)).toBeTruthy();
  const empty = screen.getByLabelText('월 11:00 · 모두 비어 있음');
  expect(within(empty).queryByText(/./)).toBeNull();
  // 혼자 있는 칸은 그 사람 이니셜, 겹친 칸은 두 사람 이니셜
  expect(within(screen.getByLabelText('월 10:00 · 노트')).getByText('노')).toBeTruthy();
  const both = screen.getByLabelText('월 9:00 · 노트, 구글');
  expect(within(both).getByText('노')).toBeTruthy();
  expect(within(both).getByText('구')).toBeTruthy();
});

it('칸을 누르면 멤버마다 시간표에 적은 내용을 보여 주고, 비공개 제목은 「수업 있음」으로 가린다', async () => {
  await renderScreen(<ScheduleScreen />);
  fireEvent.press(await screen.findByLabelText('월 9:00 · 노트, 구글'));
  expect(await screen.findByText('월요일 9:00 – 10:00')).toBeTruthy();
  expect(screen.getByText('자료구조 · 09:00–11:00')).toBeTruthy();
  expect(screen.getByText('수업 있음 · 09:30–10:00')).toBeTruthy();
  expect(screen.getByText('비어 있음')).toBeTruthy();
  expect(screen.queryByText('기기 캘린더에 추가')).toBeNull();
});

it('모두 비는 칸을 누르면 시트에서 기기 캘린더에 추가할 수 있다', async () => {
  await renderScreen(<ScheduleScreen />);
  fireEvent.press(await screen.findByLabelText('월 11:00 · 모두 비어 있음'));
  fireEvent.press(await screen.findByText('기기 캘린더에 추가'));
  await waitFor(() => expect(Calendar.createEventInCalendarAsync).toHaveBeenCalledTimes(1));
});

it('예전 서버(멤버별 일정 없음)면 바쁜 칸을 한 가지 색으로만 칠한다', async () => {
  mockApi.rooms.schedule.mockResolvedValue({
    ...schedule,
    members: schedule.members.map(({ nickname, emoji }) => ({ nickname, emoji })),
  });
  await renderScreen(<ScheduleScreen />);
  expect(await screen.findByLabelText('월 9:00 · 누군가 일정 있음')).toBeTruthy();
});
