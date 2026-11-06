import { create } from 'zustand';

// 목업 모드에서만 쓰는 예외 상황 스위치 (p.96~102 시연용). 설정 > 예외 시나리오에서 켠다.
export type MockFlags = {
  aiCreditExhausted: boolean;
  llmSlow: boolean;
  llmFail: boolean;
  uploadPause: boolean;
  tokenExpired: boolean;
  purchaseFail: boolean;
  roomDisconnect: boolean;
  roomKick: boolean;
};

type Store = MockFlags & { toggle: (k: keyof MockFlags) => void; reset: () => void };

const initial: MockFlags = {
  aiCreditExhausted: false,
  llmSlow: false,
  llmFail: false,
  uploadPause: false,
  tokenExpired: false,
  purchaseFail: false,
  roomDisconnect: false,
  roomKick: false,
};

export const useMockFlags = create<Store>((set) => ({
  ...initial,
  toggle: (k) => set((p) => ({ [k]: !p[k] }) as Partial<Store>),
  reset: () => set(initial),
}));
