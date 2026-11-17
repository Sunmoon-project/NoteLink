import { screen } from '@testing-library/react-native';
import type { QuizSet } from '@notelink/shared';
import { QuizReadyScreen } from '../features/quiz/quiz';
import { api } from '../lib/api';
import { renderScreen, setParams } from '../test-utils';

jest.mock('../lib/env', () => ({ env: { localData: true, apiUrl: 'http://api' } }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

afterEach(() => jest.restoreAllMocks());
const withCount = (questionCount: number) =>
  jest.spyOn(api.quiz, 'set').mockResolvedValue({ questionCount } as QuizSet);

it('서버가 만든 실제 문제 수와 넘겨받은 노트 제목을 표시한다', async () => {
  withCount(3);
  setParams({ setId: 'set-1', title: '세포 분열' });
  await renderScreen(<QuizReadyScreen />);
  expect(await screen.findByText('총 3문제가 생성됐어요!')).toBeTruthy();
  expect(screen.getByText('세포 분열 노트를 기반으로 만들었어요')).toBeTruthy();
});

it('문제 수와 제목을 모르면 임의 값을 표시하지 않는다', async () => {
  jest.spyOn(api.quiz, 'set').mockRejectedValue(new Error('조회 실패'));
  setParams({ setId: 'set-1' });
  await renderScreen(<QuizReadyScreen />);
  expect(await screen.findByText('문제가 생성됐어요!')).toBeTruthy();
  expect(screen.queryByText(/5문제/)).toBeNull();
  expect(screen.queryByText(/이차방정식/)).toBeNull();
});
