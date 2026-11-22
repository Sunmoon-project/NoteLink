// ROOM-021: 내 시간표 요일이 월~금뿐이라 토 · 일 수업을 넣을 수 없었다(방 시간표 추천이 늘 주말로 갔다).
// 요일 번호는 서버와 같이 0=일 ... 6=토
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { TimetableScreen } from '../features/calendar/screens';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'https://api.example' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));

const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
beforeEach(() => setParams({}));
afterEach(() => {
  qc.clear();
  jest.restoreAllMocks();
});

const timetable = (days: number[]) => ({
  _id: 'weekend-timetable',
  updatedAt: '2026-11-01T00:00:00.000Z',
  classes: [
    {
      _id: 'weekend-class',
      subjectName: '주말 특강',
      days,
      startTime: '10:00',
      endTime: '12:00',
      location: '',
      color: '#abcdef',
      source: 'manual' as const,
    },
  ],
});

it('토 · 일 수업을 시간표 칸에 그리고, 눌러 보면 요일을 월요일부터 순서대로 적는다', async () => {
  jest.spyOn(api.timetable, 'get').mockResolvedValue(timetable([0, 6, 1]));
  await renderScreen(<TimetableScreen />, qc);
  // 월 · 토 · 일 세 칸
  expect(await screen.findAllByText('주말 특강')).toHaveLength(3);
  for (const d of ['월', '화', '수', '목', '금', '토', '일'])
    expect(screen.getByText(d)).toBeTruthy();
  await fireEvent.press(screen.getAllByText('주말 특강')[0]!);
  expect(await screen.findByText(/월 · 토 · 일 · 10:00 – 12:00/)).toBeTruthy();
});

it('수업 추가에서 토 · 일을 고르면 서버 번호(6 · 0)로 보낸다', async () => {
  jest.spyOn(api.timetable, 'get').mockResolvedValue({ ...timetable([1]), classes: [] });
  const add = jest.spyOn(api.timetable, 'addClass');
  await renderScreen(<TimetableScreen />, qc);
  await fireEvent.press(await screen.findByText('+ 수업 추가'));
  await fireEvent.changeText(screen.getByPlaceholderText('예) 수학'), '주말 특강');
  await fireEvent.changeText(screen.getByPlaceholderText('10:00'), '10:00');
  await fireEvent.changeText(screen.getByPlaceholderText('11:30'), '12:00');
  // 위 시간표 머리글에도 같은 글자가 있어 시트(뒤에 그림)의 버튼을 누른다
  await fireEvent.press(screen.getAllByText('토').at(-1)!);
  await fireEvent.press(screen.getAllByText('일').at(-1)!);
  await fireEvent.press(screen.getByText('추가하기'));
  await waitFor(() => expect(add).toHaveBeenCalledTimes(1));
  expect([...add.mock.calls[0]![0].days].sort()).toEqual([0, 6]);
});
