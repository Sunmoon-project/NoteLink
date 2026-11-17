import { create } from 'zustand';

type Toast = { msg: string | null; show: (msg: string) => void; hide: () => void };
let timer: ReturnType<typeof setTimeout> | undefined;

export const useToast = create<Toast>((set) => ({
  msg: null,
  show: (msg) => {
    set({ msg });
    clearTimeout(timer);
    timer = setTimeout(() => set({ msg: null }), 2200);
  },
  hide: () => set({ msg: null }),
}));

export const toast = (msg: string) => useToast.getState().show(msg);
