import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import type { User } from '@notelink/shared';

// 토큰은 SecureStore(키체인 · 키스토어)에만 둔다
const KEY = 'notelink.auth';

type Saved = { accessToken: string; refreshToken: string };
type Auth = {
  ready: boolean;
  tokens: Saved | null;
  user: User | null;
  /** 기기에 저장된 토큰의 주인. 다른 계정으로 로그인하면 이전 상태를 버린다 */
  userId: string | null;
  onboarded: boolean;
  /** 로그인 만료 다이얼로그 (p.101) */
  expired: boolean;
  load: () => Promise<void>;
  signIn: (t: Saved, user: User) => Promise<void>;
  setUser: (u: User) => void;
  /** forUser를 주면 그 계정일 때만 반영하고 결과를 돌려준다 */
  setTokens: (t: Saved, forUser?: string | null) => Promise<boolean>;
  setExpired: (v: boolean) => void;
  /** 만료: 토큰만 버리고 다시 로그인하게 한다 */
  expire: () => Promise<void>;
  finishOnboarding: () => Promise<void>;
  signOut: () => Promise<void>;
};

export const useAuth = create<Auth>((set, get) => {
  // 기기 저장은 줄을 세워 하나씩, 매번 '지금 상태'를 쓴다 — 저장을 기다리는 사이 계정이 바뀌어도
  // 마지막에 남는 값은 항상 마지막 상태다. 상태(set)는 저장을 기다리지 않고 바로 바꾼다.
  let writing: Promise<void> = Promise.resolve();
  const persist = () => {
    const operation = writing.then(async () => {
      const { tokens, onboarded, userId } = get();
      if (!userId) await SecureStore.deleteItemAsync(KEY);
      else await SecureStore.setItemAsync(KEY, JSON.stringify({ ...tokens, onboarded, userId }));
    });
    // 큐는 실패 후에도 진행하지만, 이번 호출의 실패는 호출자에게 전달한다.
    writing = operation.catch(() => {});
    return operation;
  };
  return {
    ready: false,
    tokens: null,
    user: null,
    userId: null,
    onboarded: false,
    expired: false,
    load: async () => {
      const raw = await SecureStore.getItemAsync(KEY);
      let saved: (Partial<Saved> & { onboarded?: boolean; userId?: string }) | null = null;
      try {
        saved = raw ? JSON.parse(raw) : null;
      } catch {
        // 저장 값이 깨졌으면 로그아웃 상태로 시작한다
        await SecureStore.deleteItemAsync(KEY);
      }
      set({
        ready: true,
        tokens:
          saved?.accessToken && saved.refreshToken
            ? { accessToken: saved.accessToken, refreshToken: saved.refreshToken }
            : null,
        userId: saved?.userId ?? null,
        onboarded: !!saved?.onboarded,
      });
    },
    signIn: async (tokens, user) => {
      // 온보딩 완료 여부는 같은 계정일 때만 이어 간다
      const onboarded = get().userId === user._id && get().onboarded;
      set({ tokens, user, userId: user._id, onboarded, expired: false });
      await persist();
    },
    setUser: (user) => set({ user }),
    setTokens: async (tokens, forUser) => {
      // 갱신을 시작한 계정과 지금 계정이 다르면 쓰지 않는다 (확인과 반영 사이에 기다림이 없다)
      if (forUser !== undefined && get().userId !== forUser) return false;
      set({ tokens });
      await persist();
      return true;
    },
    setExpired: (expired) => set({ expired }),
    expire: async () => {
      // 토큰만 버리고 계정 · 온보딩 정보는 남긴다 — 같은 계정으로 다시 로그인하면 이어 간다 (FR-67-01)
      set({ tokens: null, expired: false });
      await persist();
    },
    finishOnboarding: async () => {
      set({ onboarded: true });
      await persist();
    },
    signOut: async () => {
      const identity = get().userId;
      const operation = writing.then(async () => {
        if (get().userId !== identity) return;
        await SecureStore.deleteItemAsync(KEY);
        if (get().userId === identity)
          set({ tokens: null, user: null, userId: null, onboarded: false, expired: false });
      });
      writing = operation.catch(() => {});
      await operation;
    },
  };
});
