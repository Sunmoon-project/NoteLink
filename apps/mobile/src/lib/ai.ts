import type { AiJob } from '@notelink/shared';

/** AI 서버가 없어(기기 저장 모드 · AI 점검 중) 작업이 대기열에 머무는 단계 이름 */
export const AI_WAITING_STEP = 'AI 서버 연결 대기';

/** 서버가 붙을 때까지 처리되지 않고 기다리는 작업인지 (FR-65-05) */
export const aiWaiting = (job?: Pick<AiJob, 'status' | 'step'> | null) =>
  !!job && job.status === 'queued' && job.step === AI_WAITING_STEP;

/** "필기 정리" → "필기 정리는", "문서 요약" → "문서 요약은" — 마지막 글자 받침으로 은/는을 고른다 */
export const withTopic = (word: string) => {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (c >= 0 && c < 11172 && c % 28 !== 0 ? '은' : '는');
};
