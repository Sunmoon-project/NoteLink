import { create } from 'zustand';
import { api } from '@/lib/api';
import { toast } from '@/stores/toast';

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
  pause: () => Promise<void>;
  resume: () => Promise<void>;
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
let ending: {
  generation: number;
  reason: string;
  sessionId: string | null;
  promise: Promise<{ sec: number; pointsEarned: number }>;
} | null = null;

type PauseChange = { generation: number; desiredPaused: boolean; promise: Promise<void> };
let changingPause: PauseChange | null = null;

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
      (sum, p) => sum + Math.max(0, Math.min(p.end, now) - Math.max(p.start, boundary)),
      0,
    );
    return Math.floor(
      (closed + (s.since ? Math.max(0, now - Math.max(s.since, boundary)) : 0)) / 1000,
    );
  },
  elapsed: (now = Date.now()) => {
    const s = get();
    return Math.floor(
      (Math.round(s.banked * 1000) + (s.since !== null ? Math.max(0, now - s.since) : 0)) / 1000,
    );
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
  pause: () => changePause(true),
  resume: () => changePause(false),
  end: async (reason) => {
    if (ending?.generation === gen) {
      const pending = ending;
      return pending.promise.then((result) => {
        // 재개 때문에 자동 종료가 취소돼도 명시적인 종료 의도까지 취소하지 않는다.
        if (
          reason !== 'auto_pause_timeout' &&
          pending.reason === 'auto_pause_timeout' &&
          pending.generation === gen &&
          get().sessionId === pending.sessionId
        )
          return get().end(reason);
        return result;
      });
    }
    const generation = gen;
    const sessionId = get().sessionId;
    const pausedAt = get().pausedAt;
    const transition = changingPause?.generation === gen ? changingPause.promise : null;
    const promise = (async () => {
      if (transition) await transition;
      if (generation !== gen) return { sec: 0, pointsEarned: 0 };
      const current = get();
      if (
        reason === 'auto_pause_timeout' &&
        (current.pausedAt === null || current.pausedAt !== pausedAt)
      )
        return { sec: 0, pointsEarned: 0 };
      const sec = current.elapsed();
      if (!current.sessionId) {
        gen++;
        set(idle);
        return { sec, pointsEarned: 0 };
      }
      const result = await api.study.endSession(current.sessionId, {
        clientDurationSec: sec,
        endReason: reason,
      });
      // 계정 전환이나 새 측정의 상태를 늦은 종료 응답으로 지우지 않는다.
      if (generation === gen) {
        gen++;
        set(idle);
      }
      return { sec: result.durationSec, pointsEarned: result.pointsEarned };
    })();
    const request = { generation, reason, sessionId, promise };
    ending = request;
    try {
      return await promise;
    } finally {
      if (ending === request) ending = null;
    }
  },
}));

/** 서버 확인 전 입력은 마지막 의도로 합치고, 서버 변경과 로컬 표시를 같은 순서로 적용한다. */
function changePause(pausing: boolean): Promise<void> {
  if (ending?.generation === gen) return Promise.resolve();
  if (changingPause?.generation === gen) {
    changingPause.desiredPaused = pausing;
    return changingPause.promise;
  }
  const state = useSession.getState();
  const sessionId = state.sessionId;
  if (!sessionId || (pausing ? state.since === null : state.pausedAt === null))
    return Promise.resolve();
  const request: PauseChange = {
    generation: gen,
    desiredPaused: pausing,
    promise: Promise.resolve(),
  };
  changingPause = request;
  request.promise = (async () => {
    let attemptedPause = pausing;
    try {
      while (request.generation === gen && useSession.getState().sessionId === sessionId) {
        attemptedPause = request.desiredPaused;
        const current = useSession.getState();
        if (attemptedPause ? current.since === null : current.pausedAt === null) return;
        if (attemptedPause) await api.study.pauseSession(sessionId);
        else await api.study.resumeSession(sessionId);
        if (request.generation !== gen || useSession.getState().sessionId !== sessionId) return;
        const confirmed = useSession.getState();
        const at = Date.now();
        if (attemptedPause && confirmed.since !== null) {
          useSession.setState({
            banked:
              (Math.round(confirmed.banked * 1000) + Math.max(0, at - confirmed.since)) / 1000,
            segments: [...confirmed.segments, { start: confirmed.since, end: at }],
            since: null,
            pausedAt: at,
          });
        } else if (!attemptedPause) useSession.setState({ since: at, pausedAt: null });
      }
    } catch {
      if (request.generation === gen && useSession.getState().sessionId === sessionId)
        toast(
          attemptedPause
            ? '일시정지하지 못했어요. 연결을 확인하고 다시 시도해주세요'
            : '재개하지 못했어요. 연결을 확인하고 다시 시도해주세요',
        );
    } finally {
      if (changingPause === request) changingPause = null;
    }
  })();
  return request.promise;
}
