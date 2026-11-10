import type { PointReasonType } from '../schemas/point-ledger.schema.js';

/**
 * 포인트를 얼마나, 어떤 이유로 주는지 한 곳에 모아 둔다.
 * 금액과 하루 한도는 팀 기준(이슈 #193 · #194)을 따른다.
 */
export const SESSION_COMPLETE_MIN_SEC = 600; // 순공 10분 이상이면 적립
export const SESSION_COMPLETE_POINTS = 20;
export const SESSION_DAILY_REWARD_LIMIT = 2; // 세션 보상은 하루(서울 기준) 2번까지
export const QUIZ_CORRECT_POINTS = 4; // 정답 하나당
export const QUIZ_DAILY_POINT_LIMIT = 40; // 퀴즈 보상은 하루 40포인트까지 (한도를 적용하는 곳은 퀴즈 API)

export interface PointReward {
    amount: number;
    reasonType: PointReasonType;
    description: string;
}

/** 순공 세션이 끝났을 때의 보상. 10분이 안 되면 undefined(적립 없음). 하루 횟수 한도는 부르는 쪽이 확인한다 */
export function sessionReward(durationSec: number): PointReward | undefined {
    if (!Number.isFinite(durationSec) || durationSec < SESSION_COMPLETE_MIN_SEC) return undefined;
    return { amount: SESSION_COMPLETE_POINTS, reasonType: 'session_complete', description: '순공 세션 완료' };
}

/** 퀴즈에서 맞힌 개수만큼의 보상. 맞힌 게 없으면 undefined. 하루 한도는 부르는 쪽이 확인한다 */
export function quizReward(correctCount: number): PointReward | undefined {
    if (!Number.isInteger(correctCount) || correctCount <= 0) return undefined;
    return {
        amount: QUIZ_CORRECT_POINTS * correctCount,
        reasonType: 'quiz_correct',
        description: `퀴즈 정답 ${correctCount}개`,
    };
}
