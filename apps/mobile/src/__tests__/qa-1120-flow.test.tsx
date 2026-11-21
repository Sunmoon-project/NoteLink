import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { QueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { Avatar, initial } from '../components/ui';
import { QuizSolveScreen } from '../features/quiz/quiz';
import { TimerScreen } from '../features/studyroom/tools';
import { useAuth } from '../stores/auth';
import { useQuizProgress } from '../stores/quiz-progress';
import { renderScreen, setParams } from '../test-utils';

// develop 점검(2026-11-20) #5 시간 규칙 읽기 전용 · #6 원 글자 · #8 풀이 화면 닫기
const mockApi = {
  rooms: { get: jest.fn(), schedule: jest.fn(), setTimer: jest.fn() },
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
jest.mock('../lib/socket', () => ({ socket: { emit: jest.fn(), on: () => () => {} } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-calendar', () => ({}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn(async () => {}) }));
jest.mock('expo-audio', () => ({ setAudioModeAsync: jest.fn(async () => {}) }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

const rule = {
  enabled: true,
  type: 'pomodoro',
  focusMin: 50,
  breakMin: 10,
  repeat: 4,
  periods: [{ start: '09:00', end: '09:50', label: '1교시' }],
};
const room = { _id: 'r1', title: '방', hostId: 'host', members: [], timerRule: rule };

beforeEach(() => {
  jest.clearAllMocks();
  setParams({ id: 'r1' });
  mockApi.rooms.get.mockResolvedValue(room);
});

describe('#5 방 시간 규칙', () => {
  it('방장이 아니면 위에 「방장만 바꿀 수 있어요」 한 줄과 읽기 전용(켜기 · 유형 · 프리셋 · 분 · 교시 못 바꿈)', async () => {
    useAuth.setState({ userId: 'member' });
    await renderScreen(<TimerScreen />);
    expect(await screen.findByText('방장만 바꿀 수 있어요')).toBeTruthy();
    expect(screen.getByLabelText('방 시간 규칙').props.disabled).toBe(true);
    // 바꾼 것처럼 보였다가 저장이 안 되는 일이 없게, 입력이 바뀌지 않는다
    await fireEvent.press(screen.getByText('교시제'));
    await fireEvent.press(screen.getByText('25 / 5'));
    expect(screen.getByText('집중 50분 → 휴식 10분 × 4회 · 총 240분')).toBeTruthy();
    expect(screen.getByDisplayValue('50').props.editable).toBe(false);
    await fireEvent.press(screen.getByLabelText('1교시'));
    expect(screen.queryByText('시간표 편집')).toBeNull();
    expect(screen.queryByText('교시 편집')).toBeNull();
    expect(screen.queryByText('저장하기')).toBeNull();
    expect(mockApi.rooms.setTimer).not.toHaveBeenCalled();
  });

  it('부제는 「방장이 정하면 모두에게 적용돼요」', async () => {
    useAuth.setState({ userId: 'host' });
    await renderScreen(<TimerScreen />);
    expect(await screen.findByText('방장이 정하면 모두에게 적용돼요')).toBeTruthy();
    expect(screen.queryByText('방장 전용 · 멤버 전원')).toBeNull();
    expect(screen.getByLabelText('방 시간 규칙').props.disabled).toBeFalsy();
  });
});

describe('#6 원 글자는 닉네임 첫 글자', () => {
  it.each([
    ['큐에이', '큐'],
    ['Tom', 'T'],
    ['😀하루', '😀'],
    ['', '?'],
  ])('initial(%s) → %s', (name, want) => expect(initial(name)).toBe(want));

  it('Avatar도 같은 첫 글자(전에는 뒤에서 둘째 글자 「에」)', async () => {
    await render(<Avatar name="큐에이" />);
    expect(screen.getByText('큐')).toBeTruthy();
  });
  // 시간표 멤버 점(tools.tsx MemberDot)도 같은 initial을 import해 쓴다
});

describe('#8 퀴즈 풀이 닫기', () => {
  const qc = () =>
    new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
  beforeEach(() => {
    useQuizProgress.getState().reset();
    setParams({ setId: 's1' });
    useAuth.setState({ userId: 'me' });
    mockApi.quiz.set.mockResolvedValue({
      _id: 's1',
      questionCount: 1,
      questions: [
        { _id: 'q1', type: 'multiple_choice', prompt: '문제', choices: ['가', '나'], answer: '가' },
      ],
    });
    mockApi.quiz.startAttempt.mockResolvedValue({ _id: 'a1' });
  });
  afterEach(() => useQuizProgress.getState().reset());

  it('위의 닫기(X)는 확인을 거쳐 나가고, 푼 데까지는 지우지 않는다', async () => {
    await renderScreen(<QuizSolveScreen />, qc());
    await fireEvent.press(await screen.findByRole('button', { name: '풀이 닫기' }));
    expect(screen.getByText('그만 풀까요?')).toBeTruthy();
    expect(router.back).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByText('계속 풀기'));
    expect(router.back).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: '풀이 닫기' }));
    await fireEvent.press(screen.getByText('그만 풀기'));
    expect(router.back).toHaveBeenCalled();
    // 같은 풀이는 퀴즈 탭에서 이어 풀 수 있게 진행이 남아 있다
    await waitFor(() => expect(useQuizProgress.getState().progress?.setId).toBe('s1'));
  });

  it('스터디룸에서 왔으면 닫기 대신 「스터디룸으로」 하나만 있고 같은 확인을 거친다', async () => {
    setParams({ setId: 's1', from: 'room' });
    await renderScreen(<QuizSolveScreen />, qc());
    await fireEvent.press(await screen.findByText('스터디룸으로'));
    expect(screen.queryByRole('button', { name: '풀이 닫기' })).toBeNull();
    expect(screen.getByText('그만 풀까요?')).toBeTruthy();
    await fireEvent.press(screen.getByText('그만 풀기'));
    expect(router.back).toHaveBeenCalled();
  });
});
