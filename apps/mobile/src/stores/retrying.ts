import { create } from 'zustand';

/** 폴더별로 다시 요약을 넣고 아직 끝난 상태를 읽지 못한 자료. 폴더 화면을 닫았다 열어도 남는다(Codex #520 5차 리뷰) */
export const useRetrying = create<{
  byFolder: Record<string, string[]>;
  track: (folderId: string, materialId: string) => void;
  /** 끝난 상태를 읽었거나 목록에서 없어진 자료의 추적을 푼다 */
  untrack: (folderId: string, materialIds: string[]) => void;
  reset: () => void;
}>((set) => ({
  byFolder: {},
  track: (folderId, materialId) =>
    set(({ byFolder }) => {
      const ids = byFolder[folderId] ?? [];
      return ids.includes(materialId)
        ? { byFolder }
        : { byFolder: { ...byFolder, [folderId]: [...ids, materialId] } };
    }),
  untrack: (folderId, materialIds) =>
    set(({ byFolder }) => {
      const { [folderId]: ids = [], ...rest } = byFolder;
      const left = ids.filter((m) => !materialIds.includes(m));
      return { byFolder: left.length ? { ...rest, [folderId]: left } : rest };
    }),
  reset: () => set({ byFolder: {} }),
}));

/** 그 폴더에서 다시 요약해 끝나기를 기다리는 자료 */
export const retryingIn = (folderId: string) => useRetrying.getState().byFolder[folderId] ?? [];
