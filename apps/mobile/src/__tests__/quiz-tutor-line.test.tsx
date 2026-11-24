// PR #698 Codex 리뷰: 퀴즈 결과 「다음 단계」 카드의 3D 선생님 — 말하는 동안만 입을 움직이고, 화면을 떠나면 3D를 내린다
import { useState } from 'react';
import { Text } from 'react-native';
import { act, fireEvent, screen } from '@testing-library/react-native';
import { Sparkles } from 'lucide-react-native';
import { NextStepCard, talkMs } from '../features/quiz/next-step';
import { renderScreen } from '../test-utils';

jest.mock('../features/tutor/avatar3d', () => {
  const { Text: T } = jest.requireActual('react-native');
  return { Avatar3D: ({ mood }: { mood: string }) => <T>{`mood:${mood}`}</T> };
});
const mockFocus = new Set<() => (() => void) | void>();
jest.mock('expo-router', () => ({
  useFocusEffect: (cb: () => (() => void) | void) => mockFocus.add(cb),
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));

const card = (line: string) => (
  <NextStepCard line={line} steps={[{ label: '다시 풀기', icon: Sparkles, onPress: () => {} }]} />
);
const LINE = '지금 비슷한 문제로 한 번 더 풀면 더 오래 기억해요.';

beforeEach(() => {
  mockFocus.clear();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

it('말하는 동안만 talking, 시간이 지나면 idle로 돌아간다', async () => {
  await renderScreen(card(LINE));
  expect(screen.getByText('mood:talking')).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(talkMs(LINE) - 1));
  expect(screen.getByText('mood:talking')).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(1));
  expect(screen.getByText('mood:idle')).toBeTruthy();
});

it('한마디가 바뀌면 다시 말한다', async () => {
  const next = '다 맞혔어요!';
  function Host() {
    const [line, setLine] = useState(LINE);
    return (
      <>
        {card(line)}
        <Text onPress={() => setLine(next)}>바꾸기</Text>
      </>
    );
  }
  await renderScreen(<Host />);
  await act(async () => jest.advanceTimersByTime(talkMs(LINE)));
  expect(screen.getByText('mood:idle')).toBeTruthy();
  await fireEvent.press(screen.getByText('바꾸기'));
  expect(screen.getByText('mood:talking')).toBeTruthy();
  await act(async () => jest.advanceTimersByTime(talkMs(next)));
  expect(screen.getByText('mood:idle')).toBeTruthy();
});

it('언마운트하면 말하기 타이머를 정리한다', async () => {
  const clear = jest.spyOn(globalThis, 'clearTimeout');
  const { unmount } = await renderScreen(card(LINE));
  clear.mockClear();
  await unmount();
  expect(clear).toHaveBeenCalled();
  clear.mockRestore();
});

it('다른 화면이 위에 쌓이면 3D를 내리고, 돌아오면 다시 그린다', async () => {
  await renderScreen(card(LINE));
  expect(screen.getByText(/^mood:/)).toBeTruthy();
  const cleanups: ((() => void) | void)[] = [];
  await act(async () => {
    for (const cb of mockFocus) cleanups.push(cb());
  });
  await act(async () => {
    for (const c of cleanups) c?.();
  });
  expect(screen.queryByText(/^mood:/)).toBeNull();
  expect(screen.getByText(LINE)).toBeTruthy();
  await act(async () => {
    for (const cb of mockFocus) cb();
  });
  expect(screen.getByText(/^mood:/)).toBeTruthy();
});
