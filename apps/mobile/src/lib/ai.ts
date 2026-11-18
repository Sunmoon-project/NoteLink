import type { AiJob } from '@notelink/shared';

/** AI 서버가 없어(기기 저장 모드 · AI 점검 중) 작업이 대기열에 머무는 단계 이름 */
export const AI_WAITING_STEP = 'AI 서버 연결 대기';

/** 서버가 붙을 때까지 처리되지 않고 기다리는 작업인지 (FR-65-05) */
export const aiWaiting = (job?: Pick<AiJob, 'status' | 'step'> | null) =>
  !!job && job.status === 'queued' && job.step === AI_WAITING_STEP;

/**
 * AI 처리기가 알려 주는 단계(ai_jobs.step) → 변환 화면 단계(1 인식 · 2 정리 · 3 요약).
 * apps/ai의 report(값, 단계)와 같은 이름이다. 진행률 구간은 종류마다 달라(녹음은 음성 인식 내내 0%,
 * 정리가 20~90%) 진행률로 고르면 정리 중에도 「음성 인식」으로 보였다
 */
const STAGE_OF_STEP: Record<string, 1 | 2 | 3> = {
  material: 1, // 녹음: 강의 자료 읽기(음성 인식 전)
  stt: 1,
  ocr: 1,
  organize: 2,
  split: 2,
  refine: 2,
  embed: 3,
};

/** 모르는 단계 · 대기 중(단계 없음 · AI_WAITING_STEP)만 진행률로 고른다 */
export const stageOf = (step: string | null | undefined, pct: number): 1 | 2 | 3 =>
  (step ? STAGE_OF_STEP[step] : undefined) ?? (pct < 50 ? 1 : pct < 85 ? 2 : 3);

/** "필기 정리" → "필기 정리는", "문서 요약" → "문서 요약은" — 마지막 글자 받침으로 은/는을 고른다 */
export const withTopic = (word: string) => {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return word + (c >= 0 && c < 11172 && c % 28 !== 0 ? '은' : '는');
};
