// 복습 알림(FR-37-08)의 시각 · 문구 · 상수. DB · 시계를 읽지 않는 순수 함수다.
// 날짜는 서울 기준 'YYYY-MM-DD' 글자, 시각은 서울 시각의 'HH:mm'이다.

/**
 * 복습 알림을 보내기 시작하는 시각(서울). 바꾸기 쉽게 상수로 둔다. 반복 목표 리마인드의 기본 시각(21:00)과
 * 겹치지 않는 저녁 공부 시간대로 19:00으로 정했다. 이 시각 이후 서버가 켜져 있으면 그날(서울 자정 전) 안에 보내고,
 * 날짜가 바뀌면 그날 것은 보내지 않는다
 */
export const REVIEW_REMIND_TIME = '19:00';
/** 알림에 적는 문제 수의 상한: 오늘의 복습 세트 크기(apps/ai services/quiz/review.py REVIEW_SET_SIZE · today-review TODAY_SIZE)와 같다 */
export const REVIEW_REMIND_MAX_COUNT = 5;

/** 한 번에 처리하는 사용자 수(한 번의 확인에서) */
export const REVIEW_REMIND_PAGE = 200;
/** 선점한 서버가 이 시간 안에 결과를 기록하지 않으면 죽은 것으로 보고 다른 서버가 이어받는다 */
export const REVIEW_REMIND_LEASE_MS = 2 * 60 * 1000;
/** 한 사용자에게 보내 보는 최대 횟수(처음 + 재시도 2회. 이어받기도 한 번으로 센다) */
export const REVIEW_REMIND_MAX_ATTEMPTS = 3;
/** 실패한 n번째 시도(1부터) 뒤 다음 시도까지 기다리는 시간: 2분, 10분 */
export const REVIEW_REMIND_RETRY_DELAYS_MS = [2 * 60 * 1000, 10 * 60 * 1000];
/** 결과 기록이 실패했을 때 다시 쓰기 전에 기다리는 시간: 0.2초, 0.5초(그래도 실패하면 보관해 다음 확인에서 먼저 다시 쓴다) */
export const REVIEW_REMIND_RECORD_DELAYS_MS = [200, 500];
/** 기록하지 못한 sent 를 메모리에 보관하는 최대 개수(넘으면 오래된 것부터 버린다) */
export const REVIEW_REMIND_UNRECORDED_MAX = 200;
/** review_reminders 문서를 지우는 때(TTL): 하루 한 번 표시는 그날만 필요하다 */
export const REVIEW_REMIND_TTL_SECONDS = 14 * 24 * 60 * 60;

/** 날짜 글자에 일수를 더한다 */
export function addDays(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** 그날(서울)의 알림 시작 순간 */
export function remindStart(day: string): Date {
  return new Date(`${day}T${REVIEW_REMIND_TIME}:00+09:00`);
}

/** 그날(서울)의 끝 = 다음 날 서울 0시. 오늘의 복습이 "내일 0시 전에 복습 날짜가 된 문제"를 고르는 기준(today.py tomorrow)이기도 하다 */
export function dayEnd(day: string): Date {
  return new Date(`${addDays(day, 1)}T00:00:00+09:00`);
}

/** now 가 그날 알림을 보낼 수 있는 때(시작 이후 · 서울 자정 전)인지 */
export function inRemindWindow(now: Date, day: string): boolean {
  return now >= remindStart(day) && now < dayEnd(day);
}

/** 푸시 제목 · 본문. count 는 REVIEW_REMIND_MAX_COUNT 로 자른 문제 수(1 이상) */
export function remindMessage(count: number): { title: string; body: string } {
  return {
    title: '오늘 복습할 문제가 있어요',
    body: `복습할 문제 ${Math.min(Math.max(count, 1), REVIEW_REMIND_MAX_COUNT)}개가 기다리고 있어요`,
  };
}
