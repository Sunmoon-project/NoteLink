import { AppState } from 'react-native';
import { act, fireEvent, renderHook, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import type { Question } from '@notelink/shared';
import {
  DAILY_COUNT,
  WrongReviewScreen,
  addWrong,
  dueOn,
  forgetWrongNotes,
  loadWrong,
  recordWrong,
  sameAnswer,
  useDailyWrongReview,
  type WrongNotes,
} from '../features/quiz/wrong-review';
import { useTour } from '../features/tutor/tour';
import { useAuth } from '../stores/auth';
import { today } from '../lib/dates';
import { renderScreen } from '../test-utils';

const mockFiles = new Map<string, string>();
jest.mock('../lib/local/storage', () => ({
  readDb: (n: string) => (mockFiles.has(n) ? JSON.parse(mockFiles.get(n)!) : null),
  writeDb: (n: string, d: unknown) => mockFiles.set(n, JSON.stringify(d)),
  dropDb: (n: string) => mockFiles.delete(n),
  keepFile: (uri: string) => ({ uri, size: 0 }),
}));

const q = (id: string, p: Partial<Question> = {}): Question => ({
  _id: id,
  order: 0,
  type: 'multiple_choice',
  prompt: `문제 ${id}`,
  choices: ['가', '나', '다'],
  answer: '나',
  explanation: `해설 ${id}`,
  conceptTags: [],
  ...p,
});

beforeEach(() => {
  mockFiles.clear();
  useAuth.setState({ userId: 'u1' });
  useTour.setState({ step: -1 });
  jest.mocked(router.push).mockClear();
  jest.mocked(router.back).mockClear();
});

describe('오답 노트 계산', () => {
  it('새로 틀린 문제는 앞에, 같은 문제는 한 번만 둔다', () => {
    let n: WrongNotes = { items: [], shownOn: null };
    for (const id of ['a', 'b', 'a']) n = addWrong(n, { ...q(id), setTitle: null });
    expect(n.items.map((x) => x._id)).toEqual(['a', 'b']);
  });

  it('오늘 아직 띄우지 않았을 때만, 오래된 오답부터 하루 몫을 낸다', () => {
    const items = Array.from({ length: DAILY_COUNT + 2 }, (_, i) => ({
      ...q(`q${i}`),
      setTitle: null,
    }));
    const due = dueOn({ items, shownOn: '2026-11-11' }, '2026-11-12');
    expect(due).toHaveLength(DAILY_COUNT);
    expect(due![0]!._id).toBe(`q${DAILY_COUNT + 1}`);
    expect(dueOn({ items, shownOn: '2026-11-12' }, '2026-11-12')).toBeNull();
    expect(dueOn({ items: [], shownOn: null }, '2026-11-12')).toBeNull();
  });

  it('주관식 답은 띄어쓰기 · 대소문자를 보지 않는다', () => {
    expect(sameAnswer(' 광 합성 ', '광합성')).toBe(true);
    expect(sameAnswer('ATP', 'atp')).toBe(true);
    expect(sameAnswer('호흡', '광합성')).toBe(false);
  });

  it('퀴즈에서 틀리면 계정의 오답 노트에 넣는다(같은 문제는 한 번만)', () => {
    recordWrong('u1', q('a'), '광합성 퀴즈');
    recordWrong('u1', q('a'), '광합성 퀴즈');
    expect(loadWrong('u1').items).toMatchObject([{ _id: 'a', setTitle: '광합성 퀴즈' }]);
    expect(loadWrong('u2').items).toEqual([]);
  });
});

it('오답 노트 파일을 읽지 못하면 덮어쓰지 않고 그대로 둔다', () => {
  mockFiles.set('wrong-u1', '{깨진 파일');
  recordWrong('u1', q('a'));
  expect(mockFiles.get('wrong-u1')).toBe('{깨진 파일');
  // 화면에는 빈 노트로 보인다
  expect(loadWrong('u1').items).toEqual([]);
});

it('회원 탈퇴하면 그 계정의 오답 노트만 지운다', () => {
  recordWrong('u1', q('a'));
  recordWrong('u2', q('b'));
  forgetWrongNotes('u1');
  expect(loadWrong('u1').items).toEqual([]);
  expect(loadWrong('u2').items).toHaveLength(1);
  expect(() => forgetWrongNotes(null)).not.toThrow();
});

describe('하루에 처음 열 때 오답 복습', () => {
  it('오답이 있으면 하루에 한 번 복습 화면을 연다', async () => {
    jest.useFakeTimers();
    try {
      recordWrong('u1', q('a'));
      const { rerender } = await renderHook(({ r }: { r: boolean }) => useDailyWrongReview(r), {
        initialProps: { r: true },
      });
      await act(async () => jest.advanceTimersByTime(700));
      expect(router.push).toHaveBeenCalledWith('/play/wrong');
      expect(loadWrong('u1').shownOn).toBe(today());
      // 같은 날 다시 앱으로 돌아와도 또 띄우지 않는다
      await rerender({ r: false });
      await rerender({ r: true });
      await act(async () => jest.advanceTimersByTime(700));
      expect(router.push).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('처음 안내 중이면 기다렸다가, 안내가 끝나면 띄운다', async () => {
    jest.useFakeTimers();
    try {
      recordWrong('u1', q('a'));
      useTour.setState({ step: 2 });
      await renderHook(() => useDailyWrongReview(true));
      await act(async () => jest.advanceTimersByTime(700));
      expect(router.push).not.toHaveBeenCalled();
      await act(async () => useTour.setState({ step: -1 }));
      await act(async () => jest.advanceTimersByTime(700));
      expect(router.push).toHaveBeenCalledWith('/play/wrong');
    } finally {
      jest.useRealTimers();
    }
  });

  it('그날 처음 열 때 오답이 없었으면, 그날 늦게 틀린 문제는 다음 날 처음 열 때 복습한다', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-11-12T01:00:00Z')); // 서울 11월 12일 10시
      const first = await renderHook(() => useDailyWrongReview(true));
      await act(async () => jest.advanceTimersByTime(700));
      expect(router.push).not.toHaveBeenCalled();
      expect(loadWrong('u1').shownOn).toBe('2026-11-12');
      await first.unmount();
      // 그날 늦게 틀리고 다시 열어도 그날은 띄우지 않는다
      recordWrong('u1', q('a'));
      const again = await renderHook(() => useDailyWrongReview(true));
      await act(async () => jest.advanceTimersByTime(700));
      expect(router.push).not.toHaveBeenCalled();
      await again.unmount();
      // 다음 날(서울 자정 지나) 처음 열면 띄운다
      jest.setSystemTime(new Date('2026-11-12T15:30:00Z')); // 서울 11월 13일 0시 30분
      await renderHook(() => useDailyWrongReview(true));
      await act(async () => jest.advanceTimersByTime(700));
      expect(router.push).toHaveBeenCalledWith('/play/wrong');
      expect(loadWrong('u1').shownOn).toBe('2026-11-13');
    } finally {
      jest.useRealTimers();
    }
  });

  it('앱을 백그라운드에서 다시 열 때도 확인한다', async () => {
    const listen = jest.spyOn(AppState, 'addEventListener');
    await renderHook(() => useDailyWrongReview(true));
    expect(listen).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

describe('오답 복습 화면', () => {
  it('문제를 다시 풀고, 맞힌 문제는 빼고 틀린 문제는 남긴 뒤 결과를 요약한다', async () => {
    recordWrong('u1', q('a'), '광합성 퀴즈');
    recordWrong('u1', q('b', { type: 'short_answer', choices: null, answer: '엽록체' }));
    await renderScreen(<WrongReviewScreen />);
    // 오래된 오답(a)부터
    expect(screen.getByText('Q. 문제 a')).toBeTruthy();
    expect(screen.getByText('광합성 퀴즈')).toBeTruthy();
    await fireEvent.press(screen.getByText('나'));
    expect(screen.getByText('정답이에요')).toBeTruthy();
    expect(screen.getByText('해설 a')).toBeTruthy();
    await fireEvent.press(screen.getByText('다음 문제'));
    // 주관식은 입력해서 확인
    await fireEvent.changeText(screen.getByPlaceholderText('답을 입력해 주세요'), '미토콘드리아');
    await fireEvent.press(screen.getByText('확인'));
    expect(screen.getByText('아쉬워요, 정답은')).toBeTruthy();
    expect(screen.getByText('엽록체')).toBeTruthy();
    await fireEvent.press(screen.getByText('복습 마치기'));
    expect(screen.getByText('2문제 중 1문제를 맞혔어요')).toBeTruthy();
    expect(loadWrong('u1').items.map((x) => x._id)).toEqual(['b']);
    await fireEvent.press(screen.getByText('확인'));
    expect(router.back).toHaveBeenCalled();
  });

  it('건너뛰면 닫는다', async () => {
    recordWrong('u1', q('a'));
    await renderScreen(<WrongReviewScreen />);
    await fireEvent.press(screen.getByText('건너뛰기'));
    expect(router.back).toHaveBeenCalled();
    expect(loadWrong('u1').items).toHaveLength(1);
  });
});
