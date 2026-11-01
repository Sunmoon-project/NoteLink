import { useQuizProgress, type QuizProgress } from '../stores/quiz-progress';

const progress: QuizProgress = {
  setId: 'generation-set',
  attemptId: 'generation-attempt',
  index: 0,
  answerText: '',
  pick: null,
  right: null,
  results: [],
};
function generation(): number {
  const state = useQuizProgress.getState();
  expect(state).toHaveProperty('generation');
  if (!('generation' in state) || typeof state.generation !== 'number')
    throw new Error('진행 저장소에 숫자 generation이 필요합니다');
  return state.generation;
}
beforeEach(() => useQuizProgress.getState().reset());

it('진행 저장소는 숫자 세대를 노출한다', () => {
  expect(Number.isInteger(generation())).toBe(true);
  expect(generation()).toBeGreaterThanOrEqual(0);
});

it('빈 저장소에서 새 풀이를 저장하면 새 세대를 시작한다', () => {
  const before = generation();
  useQuizProgress.getState().save(progress);
  expect(generation()).toBeGreaterThan(before);
});

it('같은 세트·풀이에서 입력과 위치만 저장하면 세대를 유지한다', () => {
  useQuizProgress.getState().save(progress);
  const before = generation();
  const updated = { ...progress, index: 1, answerText: '새 입력', results: [true] };
  useQuizProgress.getState().save(updated);
  expect(generation()).toBe(before);
  expect(useQuizProgress.getState().progress).toEqual(updated);
});

it.each([
  { label: '세트 변경', next: { ...progress, setId: 'different-set' } },
  { label: '풀이 변경', next: { ...progress, attemptId: 'different-attempt' } },
])('$label은 이전 화면의 소유권을 잃게 하는 새 세대를 시작한다', ({ next }) => {
  useQuizProgress.getState().save(progress);
  const before = generation();
  useQuizProgress.getState().save(next);
  expect(generation()).toBeGreaterThan(before);
});

it('시작 대기의 null 풀이 ID가 실제 ID로 바뀌면 세대도 바뀐다', () => {
  useQuizProgress.getState().save({ ...progress, attemptId: null });
  const before = generation();
  useQuizProgress.getState().save(progress);
  expect(generation()).toBeGreaterThan(before);
});

it('reset 후 동일 식별자로 다시 저장해도 이전 세대를 재사용하지 않는다', () => {
  useQuizProgress.getState().save(progress);
  const before = generation();
  useQuizProgress.getState().reset();
  const resetGeneration = generation();
  expect(resetGeneration).toBeGreaterThan(before);
  useQuizProgress.getState().save(progress);
  expect(generation()).toBeGreaterThan(resetGeneration);
});

it('이미 비어 있어도 명시적인 reset은 세대를 올린다', () => {
  const before = generation();
  useQuizProgress.getState().reset();
  expect(generation()).toBeGreaterThan(before);
  expect(useQuizProgress.getState().progress).toBeNull();
});

it('같은 풀이도 새 화면이 소유권을 얻으면 이전 화면의 세대를 바꾼다', () => {
  useQuizProgress.getState().save(progress);
  const before = generation();
  const state = useQuizProgress.getState();
  expect(state).toHaveProperty('claim');
  if (!('claim' in state) || typeof state.claim !== 'function')
    throw new Error('화면 소유권 claim이 필요합니다');
  const claimed = state.claim();
  expect(claimed).toBe(generation());
  expect(generation()).toBeGreaterThan(before);
  expect(useQuizProgress.getState().progress).toEqual(progress);
});
