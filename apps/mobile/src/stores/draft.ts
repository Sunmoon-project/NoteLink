import { create } from 'zustand';
import type { MaterialKind, MaterialSource } from '@notelink/shared';
import type { LocalFile } from '@/lib/upload';

// 촬영 · 선택한 파일을 업로드(AI 변환) 화면까지 넘겨주는 임시 보관함
type Draft = {
  folderId: string | null;
  kind: MaterialKind;
  source: MaterialSource;
  files: LocalFile[];
  fileVersion: number;
  creationId: string | null;
  getCreationId: () => string;
  uploads: { file: LocalFile; url: string }[];
  rememberUpload: (file: LocalFile, url: string) => void;
  title: string;
  description: string;
  avatar: string | null;
  set: (
    p: Partial<
      Omit<
        Draft,
        | 'set'
        | 'reset'
        | 'uploads'
        | 'rememberUpload'
        | 'fileVersion'
        | 'creationId'
        | 'getCreationId'
      >
    >,
  ) => void;
  reset: () => void;
};

const empty = {
  folderId: null,
  kind: 'handwriting' as MaterialKind,
  source: 'camera' as MaterialSource,
  files: [] as LocalFile[],
  fileVersion: 0,
  creationId: null as string | null,
  uploads: [] as { file: LocalFile; url: string }[],
  title: '',
  description: '',
  avatar: null,
};

export const useDraft = create<Draft>((set, get) => ({
  ...empty,
  set: (p) =>
    set((state) => ({
      ...p,
      creationId: null,
      ...(p.files
        ? {
            fileVersion: state.fileVersion + 1,
            uploads: state.uploads.filter((upload) => p.files!.includes(upload.file)),
          }
        : {}),
    })),
  getCreationId: () => {
    const existing = get().creationId;
    if (existing) return existing;
    const requestId = `material-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    set({ creationId: requestId });
    return requestId;
  },
  rememberUpload: (file, url) =>
    set((state) => {
      // 교체·제거·초기화 이후 도착한 응답은 새 초안에 적용하지 않는다.
      if (!state.files.includes(file)) return state;
      return {
        uploads: [...state.uploads.filter((upload) => upload.file !== file), { file, url }],
      };
    }),
  reset: () => set((state) => ({ ...empty, fileVersion: state.fileVersion + 1 })),
}));
