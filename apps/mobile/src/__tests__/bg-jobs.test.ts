import { AppState } from 'react-native';
import { checkBgJobs, useBgJobs } from '../stores/bg-jobs';
import { useAuth } from '../stores/auth';
import { queryClient } from '../lib/query';

const mockJob = jest.fn();
const mockToast = jest.fn();
const mockNotify = jest.fn(async () => {});
jest.mock('../lib/api', () => ({ api: { ai: { job: (...a: unknown[]) => mockJob(...a) } } }));
jest.mock('../stores/toast', () => ({ toast: (...a: unknown[]) => mockToast(...a) }));
let mockRegistered = false;
jest.mock('../lib/push', () => ({
  notifyLocal: (...a: unknown[]) => mockNotify(...(a as [])),
  pushRegistered: () => mockRegistered,
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

describe('화면을 떠나 기다리는 AI 작업', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuth.setState({ userId: 'u1' });
    useBgJobs.setState({ jobs: [] });
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true });
  });

  it('끝난 작업만 알리고 빼며, 진행 중인 작업은 남긴다', async () => {
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries');
    useBgJobs.getState().add({ jobId: 'q1', kind: 'quiz', title: '자료구조' });
    useBgJobs.getState().add({ jobId: 'm1', kind: 'material', title: '운영체제' });
    mockJob.mockImplementation(async (id: string) => ({
      status: id === 'q1' ? 'succeeded' : 'running',
    }));
    await checkBgJobs();
    expect(mockToast).toHaveBeenCalledWith("'자료구조' 퀴즈를 다 만들었어요");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['quiz-sets'] });
    expect(useBgJobs.getState().jobs.map((j) => j.jobId)).toEqual(['m1']);
    invalidate.mockRestore();
  });

  it('앱이 뒤에 있으면 로컬 알림으로, 실패도 알리고, 취소는 조용히 뺀다', async () => {
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
    useBgJobs.getState().add({ jobId: 'm1', kind: 'material', title: '운영체제' });
    useBgJobs.getState().add({ jobId: 'm2', kind: 'material', title: '취소한 것' });
    mockJob.mockImplementation(async (id: string) => ({
      status: id === 'm1' ? 'failed' : 'canceled',
    }));
    await checkBgJobs();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      "'운영체제' 정리에 실패했어요 · 원본은 폴더에 있어요",
      expect.any(String),
    );
    expect(mockToast).not.toHaveBeenCalled();
    expect(useBgJobs.getState().jobs).toEqual([]);
  });

  it('서버 푸시를 받는 기기면 로컬 알림을 띄우지 않는다(서버가 같은 알림을 보낸다, #560)', async () => {
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true });
    mockRegistered = true;
    try {
      useBgJobs.getState().add({ jobId: 'q1', kind: 'quiz', title: '자료구조' });
      mockJob.mockImplementation(async () => ({ status: 'succeeded' }));
      await checkBgJobs();
      expect(mockNotify).not.toHaveBeenCalled();
      expect(useBgJobs.getState().jobs).toEqual([]);
    } finally {
      mockRegistered = false;
    }
  });

  it('조회가 실패하면 남겨 두고, 다른 계정으로 바뀌면 알리지 않고 뺀다', async () => {
    useBgJobs.getState().add({ jobId: 'q1', kind: 'quiz', title: 'A' });
    mockJob.mockRejectedValueOnce(new Error('offline'));
    await checkBgJobs();
    expect(useBgJobs.getState().jobs).toHaveLength(1);
    useAuth.setState({ userId: 'u2' });
    await checkBgJobs();
    expect(useBgJobs.getState().jobs).toEqual([]);
    expect(mockToast).not.toHaveBeenCalled();
  });
});
