import { create } from 'zustand';
import { api } from '@/lib/api';

// 순공시간 측정 상태. 타이머는 기기에서 돈다 (p.48) — 시작 시각만 기억하고 경과는 매번 계산하므로
// 앱이 백그라운드로 가도 시간이 어긋나지 않는다.

export const AUTO_END_MS = 10 * 60 * 1000; // 쉬는 중 10분이 지나면 자동 종료 (p.48)

type Session = {
  segments: { start: number; end: number }[];
  elapsedSince: (boundary: number, now?: number) => number;
  itemId: string | null;
  sessionId: string | null;
  /** 측정 시작(또는 재개) 시각 */
  since: number | null;
  /** 이번 세션에서 이미 쌓인 초 (일시정지 전까지) */
  banked: number;
  pausedAt: number | null;
  mode: 'personal' | 'auto_landscape';
  start: (itemId: string, mode?: Session['mode']) => Promise<void>;
  pause: () => void;
  resume: () => void;
  /** 세션을 끝내고 쌓인 초를 돌려준다 */
  end: (reason: string) => Promise<{ sec: number; pointsEarned: number }>;
  elapsed: (now?: number) => number;
  /** 로그아웃 · 계정 전환 때 서버에 알리지 않고 기기 상태만 비운다 */
  reset: () => void;
};

const idle = {
  segments: [] as { start: number; end: number }[],
  itemId: null,
  sessionId: null,
  since: null,
  banked: 0,
  pausedAt: null,
};
// 측정이 바뀔 때마다(시작 · 종료 · 초기화) 올린다. 늦게 온 시작 응답이 지금 측정의 것인지 가리는 데 쓴다
let gen = 0;
// 로그아웃 · 계정 전환 때만 올린다. 이전 계정의 응답은 서버에 다시 보내지 않고 버린다
let epoch = 0;

export const useSession = create<Session>((set, get) => ({
  ...idle,
  mode: 'personal',
  reset: () => {
    gen++;
    epoch++;
    set({ ...idle, mode: 'personal' });
  },
  elapsedSince: (boundary, now = Date.now()) => {
    const s = get();
    const closed = s.segments.reduce(
      (sum, p) => sum + Math.max(0, p.end - Math.max(p.start, boundary)),
      0,
    );
    return Math.floor(
      (closed + (s.since ? Math.max(0, now - Math.max(s.since, boundary)) : 0)) / 1000,
    );
  },
  elapsed: (now = Date.now()) => {
    const s = get();
    return s.banked + (s.since ? Math.floor((now - s.since) / 1000) : 0);
  },
  start: async (itemId, mode = 'personal') => {
    const cur = get();
    if (cur.itemId === itemId && !cur.sessionId) return;
    if (cur.itemId === itemId && cur.pausedAt) return get().resume();
    // 계정 세대는 어떤 기다림보다 먼저 잡는다 — 앞 세션을 끝내는 사이 로그아웃 · 계정 전환되면 새로 시작하지 않는다
    const e = epoch;
    if (cur.itemId && cur.itemId !== itemId) {
      await get().end('switch');
      if (e !== epoch) return;
    }
    const g = ++gen;
    // 서버 확인 전에는 대기 상태다. 과거 휴식 시각을 보내는 계약이 없으므로
    // 응답 전 로컬 정지·재개를 허용해 서버 정산과 어긋나게 하지 않는다.
    set({ ...idle, itemId, mode });
    let s;
    try {
      s = await api.study.startSession({ studyItemId: itemId, mode });
    } catch (err) {
      // 서버가 세션을 만들지 못했으면 먼저 시작해 둔 기기 타이머를 되돌린다
      if (g === gen) set(idle);
      throw err;
    }
    if (g === gen) {
      set({ sessionId: s._id, since: Date.now() });
      return;
    }
    // 기다리는 사이 측정이 끝났거나 다른 항목으로 바뀌었다 → 같은 계정이면 서버에 남은 세션을 닫는다
    if (e === epoch)
      api.study.endSession(s._id, { clientDurationSec: 0, endReason: 'cancelled' }).catch(() => {});
  },
  pause: () => {
    const s = get();
    if (!s.sessionId || !s.since) return;
    set({
      banked: s.elapsed(),
      segments: [...s.segments, { start: s.since, end: Date.now() }],
      since: null,
      pausedAt: Date.now(),
    });
    if (s.sessionId) api.study.pauseSession(s.sessionId).catch(() => {});
  },
  resume: () => {
    const s = get();
    if (!s.sessionId || !s.pausedAt) return;
    set({ since: Date.now(), pausedAt: null });
    if (s.sessionId) api.study.resumeSession(s.sessionId).catch(() => {});
  },
  end: async (reason) => {
    const s = get();
    const sec = s.elapsed();
    gen++;
    set(idle);
    if (!s.sessionId) return { sec, pointsEarned: 0 };
    // 서버가 잰 시간을 기준으로 삼는다 (기기 시계 조작으로 포인트를 받지 못하게)
    const r = await api.study.endSession(s.sessionId, {
      clientDurationSec: sec,
      endReason: reason,
    });
    return { sec: r.durationSec, pointsEarned: r.pointsEarned };
  },
}));
