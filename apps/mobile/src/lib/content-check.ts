// 올리는 자료가 정리할 만한 내용을 담고 있는지 기기에서 먼저 본다.
// 별 내용 없는 녹음 · 문서를 서버와 AI에 보내기 전에 알려 주는 것이 목적이라 기준은 넉넉하게 잡는다
// (실제 내용 판단은 서버 · AI가 다시 한다). 걸려도 사용자가 "그래도 올리기"로 넘어갈 수 있다.
export const CONTENT_MIN = {
  /** 녹음 길이 — 이보다 짧으면 강의 · 수업 내용이 담기기 어렵다 */
  recordingSec: 30,
  /** 녹음 중 목소리가 들린 비율 — 이보다 낮으면 거의 무음 */
  voicedRatio: 0.15,
  /** 이 소리 크기(dBFS)를 넘는 순간을 "소리가 있음"으로 센다 */
  voicedDb: -45,
  /** 올린 녹음 파일 크기 — 낮은 음질로도 30초가 안 되는 크기 */
  audioBytes: 80 * 1024,
  /** 올린 PDF 크기 — 빈 페이지 한 장 수준 */
  pdfBytes: 15 * 1024,
  /** 올린 이미지 문서 크기 — 거의 단색인 사진 */
  imageBytes: 30 * 1024,
} as const;

/** 실시간 녹음을 끝낼 때: 길이 · 소리가 있던 비율 */
export function recordingIssue(durationSec: number, voicedRatio: number): string | null {
  if (durationSec < CONTENT_MIN.recordingSec)
    return `녹음이 ${CONTENT_MIN.recordingSec}초보다 짧아 정리할 내용이 거의 없어요`;
  if (voicedRatio < CONTENT_MIN.voicedRatio) return '소리가 거의 녹음되지 않았어요';
  return null;
}

/** 올린 녹음 파일: 크기로 길이를 어림한다 */
export function audioFileIssue(sizeBytes?: number | null): string | null {
  if (sizeBytes != null && sizeBytes < CONTENT_MIN.audioBytes)
    return '녹음이 너무 짧아 정리할 내용이 거의 없어 보여요';
  return null;
}

/** 올린 문서(PDF · 이미지) */
export function documentIssue(f: { name: string; size?: number | null }): string | null {
  if (f.size == null) return null;
  const pdf = f.name.toLowerCase().endsWith('.pdf');
  if (f.size < (pdf ? CONTENT_MIN.pdfBytes : CONTENT_MIN.imageBytes))
    return pdf ? '페이지에 내용이 거의 없는 문서 같아요' : '내용이 거의 보이지 않는 이미지 같아요';
  return null;
}
