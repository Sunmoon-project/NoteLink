import { File, UploadType } from 'expo-file-system';
import { UPLOAD_RULES, uploadMaxBytes } from '@notelink/shared';
import { api } from './api';
import { env } from './env';
import { keepFile } from './local/storage';

// 앱 → Azure Blob 직접 업로드 (p.19: 서버를 거치지 않는 직접 연결)
// 1) 메인 API에서 SAS 주소 발급 → 2) PUT으로 바로 올림 → 3) blobUrl만 서버에 저장

export type LocalFile = {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
};
type Kind = keyof typeof UPLOAD_RULES;

/** 형식 · 용량은 올리기 전에 기기에서 먼저 확인한다 (p.102) */
export function checkFile(
  kind: Kind,
  f: LocalFile,
  purpose?: 'report' | 'chat',
): { ok: true } | { ok: false; reason: string } {
  const rule = UPLOAD_RULES[kind];
  const maxBytes = uploadMaxBytes(kind, purpose);
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  if (!(rule.exts as readonly string[]).includes(ext))
    return {
      ok: false,
      reason: `${rule.exts.map((e) => e.toUpperCase()).join(' · ')}만 올릴 수 있어요`,
    };
  if ((f.size ?? 0) > maxBytes)
    return {
      ok: false,
      reason: `${Math.round(maxBytes / 1024 / 1024)}MB 이하만 올릴 수 있어요`,
    };
  return { ok: true };
}

const guessType = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase();
  return (
    (
      {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        heic: 'image/heic',
        pdf: 'application/pdf',
        mp3: 'audio/mpeg',
        m4a: 'audio/mp4',
        aac: 'audio/aac',
        mp4: 'audio/mp4',
        wav: 'audio/wav',
      } as Record<string, string>
    )[ext ?? ''] ?? 'application/octet-stream'
  );
};

/**
 * 녹음의 실제 담는 형식(파일 앞 12바이트). 4~7번째 바이트가 'ftyp'면 MP4 계열(m4a)이다.
 * 녹음 앱이 MP4(AAC 음성)를 .aac · .mp4 이름으로 저장하는 일이 있는데, 확장자대로 올리면
 * Blob 이름 · 형식(audio/aac)과 내용이 달라 Azure Speech가 422로 거절한다(실기기 확인, #508 후속)
 */
export function isMp4Container(head: Uint8Array): boolean {
  return head.length >= 8 && String.fromCharCode(...head.slice(4, 8)) === 'ftyp';
}

/** MP4 계열인데 확장자가 m4a가 아니면 이름 · 형식을 m4a로 맞춘다. 읽지 못하면 그대로 둔다 */
function realAudio(file: File, f: LocalFile): LocalFile {
  if (f.name.toLowerCase().endsWith('.m4a')) return f;
  let head: Uint8Array;
  try {
    const handle = file.open();
    try {
      head = handle.readBytes(12);
    } finally {
      handle.close();
    }
  } catch {
    return f;
  }
  if (!isMp4Container(head)) return f;
  const dot = f.name.lastIndexOf('.');
  return { ...f, name: `${dot < 0 ? f.name : f.name.slice(0, dot)}.m4a`, mimeType: 'audio/mp4' };
}

/** 올릴 수 없는 파일이거나 Blob이 2xx가 아닌 응답을 준 경우 */
export class UploadError extends Error {}

export async function uploadToBlob(
  kind: Kind,
  f: LocalFile,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
  purpose?: 'report' | 'chat',
): Promise<string> {
  const file = new File(f.uri);
  // 녹음은 확장자 대신 실제 내용으로 이름 · 형식을 정한다(서버 · Blob · Azure Speech가 모두 이 이름을 쓴다)
  if (kind === 'audio' && !env.localData) f = realAudio(file, f);
  const contentType = f.mimeType ?? guessType(f.name);
  const sizeBytes = f.size ?? file.size ?? 0;
  // 호출하는 화면이 빠뜨려도 형식 · 용량 검사를 거친다
  const check = checkFile(kind, { ...f, size: sizeBytes }, purpose);
  if (!check.ok) throw new UploadError(check.reason);
  if (env.localData) {
    // 기기 저장 모드: 고른 파일을 앱 저장 공간에 복사해 두고 그 주소를 쓴다 (원본을 지워도 남게)
    onProgress?.(0);
    const kept = keepFile(f.uri, f.name);
    onProgress?.(100);
    return kept.uri;
  }
  const sas = await api.upload.getSas({
    kind,
    fileName: f.name,
    contentType,
    sizeBytes,
    ...(purpose ? { purpose } : {}),
  });
  // 서버가 확장자에 맞게 바로잡은 형식(예: .heic의 image/heif → image/heic)으로 올린다. 기기가 추측한 형식으로
  // 덮어쓰면 그 뒤 사진 검사 · 노트 등록이 형식이 다르다고 거절한다. 서버가 주지 않을 때만 기기 형식
  const putType = sas.headers['Content-Type'] ?? contentType;
  const task = file.createUploadTask(sas.uploadUrl, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: { ...sas.headers, 'Content-Type': putType },
    mimeType: putType,
    signal,
    onProgress: ({ bytesSent, totalBytes }) =>
      onProgress?.(Math.round((bytesSent / Math.max(1, totalBytes)) * 100)),
  });
  // uploadAsync는 403(SAS 만료 등)도 resolve하므로 상태 코드를 직접 확인한다
  const res = await task.uploadAsync();
  if (res.status < 200 || res.status >= 300)
    throw new UploadError(`업로드에 실패했어요 (HTTP ${res.status})`);
  return sas.blobUrl;
}
