import { screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { StyleSheet } from 'react-native';
import { RecordScreen } from '../features/progress/record';
import { TimetableScreen } from '../features/calendar/screens';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'https://api.example' } }));
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

const lesson = (id: string, startTime: string, endTime: string) => ({
  _id: id,
  subjectName: id,
  days: [1],
  startTime,
  endTime,
  location: '',
  color: '#abcdef',
  source: 'manual' as const,
});
const timetable = (...classes: ReturnType<typeof lesson>[]) =>
  jest
    .spyOn(api.timetable, 'get')
    .mockResolvedValue({ _id: 't', updatedAt: '2026-11-01T00:00:00.000Z', classes });
/** 글자에서 위로 올라가 위치가 지정된 블록의 스타일을 찾는다 */
const blockStyle = (node: ReturnType<typeof screen.getByText>) => {
  let block: typeof node | null = node;
  while (block && StyleSheet.flatten(block.props.style)?.left === undefined) block = block.parent;
  if (!block) throw new Error('블록을 찾지 못했습니다');
  return StyleSheet.flatten(block.props.style);
};

it('시간표 맨 아래의 짧은 수업도 그려지는 위치가 겹치면 나란히 놓는다', async () => {
  timetable(lesson('앞 수업', '23:57', '23:58'), lesson('뒤 수업', '23:58', '23:59'));
  setParams({});
  await renderScreen(<TimetableScreen />, qc);
  const first = blockStyle(await screen.findByText('앞 수업'));
  const second = blockStyle(screen.getByText('뒤 수업'));
  expect(first.top).toBe(second.top);
  expect(first.left).not.toBe(second.left);
  expect(first.width).toBe('50%');
});

it('시간표에서 겹치지 않는 수업은 한 칸을 그대로 쓴다', async () => {
  timetable(lesson('오전', '09:00', '10:00'), lesson('오후', '13:00', '14:00'));
  setParams({});
  await renderScreen(<TimetableScreen />, qc);
  expect(blockStyle(await screen.findByText('오전')).width).toBe('100%');
  expect(blockStyle(screen.getByText('오후')).width).toBe('100%');
});

it('주간 기록에서 같은 시간의 수업과 스터디룸 교시가 서로 가리지 않는다', async () => {
  timetable(lesson('월요 수업', '09:00', '10:00'));
  const room = await api.rooms.get('lane-room');
  jest.spyOn(api.rooms, 'mine').mockResolvedValue([
    {
      ...room,
      title: '겹침 스터디',
      timerRule: {
        enabled: true,
        type: 'period',
        focusMin: 50,
        breakMin: 10,
        repeat: 4,
        periods: [{ start: '09:00', end: '10:00', label: '1교시' }],
      },
    },
  ]);
  setParams({ mode: '주간' });
  await renderScreen(<RecordScreen />, qc);
  const lessonBlock = blockStyle(await screen.findByText('월요 수업'));
  const roomBlocks = (await screen.findAllByText('스터디룸 · 겹침 스터디 · 1교시')).map(blockStyle);
  expect(lessonBlock.width).toBe('50%');
  expect(roomBlocks.filter((b) => b.width === '50%' && b.left !== lessonBlock.left)).toHaveLength(
    1,
  );
});
