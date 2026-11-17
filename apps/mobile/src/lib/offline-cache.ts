import { useEffect } from 'react';
import {
  dehydrate,
  hydrate,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api';
import { dropDb, readDb, writeDb } from '@/lib/local/storage';
import { useAuth } from '@/stores/auth';

// 설정 「오프라인 캐시」: 켜면 받아 둔 목록 · 자료(성공한 조회)를 기기 파일 하나에 적어 두고, 앱을 다시 켜면
// 먼저 채워 둔다. 연결이 없어도 마지막으로 본 내용을 볼 수 있다. 끄거나 로그아웃 · 탈퇴하면 지운다.
// ponytail: 파일 하나에 통째로 적는다(3초에 한 번까지). 캐시가 커지면 조회별 파일로 나눈다

const FILE = 'query-cache';
const MAX_AGE_MS = 7 * 24 * 3600_000; // 일주일 넘은 캐시는 쓰지 않는다
const SAVE_GAP_MS = 3000;
type Saved = { userId: string; savedAt: number; state: unknown };

export function restoreCache(qc: QueryClient, userId: string, now = Date.now()) {
  try {
    const v = readDb(FILE) as Saved | null;
    // 다른 계정 · 오래된 캐시는 쓰지 않는다
    if (v && v.userId === userId && now - v.savedAt < MAX_AGE_MS) hydrate(qc, v.state);
  } catch {
    // 못 읽으면 서버에서 다시 받는다
  }
}
export function saveCache(qc: QueryClient, userId: string, now = Date.now()) {
  try {
    // 데이터가 있는 조회는 모두 적는다. 오프라인에서 다시 받다 실패해 상태가 error가 되어도 받아 둔 데이터는
    // 남아 있으므로, 성공한 조회만 고르면 그 데이터가 다음 저장에서 파일에서 빠진다(#366 리뷰)
    const state = dehydrate(qc, { shouldDehydrateQuery: (q) => q.state.data !== undefined });
    writeDb(FILE, { userId, savedAt: now, state } satisfies Saved);
  } catch {
    // 다음 변경 때 다시 적는다
  }
}
export function dropCache() {
  try {
    dropDb(FILE);
  } catch {
    // 남아도 다른 계정에는 쓰지 않는다(userId 확인)
  }
}

/** 루트에서 한 번 부른다 */
export function useOfflineCache() {
  const qc = useQueryClient();
  const userId = useAuth((s) => s.userId);
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.me.get(), enabled: !!userId });
  const on = me.data?.settings.offlineCache;
  // 로그인하면 남겨 둔 캐시로 먼저 채운다(켠 사람만 파일이 있다)
  useEffect(() => {
    if (userId) restoreCache(qc, userId);
  }, [qc, userId]);
  useEffect(() => {
    if (!userId || on === undefined) return;
    if (!on) return dropCache();
    saveCache(qc, userId);
    let t: ReturnType<typeof setTimeout> | undefined;
    const unsub = qc.getQueryCache().subscribe((e) => {
      if (e.type !== 'updated' || t) return;
      t = setTimeout(() => {
        t = undefined;
        saveCache(qc, userId);
      }, SAVE_GAP_MS);
    });
    return () => {
      unsub();
      clearTimeout(t);
    };
  }, [qc, userId, on]);
}
