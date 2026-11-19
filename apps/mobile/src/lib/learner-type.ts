import type { LearnerType } from '@notelink/shared';

/** 학습자 구분 표시 이름(온보딩 선택 · 스터디룸 대상 배지 공용) */
export const LEARNER_TYPES: [LearnerType, string][] = [
  ['middle_high', '중·고등학생'],
  ['university', '대학생'],
  ['worker', '직장인'],
];

export const learnerTypeLabel = (type?: LearnerType | null) =>
  LEARNER_TYPES.find(([key]) => key === type)?.[1];
