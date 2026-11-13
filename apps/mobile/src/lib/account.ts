import type { QueryClient } from '@tanstack/react-query';
import { useQuizProgress } from '@/stores/quiz-progress';
import { disconnectSocket } from '@/lib/socket';
import { useDraft } from '@/stores/draft';
import { useSession } from '@/stores/session';
import { dropCache } from '@/lib/offline-cache';

/** 로그아웃 · 다른 계정 로그인 때 이전 계정이 남긴 기기 상태를 버린다 */
export function clearAccountState(qc: QueryClient) {
  disconnectSocket();
  qc.clear();
  // 로그아웃 · 탈퇴하면 기기에 남긴 조회 캐시도 지운다
  dropCache();
  useSession.getState().reset();
  useDraft.getState().reset();
  useQuizProgress.getState().reset();
}
