import type { AiJob } from '@notelink/shared';

/** AI 서버가 없어(기기 저장 모드 · AI 점검 중) 작업이 대기열에 머무는 단계 이름 */
export const AI_WAITING_STEP = 'AI 서버 연결 대기';

/** 서버가 붙을 때까지 처리되지 않고 기다리는 작업인지 (FR-65-05) */
export const aiWaiting = (job?: Pick<AiJob, 'status' | 'step'> | null) =>
  !!job && job.status === 'queued' && job.step === AI_WAITING_STEP;
