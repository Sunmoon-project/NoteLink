import type { Material, MaterialKind, MaterialSource, NoteDiagram } from '@notelink/shared';
import type { Types } from 'mongoose';

/** DB에서 읽은 노트 한 줄(lean). 서비스가 쓰는 필드만 적는다 */
export interface MaterialRow {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  folderId: Types.ObjectId;
  kind: string;
  source: string;
  title: string;
  description?: string | null;
  avatarItemId?: Types.ObjectId | null;
  processing: {
    status: string;
    progress?: number;
    jobId?: Types.ObjectId | null;
    regenJobId?: Types.ObjectId | null;
    lastRegenJobId?: Types.ObjectId | null;
    checkedAt?: Date;
  };
  summary?: { sections: { heading: string; body: string }[]; points?: string[] } | null;
  keywords?: string[];
  diagrams?: NoteDiagram[];
  concepts?: string[];
  bookmarks?: { atSec: number; label?: string }[];
  pages?: {
    pageNo: number;
    imageUrl: string;
    sizeBytes: number;
    ocrText?: string | null;
    takenAt?: Date | null;
  }[];
  blobUrls?: string[];
  savedAt?: Date | null;
  requestId?: string;
  requestFingerprint?: string;
  jobClaimToken?: string;
  jobClaimedAt?: Date;
  deletedAt?: Date | null;
  createdAt: Date;
}

type AppProcessingStatus = Material['processing']['status'];

/**
 * 앱에 보내는 노트 모양(packages/shared Material). ownerId · concepts · blobUrls · savedAt · 요청 키는 서버 값이라 보내지 않는다.
 * pageUrl 을 주면 쪽(pages)을 담고 이미지 주소를 그 함수로 바꾼다(읽기 SAS). 주지 않으면 쪽을 담지 않는다(목록)
 */
export function toAppMaterial(row: MaterialRow, pageUrl?: (blobUrl: string) => string): Material {
  const out: Material = {
    _id: row._id.toString(),
    folderId: row.folderId.toString(),
    kind: row.kind as MaterialKind,
    source: row.source as MaterialSource,
    title: row.title,
    description: row.description ?? null,
    avatarItemId: row.avatarItemId ? row.avatarItemId.toString() : null,
    processing: {
      status: row.processing.status as AppProcessingStatus,
      progress: row.processing.progress ?? 0,
      jobId: row.processing.jobId ? row.processing.jobId.toString() : null,
    },
    summary: row.summary
      ? {
          sections: row.summary.sections.map((s) => ({ heading: s.heading, body: s.body })),
          points: row.summary.points ?? [],
        }
      : null,
    keywords: row.keywords ?? [],
    bookmarks: (row.bookmarks ?? []).map((b) => ({
      atSec: b.atSec,
      ...(b.label ? { label: b.label } : {}),
    })),
    createdAt: row.createdAt.toISOString(),
  };
  if (row.diagrams && row.diagrams.length > 0) {
    out.diagrams = row.diagrams.map((d) => ({ after: d.after ?? null, diagram: d.diagram }));
  }
  if (pageUrl && row.pages && row.pages.length > 0) {
    out.pages = row.pages.map((p) => ({
      pageNo: p.pageNo,
      imageUrl: pageUrl(p.imageUrl),
      sizeBytes: p.sizeBytes,
      ocrText: p.ocrText ?? null,
      takenAt: p.takenAt ? p.takenAt.toISOString() : null,
    }));
  }
  return out;
}
