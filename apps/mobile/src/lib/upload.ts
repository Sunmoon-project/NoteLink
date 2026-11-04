import { File, UploadType } from 'expo-file-system';
import { UPLOAD_RULES } from '@notelink/shared';
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
export function checkFile(kind: Kind, f: LocalFile): { ok: true } | { ok: false; reason: string } {
  const rule = UPLOAD_RULES[kind];
  const ext = f.name.split('.').pop()?.toLowerCase() ?? '';
  if (!(rule.exts as readonly string[]).includes(ext))
    return {
      ok: false,
      reason: `${rule.exts.map((e) => e.toUpperCase()).join(' · ')}만 올릴 수 있어요`,
    };
  if ((f.size ?? 0) > rule.maxBytes)
    return {
      ok: false,
      reason: `${Math.round(rule.maxBytes / 1024 / 1024)}MB 이하만 올릴 수 있어요`,
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
        wav: 'audio/wav',
      } as Record<string, string>
    )[ext ?? ''] ?? 'application/octet-stream'
  );
};

/** 올릴 수 없는 파일이거나 Blob이 2xx가 아닌 응답을 준 경우 */
export class UploadError extends Error {}

export async function uploadToBlob(
  kind: Kind,
  f: LocalFile,
  onProgress?: (pct: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const file = new File(f.uri);
  const contentType = f.mimeType ?? guessType(f.name);
  const sizeBytes = f.size ?? file.size ?? 0;
  // 호출하는 화면이 빠뜨려도 형식 · 용량 검사를 거친다
  const check = checkFile(kind, { ...f, size: sizeBytes });
  if (!check.ok) throw new UploadError(check.reason);
  if (env.localData) {
    // 기기 저장 모드: 고른 파일을 앱 저장 공간에 복사해 두고 그 주소를 쓴다 (원본을 지워도 남게)
    onProgress?.(0);
    const kept = keepFile(f.uri, f.name);
    onProgress?.(100);
    return kept.uri;
  }
  const sas = await api.upload.getSas({ kind, fileName: f.name, contentType, sizeBytes });
  const task = file.createUploadTask(sas.uploadUrl, {
    httpMethod: 'PUT',
    uploadType: UploadType.BINARY_CONTENT,
    headers: sas.headers,
    mimeType: contentType,
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
