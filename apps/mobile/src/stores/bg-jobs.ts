import { useEffect } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import { api } from '@/lib/api';
import { queryClient } from '@/lib/query';
import { notifyLocal, pushRegistered } from '@/lib/push';
import { useAuth } from '@/stores/auth';
import { toast } from '@/stores/toast';

/** 화면을 떠나 기다리는 AI 작업(노트 정리 · 퀴즈 생성). 끝나면 목록을 새로 읽고 알려 준다 */
export type BgJob = {
  jobId: string;
  kind: 'material' | 'quiz';
  title: string;
  userId: string | null;
};

type State = {
  jobs: BgJob[];
  add: (job: Omit<BgJob, 'userId'>) => void;
  remove: (jobId: string) => void;
};

export const useBgJobs = create<State>((set) => ({
  jobs: [],
  add: (job) => {
    const userId = useAuth.getState().userId;
    set((s) => ({
      jobs: [...s.jobs.filter((j) => j.jobId !== job.jobId), { ...job, userId }],
    }));
  },
  remove: (jobId) => set((s) => ({ jobs: s.jobs.filter((j) => j.jobId !== jobId) })),
}));

const POLL_MS = 3000;

const doneText = (j: BgJob, ok: boolean) =>
  j.kind === 'quiz'
    ? ok
      ? `'${j.title}' 퀴즈를 다 만들었어요`
      : `'${j.title}' 퀴즈를 만들지 못했어요`
    : ok
      ? `'${j.title}' 정리가 끝났어요`
      : `'${j.title}' 정리에 실패했어요 · 원본은 폴더에 있어요`;

/** 한 번 확인: 끝난 작업은 목록을 새로 읽고 알려 준 뒤 뺀다. 조회 실패는 다음 확인에서 다시 본다 */
let checking = false;
export async function checkBgJobs() {
  // 응답이 느려 확인이 겹치면 같은 작업을 두 번 알릴 수 있어 한 번에 하나만
  if (checking) return;
  checking = true;
  try {
    await checkOnce();
  } finally {
    checking = false;
  }
}

async function checkOnce() {
  const { jobs, remove } = useBgJobs.getState();
  const me = useAuth.getState().userId;
  for (const j of jobs) {
    // 다른 계정으로 바뀌었으면 그 작업은 더 알리지 않는다
    if (j.userId !== me) {
      remove(j.jobId);
      continue;
    }
    let status: string;
    try {
      status = (await api.ai.job(j.jobId)).status;
    } catch {
      continue;
    }
    if (!['succeeded', 'failed', 'canceled'].includes(status)) continue;
    remove(j.jobId);
    void queryClient.invalidateQueries({
      queryKey: j.kind === 'quiz' ? ['quiz-sets'] : ['materials'],
    });
    if (j.kind === 'material') void queryClient.invalidateQueries({ queryKey: ['folders'] });
    if (status === 'canceled') continue;
    // 서버가 같은 알림을 알림함에도 쌓는다: 푸시를 못 받는 기기에서도 종 숫자가 바로 바뀌게
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
    const text = doneText(j, status === 'succeeded');
    if (AppState.currentState === 'active') toast(text);
    // 서버 푸시를 받는 기기면 서버가 같은 알림을 보낸다(#560)
    else if (!pushRegistered()) notifyLocal(text, '눌러서 앱에서 확인해 보세요').catch(() => {});
  }
}

/** 전역에서 한 번 붙인다(AppOverlays). 기다리는 작업이 있을 때만 돈다 */
export function useWatchBgJobs() {
  const count = useBgJobs((s) => s.jobs.length);
  useEffect(() => {
    if (!count) return;
    const id = setInterval(() => void checkBgJobs(), POLL_MS);
    return () => clearInterval(id);
  }, [count]);
}
