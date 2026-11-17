import { act, fireEvent, renderHook, screen, waitFor } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { TodayReviewCard, useTodayReview } from '../features/quiz/today-review';
import { loadWrong, recordWrong, useDailyWrongReview } from '../features/quiz/wrong-review';
import { useTour } from '../features/tutor/tour';
import { queryClient } from '../lib/query';
import { useAuth } from '../stores/auth';
import { renderScreen } from '../test-utils';

const mockApi = { quiz: { today: jest.fn(), startToday: jest.fn() } };
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
}));
jest.mock('../lib/env', () => ({ env: { localData: false, apiUrl: 'http://api' } }));
const mockFiles = new Map<string, string>();
jest.mock('../lib/local/storage', () => ({
  readDb: (n: string) => (mockFiles.has(n) ? JSON.parse(mockFiles.get(n)!) : null),
  writeDb: (n: string, d: unknown) => mockFiles.set(n, JSON.stringify(d)),
  dropDb: (n: string) => mockFiles.delete(n),
  keepFile: (uri: string) => ({ uri, size: 0 }),
}));

const set = (status: 'generating' | 'ready' | 'failed') => ({
  _id: 't1',
  materialId: '',
  folderId: '',
  sourceSetId: null,
  title: '오늘의 복습 · 11-16',
  status,
  progress: 40,
  questionCount: status === 'ready' ? 3 : 0,
  questions: [],
  createdAt: '2026-11-16T00:00:00.000Z',
});
const question = {
  _id: 'a',
  order: 0,
  type: 'multiple_choice' as const,
  prompt: '문제',
  choices: ['가', '나'],
  answer: '가',
  explanation: null,
  conceptTags: [],
};

beforeEach(() => {
  mockFiles.clear();
  mockApi.quiz.today.mockReset();
  mockApi.quiz.startToday.mockReset();
  useAuth.setState({ userId: 'u1' });
  useTour.setState({ step: -1 });
  jest.mocked(router.push).mockClear();
});

describe('하루에 처음 열 때 서버 오늘의 복습', () => {
  it('서버가 만들면 기기 오답 복습을 띄우지 않고 오늘의 복습을 다시 읽는다', async () => {
    jest.useFakeTimers();
    try {
      recordWrong('u1', question);
      mockApi.quiz.startToday.mockResolvedValue(set('generating'));
      const refetch = jest.spyOn(queryClient, 'invalidateQueries');
      await renderHook(() => useDailyWrongReview(true));
      await act(async () => jest.advanceTimersByTime(700));
      expect(mockApi.quiz.startToday).toHaveBeenCalledTimes(1);
      expect(refetch).toHaveBeenCalledWith({ queryKey: ['today-review'] });
      expect(router.push).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('서버가 만들지 못하면 기기 오답 노트로 복습한다', async () => {
    jest.useFakeTimers();
    try {
      recordWrong('u1', question);
      mockApi.quiz.startToday.mockRejectedValue(new Error('500'));
      await renderHook(() => useDailyWrongReview(true));
      await act(async () => jest.advanceTimersByTime(700));
      expect(router.push).toHaveBeenCalledWith('/play/wrong');
      expect(loadWrong('u1').shownOn).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });
});

it('만드는 중이면 2초마다 다시 읽고, 다 만들면 멈춘다', async () => {
  jest.useFakeTimers();
  try {
    mockApi.quiz.today.mockResolvedValueOnce(set('generating')).mockResolvedValueOnce(set('ready'));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = await renderHook(() => useTodayReview(), { wrapper });
    await act(async () => jest.advanceTimersByTime(0));
    expect(result.current.data?.status).toBe('generating');
    await act(async () => jest.advanceTimersByTime(2000));
    await waitFor(() => expect(result.current.data?.status).toBe('ready'));
    await act(async () => jest.advanceTimersByTime(10_000));
    expect(mockApi.quiz.today).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

describe('오늘의 복습 카드', () => {
  it('복습할 문제가 없으면(null) 그리지 않는다', async () => {
    mockApi.quiz.today.mockResolvedValue(null);
    await renderScreen(<TodayReviewCard />);
    await waitFor(() => expect(mockApi.quiz.today).toHaveBeenCalled());
    expect(screen.queryByText('오늘의 복습')).toBeNull();
  });

  it('처리기가 실패했으면 눌러서 다시 만든다', async () => {
    mockApi.quiz.today.mockResolvedValue(set('failed'));
    mockApi.quiz.startToday.mockResolvedValue(set('generating'));
    await renderScreen(<TodayReviewCard />);
    fireEvent.press(await screen.findByText('오늘의 복습을 만들지 못했어요'));
    await waitFor(() => expect(mockApi.quiz.startToday).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('복습할 문제를 모으고 있어요')).toBeTruthy();
  });

  it('다시 만들기도 실패하면 알리고 다시 누를 수 있다', async () => {
    mockApi.quiz.today.mockResolvedValue(set('failed'));
    mockApi.quiz.startToday.mockRejectedValue(new Error('500'));
    await renderScreen(<TodayReviewCard />);
    fireEvent.press(await screen.findByText('오늘의 복습을 만들지 못했어요'));
    expect(
      await screen.findByText('이번에도 못 만들었어요. 잠시 뒤 다시 눌러 주세요'),
    ).toBeTruthy();
  });

  it('다 만들었으면 눌러서 푼다', async () => {
    mockApi.quiz.today.mockResolvedValue(set('ready'));
    await renderScreen(<TodayReviewCard />);
    fireEvent.press(await screen.findByText('복습 날짜가 된 3문제 풀기'));
    expect(router.push).toHaveBeenCalledWith({ pathname: '/play/solve', params: { setId: 't1' } });
  });
});
