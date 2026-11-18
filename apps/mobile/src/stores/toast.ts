import { create } from 'zustand';

// id: 같은 글을 다시 띄워도 새 토스트로 들어오게(화면이 key로 쓴다)
type Toast = { msg: string | null; id: number; show: (msg: string) => void; hide: () => void };
let timer: ReturnType<typeof setTimeout> | undefined;

export const useToast = create<Toast>((set) => ({
  msg: null,
  id: 0,
  show: (msg) => {
    set((s) => ({ msg, id: s.id + 1 }));
    clearTimeout(timer);
    timer = setTimeout(() => set({ msg: null }), 2200);
  },
  hide: () => set({ msg: null }),
}));

export const toast = (msg: string) => useToast.getState().show(msg);
