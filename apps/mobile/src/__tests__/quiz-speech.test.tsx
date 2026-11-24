import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { QuizSolveScreen } from '../features/quiz/quiz';
import { seedUser } from './fixtures/seed';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { useToast } from '../stores/toast';
import { renderScreen, setParams } from '../test-utils';

// 마지막 문제의 버튼은 「결과 보기」, 그 앞은 「다음 문제 풀기」
const NEXT_OR_DONE = /^(다음 문제 풀기|결과 보기)$/;

// 실기기 테스트: 퀴즈 「음성으로 듣기」를 눌러도 소리가 나지 않았다(아이폰 무음 스위치 · 오디오 설정)
const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => void mockStore.set(key, value)),
  deleteItemAsync: jest.fn(async (key: string) => void mockStore.delete(key)),
}));
const mockApi = {
  quiz: { set: jest.fn(), startAttempt: jest.fn(), answer: jest.fn(), finish: jest.fn() },
};
jest.mock('../lib/api', () => ({
  get api() {
    return mockApi;
  },
  ApiError: class ApiError extends Error {},
  NetworkError: class NetworkError extends Error {},
}));
jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('../lib/socket', () => ({ disconnectSocket: jest.fn(), socket: { emit: jest.fn() } }));
const mockSpeak = jest.fn();
const mockOrder: string[] = [];
jest.mock('expo-speech', () => ({
  speak: (...a: unknown[]) => {
    mockOrder.push('speak');
    mockSpeak(...a);
  },
  stop: jest.fn(async () => {}),
}));
let mockAudioGate: Promise<void> | null = null;
const mockAudioMode = jest.fn(async (_mode: unknown) => {
  mockOrder.push('audio');
  if (mockAudioGate) await mockAudioGate;
});
jest.mock('expo-audio', () => ({ setAudioModeAsync: (m: unknown) => mockAudioMode(m) }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

const setId = 'quiz-speech';
const quizSet = {
  _id: setId,
  questionCount: 2,
  questions: [
    {
      _id: 'first',
      type: 'multiple_choice',
      prompt: '중간 난이도 문제',
      choices: ['정답', '오답'],
      answer: '정답',
      difficulty: '중',
    },
    {
      _id: 'second',
      type: 'multiple_choice',
      prompt: '난이도가 없는 문제',
      choices: ['정답', '오답'],
      answer: '정답',
      difficulty: null,
    },
  ],
};

beforeEach(async () => {
  jest.clearAllMocks();
  mockStore.clear();
  useQuizProgress.getState().reset();
  setParams({ setId });
  mockApi.quiz.set.mockResolvedValue(quizSet);
  mockApi.quiz.startAttempt.mockResolvedValue({ _id: 'attempt-1' });
  mockApi.quiz.answer.mockResolvedValue({ correct: true, correctAnswer: '정답' });
  await useAuth
    .getState()
    .signIn({ accessToken: 'access', refreshToken: 'refresh' }, { ...seedUser(), _id: 'me' });
  await useAuth.getState().finishOnboarding();
});
afterEach(() => useQuizProgress.getState().reset());

const qc = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });

beforeEach(() => {
  mockOrder.length = 0;
  useToast.setState({ msg: null });
});

it('무음 모드에서도 들리게 오디오 설정을 먼저 바꾼 뒤 문제와 보기를 한국어로 읽는다', async () => {
  await renderScreen(<QuizSolveScreen />, qc());
  expect(await screen.findByText('중간 난이도 문제')).toBeTruthy();
  await fireEvent.press(screen.getByText('음성으로 듣기'));
  await waitFor(() => expect(mockSpeak).toHaveBeenCalled());
  expect(mockAudioMode).toHaveBeenCalledWith({ playsInSilentMode: true });
  expect(mockOrder).toEqual(['audio', 'speak']);
  expect(mockSpeak).toHaveBeenCalledWith(
    '중간 난이도 문제. 1번, 정답. 2번, 오답',
    expect.objectContaining({ language: 'ko-KR' }),
  );
  expect(screen.getByText('읽어주는 중… (탭해서 멈춤)')).toBeTruthy();
});

it('읽기에 실패하면 알리고 버튼을 되돌린다', async () => {
  await renderScreen(<QuizSolveScreen />, qc());
  expect(await screen.findByText('중간 난이도 문제')).toBeTruthy();
  await fireEvent.press(screen.getByText('음성으로 듣기'));
  await waitFor(() => expect(mockSpeak).toHaveBeenCalled());
  const options = mockSpeak.mock.calls[0]![1] as { onError: (e: Error) => void };
  await act(async () => options.onError(new Error('no voice')));
  expect(useToast.getState().msg).toBe('음성을 재생하지 못했어요. 기기 소리 설정을 확인해 주세요');
  expect(screen.getByText('음성으로 듣기')).toBeTruthy();
});

// Codex #507 리뷰: 오디오 설정을 기다리는 사이 멈추거나 화면을 떠나도 그 뒤에 읽기가 시작됐다
describe('읽기 준비 중 취소', () => {
  let release!: () => void;
  beforeEach(() => {
    mockAudioGate = new Promise<void>((r) => (release = r));
  });
  afterEach(() => {
    mockAudioGate = null;
  });

  it('준비 중에 멈추면 읽지 않는다', async () => {
    await renderScreen(<QuizSolveScreen />, qc());
    expect(await screen.findByText('중간 난이도 문제')).toBeTruthy();
    await fireEvent.press(screen.getByText('음성으로 듣기'));
    await fireEvent.press(screen.getByText('읽어주는 중… (탭해서 멈춤)'));
    await act(async () => release());
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(screen.getByText('음성으로 듣기')).toBeTruthy();
  });

  // Codex #507 재리뷰: 준비 중 답하고 다음 문제로 넘어가면 앞 문제를 읽었다
  it('준비 중에 다음 문제로 넘어가면 앞 문제를 읽지 않는다', async () => {
    await renderScreen(<QuizSolveScreen />, qc());
    expect(await screen.findByText('중간 난이도 문제')).toBeTruthy();
    await fireEvent.press(screen.getByText('음성으로 듣기'));
    await fireEvent.press(screen.getByText(/정답/));
    await fireEvent.press(await screen.findByText(NEXT_OR_DONE));
    expect(await screen.findByText('난이도가 없는 문제')).toBeTruthy();
    await act(async () => release());
    expect(mockSpeak).not.toHaveBeenCalled();
    expect(screen.getByText('음성으로 듣기')).toBeTruthy();
  });

  // Codex #507 재리뷰: 취소된 요청이 준비를 마친 뒤 멈추기를 불러 새로 시작한 읽기를 끊었다
  it('취소된 요청은 준비가 끝나도 멈추기를 부르지 않는다', async () => {
    const Speech = jest.requireMock('expo-speech') as { stop: jest.Mock };
    await renderScreen(<QuizSolveScreen />, qc());
    expect(await screen.findByText('중간 난이도 문제')).toBeTruthy();
    await fireEvent.press(screen.getByText('음성으로 듣기'));
    await fireEvent.press(screen.getByText('읽어주는 중… (탭해서 멈춤)'));
    const stops = Speech.stop.mock.calls.length;
    await act(async () => release());
    expect(Speech.stop.mock.calls.length).toBe(stops);
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('준비 중에 화면을 떠나면 읽지 않는다', async () => {
    const view = await renderScreen(<QuizSolveScreen />, qc());
    expect(await screen.findByText('중간 난이도 문제')).toBeTruthy();
    await fireEvent.press(screen.getByText('음성으로 듣기'));
    await view.unmount();
    await act(async () => release());
    expect(mockSpeak).not.toHaveBeenCalled();
  });
});
