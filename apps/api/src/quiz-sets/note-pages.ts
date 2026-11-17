/** 처리기 입력의 노트 글 한 쪽(apps/ai services/quiz/generate.py 「input」 material.pages) */
export interface WorkerNotePage {
  pageNo: number;
  ocrText: string;
}

/** 필기 · 문서 노트의 쪽(pages)에서 글에 쓰는 값만 */
export interface NotePageRow {
  pageNo: number;
  ocrText?: string | null;
}

/** 글이 있는 쪽만(정리 전 · 빈 쪽은 처리기가 문제를 낼 수 없다) */
export function textPages(pages: NotePageRow[] | undefined): WorkerNotePage[] {
  return (pages ?? [])
    .filter((p): p is NotePageRow & { ocrText: string } => !!p.ocrText?.trim())
    .map((p) => ({ pageNo: p.pageNo, ocrText: p.ocrText }));
}
