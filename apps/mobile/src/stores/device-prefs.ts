import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';

// 기기마다 다른 설정(서버 사용자 설정과 따로): 이 기기에서 가로로 눕히면 탁상 모드를 켤지
const KEY = 'notelink.device-prefs';

type Prefs = { deskMode: boolean };
const DEFAULTS: Prefs = { deskMode: true };

export const useDevicePrefs = create<
  Prefs & { loaded: boolean; load: () => Promise<void>; set: (p: Partial<Prefs>) => void }
>((set, get) => ({
  ...DEFAULTS,
  loaded: false,
  load: async () => {
    if (get().loaded) return;
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      const v: unknown = raw ? JSON.parse(raw) : null;
      const deskMode =
        v && typeof v === 'object' && typeof (v as Prefs).deskMode === 'boolean'
          ? (v as Prefs).deskMode
          : DEFAULTS.deskMode;
      set({ deskMode, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  set: (p) => {
    set(p);
    const { deskMode } = get();
    // 저장에 실패해도 이번 실행 동안은 바꾼 값대로 동작한다
    void Promise.resolve()
      .then(() => SecureStore.setItemAsync(KEY, JSON.stringify({ deskMode })))
      .catch(() => {});
  },
}));
