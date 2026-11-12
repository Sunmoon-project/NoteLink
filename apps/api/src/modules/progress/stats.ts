// 통계 계산 (순수 함수). 날짜는 모두 서울 기준 'YYYY-MM-DD' 글자다. 앱의 local/stats.ts와 같은 규칙이다
import { STREAK_MIN_SEC } from '../session/study-time.js';
import { addDays } from './week.js';

/** 하루 순공 시간으로 색 진하기(0~4)를 정한다: 없음 / 30분 미만 / 1시간 미만 / 2시간 미만 / 그 이상 */
export function levelOf(totalSec: number): number {
    if (totalSec <= 0) return 0;
    if (totalSec < 30 * 60) return 1;
    if (totalSec < 60 * 60) return 2;
    if (totalSec < 2 * 3600) return 3;
    return 4;
}

/** '공부한 날'인지 (하루 순공 10분 이상, FR-09-09) */
export const isStreakDay = (totalSec: number): boolean => totalSec >= STREAK_MIN_SEC;

/** 지금 이어지는 연속 일수. 오늘 아직 10분을 못 채웠으면 어제까지의 연속을 센다 (하루를 건너뛰면 끊긴다) */
export function currentStreak(okDays: Set<string>, today: string): number {
    let day = okDays.has(today) ? today : addDays(today, -1);
    let count = 0;
    while (okDays.has(day)) {
        count++;
        day = addDays(day, -1);
    }
    return count;
}

/** 가장 길게 이어진 연속 일수 */
export function longestStreak(okDays: Set<string>): number {
    let best = 0;
    for (const day of okDays) {
        if (okDays.has(addDays(day, -1))) continue; // 연속의 첫날에서만 센다
        let len = 0;
        for (let d = day; okDays.has(d); d = addDays(d, 1)) len++;
        best = Math.max(best, len);
    }
    return best;
}

/** 시작 시각(UTC)의 서울 시(0~23). 서울은 UTC+9이고 서머타임이 없다 */
export const seoulHour = (at: Date): number => new Date(at.getTime() + 9 * 3600 * 1000).getUTCHours();

/** 공부 시간이 가장 많은 시작 시각(서울). 같으면 이른 시각, 기록이 없으면 -1 */
export function peakHour(sessions: { startedAt: Date; durationSec: number }[]): number {
    const byHour = new Array<number>(24).fill(0);
    for (const s of sessions) {
        const hour = seoulHour(s.startedAt);
        byHour[hour] = (byHour[hour] ?? 0) + s.durationSec;
    }
    let best = -1;
    let bestSec = 0;
    byHour.forEach((sec, hour) => {
        if (sec > bestSec) {
            best = hour;
            bestSec = sec;
        }
    });
    return best;
}
