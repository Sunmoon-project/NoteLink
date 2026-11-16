import { create } from 'zustand';

// 연결 · 서버 상태 (p.96~101 예외 처리 배너가 이 값을 본다)
export type NetState = 'ok' | 'unstable' | 'offline' | 'maintenance' | 'aiMaintenance';

type Net = {
  state: NetState;
  pendingWrites: number;
  set: (s: NetState) => void;
  addPending: (n: number) => void;
};

export const useNet = create<Net>((set) => ({
  state: 'ok',
  pendingWrites: 0,
  set: (state) => set({ state }),
  addPending: (n) => set((p) => ({ pendingWrites: Math.max(0, p.pendingWrites + n) })),
}));
