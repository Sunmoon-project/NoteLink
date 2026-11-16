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
    let deskMode = DEFAULTS.deskMode;
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      const v: unknown = raw ? JSON.parse(raw) : null;
      if (v && typeof v === 'object' && typeof (v as Prefs).deskMode === 'boolean')
        deskMode = (v as Prefs).deskMode;
    } catch {
      // 읽지 못하면 기본값으로 둔다
    }
    // 읽는 사이 사용자가 스위치를 바꿨으면 늦게 온 저장값으로 덮지 않는다
    if (get().loaded) return;
    set({ deskMode, loaded: true });
  },
  set: (p) => {
    set({ ...p, loaded: true });
    const { deskMode } = get();
    // 저장에 실패해도 이번 실행 동안은 바꾼 값대로 동작한다
    void Promise.resolve()
      .then(() => SecureStore.setItemAsync(KEY, JSON.stringify({ deskMode })))
      .catch(() => {});
  },
}));
