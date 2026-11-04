import { router } from 'expo-router';
import { act, fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { QuizSolveScreen } from '../features/quiz/quiz';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { useMock: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-speech', () => ({ speak: jest.fn(), stop: jest.fn() }));
jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(),
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

afterEach(() => jest.restoreAllMocks());

it('마지막 문제 완료 요청 중 다시 눌러도 완료를 한 번만 제출한다', async () => {
  const original = await api.quiz.set('qs1');
  const question = original.questions[0]!;
  const attempt = await api.quiz.startAttempt(original._id);
  jest.spyOn(api.quiz, 'startAttempt').mockResolvedValue(attempt);
  jest.spyOn(api.quiz, 'answer').mockResolvedValue({
    correct: true,
    correctAnswer: question.answer,
  });
  jest.spyOn(api.quiz, 'set').mockResolvedValue({
    ...original,
    questions: [question],
    questionCount: 1,
  });
  let complete!: (result: { pointsEarned: number; balance: number }) => void;
  const pending = new Promise<{ pointsEarned: number; balance: number }>((resolve) => {
    complete = resolve;
  });
  const finish = jest.spyOn(api.quiz, 'finish').mockReturnValue(pending);
  setParams({ setId: original._id });
  await renderScreen(<QuizSolveScreen />);
  await fireEvent.press(await screen.findByText(`① ${question.answer}`));
  const next = await screen.findByRole('button', { name: '다음 문제 풀기' });
  const user = userEvent.setup();
  try {
    await user.press(next);
    await user.press(next);
    await waitFor(() => expect(finish).toHaveBeenCalledTimes(1));
  } finally {
    await act(async () => {
      complete({ pointsEarned: 120, balance: 120 });
    });
    await waitFor(() => expect(router.replace).toHaveBeenCalledTimes(1));
  }
});
