// 주(월~일) 계산. 날짜는 모두 서울 기준 'YYYY-MM-DD' 글자다 (오늘 날짜는 session의 seoulDate로 구한다)

const DAY_MS = 24 * 3600 * 1000;
const utcMidnight = (day: string) => new Date(`${day}T00:00:00Z`);

/** 날짜에 n일을 더한다 (음수면 뺀다) */
export function addDays(day: string, n: number): string {
    return new Date(utcMidnight(day).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** 그 날짜가 속한 주의 월요일 */
export function weekStartOf(day: string): string {
    const dow = utcMidnight(day).getUTCDay(); // 0=일 ... 6=토
    return addDays(day, -((dow + 6) % 7));
}

/** 두 날짜 사이의 일수 (b - a) */
export function daysBetween(a: string, b: string): number {
    return Math.round((utcMidnight(b).getTime() - utcMidnight(a).getTime()) / DAY_MS);
}

/** start부터 days일 동안의 순공 초를 더한다 */
export function sumRange(totals: Map<string, number>, start: string, days: number): number {
    let sec = 0;
    for (let i = 0; i < days; i++) sec += totals.get(addDays(start, i)) ?? 0;
    return sec;
}
