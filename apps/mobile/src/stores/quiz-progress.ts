import { create } from 'zustand';

export type QuizProgress = {
  setId: string;
  attemptId: string | null;
  index: number;
  answerText: string;
  pick: string | null;
  right: boolean | null;
  results: boolean[];
  /** 문제마다 낸 답(results와 같은 순서). 결과 화면이 고른 오답 보기를 표시한다. 옛 진행에는 없다 */
  picks?: string[];
  completed?: {
    pointsEarned: number;
    balance: number;
    scheduled?: number;
    nextReviewDay?: string | null;
  };
};
/** 인증 만료로 화면이 교체되어도 같은 계정의 미완료 풀이를 보존한다. */
export const useQuizProgress = create<{
  progress: QuizProgress | null;
  generation: number;
  attemptGeneration: number;
  claim: () => number;
  save: (p: QuizProgress) => void;
  reset: () => void;
}>((set, get) => ({
  progress: null,
  generation: 0,
  attemptGeneration: 0,
  claim: () => {
    set((state) => ({ generation: state.generation + 1 }));
    return get().generation;
  },
  save: (progress) =>
    set((state) => ({
      progress:
        state.progress?.setId === progress.setId &&
        state.progress.attemptId === progress.attemptId &&
        state.progress.completed
          ? { ...progress, completed: state.progress.completed }
          : progress,
      attemptGeneration:
        state.attemptGeneration +
        (state.progress?.setId !== progress.setId ||
        state.progress?.attemptId !== progress.attemptId
          ? 1
          : 0),
      generation:
        state.generation +
        (state.progress?.setId !== progress.setId ||
        state.progress?.attemptId !== progress.attemptId
          ? 1
          : 0),
    })),
  reset: () =>
    set((state) => ({
      progress: null,
      generation: state.generation + 1,
      attemptGeneration: state.attemptGeneration + 1,
    })),
}));
