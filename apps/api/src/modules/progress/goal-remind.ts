// 반복 목표 미달성 리마인드(FR-11-07 · 08)의 시각 · 문구 · 설정 변경 규칙. DB · 시계를 읽지 않는 순수 함수다.
// 날짜는 서울 기준 'YYYY-MM-DD' 글자, 시각은 서울 시각의 'HH:mm'이다.
import { addDays } from './week.js';

/** 리마인드 시각의 기본값(요구사항 FR-11-07 "기본 21시"). 만들 때 안 보내면 이 값을 저장하고, 값이 비어 있는 옛 목표는 이 값으로 본다 */
export const DEFAULT_REMIND_TIME = '21:00';

/** 리마인드 시각이 지난 뒤 이만큼까지만 보낸다(서버가 늦게 켜져도 한참 지난 "O분 남았어요"는 보내지 않는다). 서울 자정에서도 끝난다 */
export const REMIND_WINDOW_MS = 2 * 60 * 60 * 1000;
/** 하루에 보내 보는 최대 횟수(처음 + 재시도 2회) */
export const REMIND_MAX_ATTEMPTS = 3;
/** 실패한 n번째 시도(1부터) 뒤 다음 시도까지 기다리는 시간: 2분, 10분 */
export const REMIND_RETRY_DELAYS_MS = [2 * 60 * 1000, 10 * 60 * 1000];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 저장된 리마인드 시각을 'HH:mm'으로. 없거나 형식이 틀리면 기본값 */
export function normalizeRemindTime(remindTime: string | null | undefined): string {
  return remindTime && HHMM.test(remindTime) ? remindTime : DEFAULT_REMIND_TIME;
}

/** 그날(서울)의 리마인드 시작 순간 */
export function remindStart(today: string, remindTime: string | null | undefined): Date {
  return new Date(`${today}T${normalizeRemindTime(remindTime)}:00+09:00`);
}

/** 그날(서울)의 리마인드를 보낼 수 있는 끝 순간(포함하지 않음): 시작 + 2시간, 서울 자정을 넘지 않는다 */
export function remindEnd(today: string, remindTime: string | null | undefined): Date {
  const start = remindStart(today, remindTime).getTime();
  const midnight = new Date(`${addDays(today, 1)}T00:00:00+09:00`).getTime();
  return new Date(Math.min(start + REMIND_WINDOW_MS, midnight));
}

/** now가 오늘의 리마인드 시각 이후 · 끝 전인지 */
export function inRemindWindow(
  now: Date,
  today: string,
  remindTime: string | null | undefined,
): boolean {
  return now >= remindStart(today, remindTime) && now < remindEnd(today, remindTime);
}

/** 그 날짜(서울)의 요일 번호 (0=일 ... 6=토) */
export function weekdayOfDate(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** 푸시 제목 · 본문. leftMin은 1 이상이다(todayMin은 내림이라 목표를 채우면 보내지 않는다) */
export function remindMessage(
  name: string,
  targetMin: number,
  todayMin: number,
): { title: string; body: string } {
  return {
    title: `오늘 목표까지 ${targetMin - todayMin}분 남았어요`,
    body: `${name} · ${targetMin}분 중 ${todayMin}분을 채웠어요`,
  };
}
