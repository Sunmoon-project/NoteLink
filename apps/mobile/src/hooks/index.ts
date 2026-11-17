import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect } from 'expo-router';
import { socket } from '@/lib/socket';
import type { ServerToClient } from '@notelink/shared';

/** 1초마다 다시 그린다 (타이머 표시용) */
export function useNow(active = true, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}

/** 소켓 이벤트 구독 */
export function useSocket<E extends keyof ServerToClient>(
  ev: E,
  fn: ServerToClient[E],
  deps: unknown[] = [],
) {
  useEffect(() => socket.on(ev, fn), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * AI 작업 진행률 구독(서버 AiJobsGateway: `ai:subscribe` → `ai:progress` · `ai:done`).
 * 서버 구독은 소켓 연결마다 따로라 다시 연결되면(토큰 갱신 · 회선 끊김) 사라지므로 연결될 때마다 다시 보낸다.
 * 같은 작업을 다시 시도하면(작업 id는 그대로) `again`을 바꿔 다시 구독한다. 화면을 떠나면 `ai:unsubscribe`
 */
export function useAiJobSubscription(jobId: string | null | undefined, again?: unknown) {
  useEffect(() => {
    if (!jobId) return;
    const subscribe = (connected: boolean) => {
      if (connected) socket.emit('ai:subscribe', { jobId });
    };
    const off = socket.onConnection?.(subscribe);
    if (!socket.onConnection) subscribe(true);
    return () => {
      off?.();
      socket.emit('ai:unsubscribe', { jobId });
    };
  }, [jobId, again]);
}

type Refetchable = { dataUpdatedAt: number; refetch: () => Promise<unknown> };

/**
 * 탭 첫 화면의 데이터 새로 고침.
 * - 다른 탭 · 화면에 갔다 돌아오거나 앱이 다시 앞으로 나오면 오래된(staleTime 30초가 지난) 조회만 다시 읽는다
 * - 목록을 아래로 당기면 오래됐는지와 상관없이 서버에서 다시 읽는다(돌려준 값을 Screen의 refresh로)
 * 넘긴 조회만 다시 읽는다: 다른 탭에 떠 있는 퀴즈 풀이 · 편집 화면 · 스터디룸(소켓) 조회는 건드리지 않는다
 */
export function useTabRefresh(...queries: Refetchable[]) {
  const qc = useQueryClient();
  const latest = useRef(queries);
  useEffect(() => {
    latest.current = queries;
  });
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      // 오래됨은 부르는 순간에 본다: 백그라운드에서 돌아온 직후에는 isStale이 아직 바뀌지 않았을 수 있다
      const stale = () => {
        const ms = Number(qc.getDefaultOptions().queries?.staleTime ?? 0);
        for (const q of latest.current) if (Date.now() - q.dataUpdatedAt >= ms) void q.refetch();
      };
      // 처음 열 때는 useQuery가 읽는다
      if (first.current) first.current = false;
      else stale();
      // 이 화면이 보이는 동안 앱이 다시 앞으로 나오면
      const sub = AppState.addEventListener('change', (s) => s === 'active' && stale());
      return () => sub.remove();
    }, [qc]),
  );
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all(latest.current.map((q) => q.refetch()));
    } finally {
      setRefreshing(false);
    }
  }, []);
  return { refreshing, onRefresh };
}
