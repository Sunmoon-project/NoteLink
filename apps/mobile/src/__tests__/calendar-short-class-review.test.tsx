import { fireEvent, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { StyleSheet } from 'react-native';
import { RecordScreen } from '../features/progress/record';
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
afterEach(() => {
  qc.clear();
  jest.restoreAllMocks();
});

it('1분 수업도 양수 높이의 블록으로 표시하고 눌러 삭제 패널을 열 수 있다', async () => {
  jest.spyOn(api.timetable, 'get').mockResolvedValue({
    _id: 'short-class-timetable',
    updatedAt: '2026-11-01T00:00:00.000Z',
    classes: [
      {
        _id: 'one-minute-class',
        subjectName: '1분 수업',
        days: [1],
        startTime: '10:00',
        endTime: '10:01',
        location: '온라인',
        color: '#abcdef',
        source: 'manual',
      },
    ],
  });
  setParams({});
  await renderScreen(<TimetableScreen />, qc);
  const title = await screen.findByText('1분 수업');
  let block: typeof title | null = title;
  while (block && typeof StyleSheet.flatten(block.props.style)?.height !== 'number')
    block = block.parent;
  expect(block).not.toBeNull();
  if (!block) throw new Error('수업 블록의 높이를 찾지 못했습니다');
  expect(StyleSheet.flatten(block.props.style).height).toBeGreaterThan(0);
  await fireEvent.press(title);
  expect(await screen.findByRole('button', { name: '수업 삭제' })).toBeTruthy();
});

it.each(['시간표', '주간'])('%s의 마지막 1분 수업 전체가 격자 안에 배치된다', async (mode) => {
  jest.spyOn(api.timetable, 'get').mockResolvedValue({
    _id: 'late',
    updatedAt: '',
    classes: [
      {
        _id: 'last',
        subjectName: '마지막 1분',
        days: [1],
        startTime: '23:58',
        endTime: '23:59',
        location: '',
        color: '#abc',
        source: 'manual',
      },
      {
        _id: 'first',
        subjectName: '새벽 1분',
        days: [2],
        startTime: '00:00',
        endTime: '00:01',
        location: '',
        color: '#def',
        source: 'manual',
      },
    ],
  });
  jest.spyOn(api.rooms, 'mine').mockResolvedValue([]);
  setParams({ mode: '주간' });
  await renderScreen(mode === '시간표' ? <TimetableScreen /> : <RecordScreen />, qc);
  for (const label of ['마지막 1분', '새벽 1분']) {
    let block: ReturnType<typeof screen.getByText> | null = await screen.findByText(label);
    while (block && typeof StyleSheet.flatten(block.props.style)?.top !== 'number')
      block = block.parent;
    if (!block) throw new Error('블록 없음');
    const style = StyleSheet.flatten(block.props.style);
    let grid = block.parent;
    while (grid && typeof StyleSheet.flatten(grid.props.style)?.height !== 'number')
      grid = grid.parent;
    if (!grid) throw new Error('격자 없음');
    expect(style.top).toBeGreaterThanOrEqual(0);
    expect(style.height).toBeGreaterThan(0);
    expect(style.top + style.height).toBeLessThanOrEqual(
      StyleSheet.flatten(grid.props.style).height,
    );
  }
});

it('주간 기록은 가입한 스터디룸의 교시 일정을 실제 규칙으로 표시한다', async () => {
  const room = await api.rooms.get('calendar-room');
  jest.spyOn(api.rooms, 'mine').mockResolvedValue([
    {
      ...room,
      title: '실제 야간 스터디',
      timerRule: {
        enabled: true,
        type: 'period',
        focusMin: 50,
        breakMin: 10,
        repeat: 4,
        periods: [{ start: '23:58', end: '23:59', label: '마지막 교시' }],
      },
    },
  ]);
  setParams({ mode: '주간' });
  await renderScreen(<RecordScreen />, qc);
  expect(await screen.findAllByText('스터디룸 · 실제 야간 스터디 · 마지막 교시')).toHaveLength(7);
});

it('스터디룸 일정 조회 실패는 안내하고 사용자가 다시 요청하면 일정을 복구한다', async () => {
  const room = await api.rooms.get('retry-calendar-room');
  const mine = jest
    .spyOn(api.rooms, 'mine')
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue([
      {
        ...room,
        title: '재조회 스터디',
        timerRule: {
          enabled: true,
          type: 'period',
          focusMin: 50,
          breakMin: 10,
          repeat: 4,
          periods: [{ start: '18:00', end: '19:00', label: '복구한 교시' }],
        },
      },
    ]);
  setParams({ mode: '주간' });
  await renderScreen(<RecordScreen />, qc);
  await screen.findByText('스터디룸 일정을 불러오지 못했어요');
  expect(screen.queryByText('스터디룸 · 재조회 스터디 · 복구한 교시')).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '일정 다시 시도' }));
  expect(await screen.findAllByText('스터디룸 · 재조회 스터디 · 복구한 교시')).toHaveLength(7);
  expect(mine).toHaveBeenCalledTimes(2);
});
