import { fireEvent, screen } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { StyleSheet } from 'react-native';
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
