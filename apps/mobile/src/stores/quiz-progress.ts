import { create } from 'zustand';

export type QuizProgress = {
  setId: string;
  attemptId: string | null;
  index: number;
  answerText: string;
  pick: string | null;
  right: boolean | null;
  results: boolean[];
};
/** 인증 만료로 화면이 교체되어도 같은 계정의 미완료 풀이를 보존한다. */
export const useQuizProgress = create<{
  progress: QuizProgress | null;
  save: (p: QuizProgress) => void;
  reset: () => void;
}>((set) => ({
  progress: null,
  save: (progress) => set({ progress }),
  reset: () => set({ progress: null }),
}));
