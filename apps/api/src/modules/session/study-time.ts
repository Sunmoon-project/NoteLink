// "오늘"은 서울 기준 날짜다 (README 규칙). 날짜 글자는 'YYYY-MM-DD'
const SEOUL_DATE = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

export function seoulDate(date: Date): string {
    return SEOUL_DATE.format(date);
}

export interface PauseSpan {
    startedAt: Date;
    endedAt: Date | null;
}

/**
 * 순공 시간(초): 시작~끝에서 일시정지한 시간을 뺀다.
 * 아직 끝나지 않은 정지는 끝나는 시각까지로 센다
 */
export function netDurationSec(startedAt: Date, pauses: PauseSpan[], endedAt: Date): number {
    const pausedMs = pauses.reduce(
        (sum, pause) => sum + ((pause.endedAt ?? endedAt).getTime() - pause.startedAt.getTime()),
        0,
    );
    return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime() - pausedMs) / 1000));
}

/** 하루 기준 순공 10분 이상이면 '공부한 날'이고 스트릭에 센다 (FR-09-09) */
export const STREAK_MIN_SEC = 10 * 60;
/** 하루에 셀 수 있는 최대 순공 시간 16시간 (FR-06-15) */
export const DAILY_CAP_SEC = 16 * 3600;
/** 순공이 24시간 이상 이어진 세션은 방치로 보고 통계에서 뺀다 (FR-06-16) */
export const ABUSE_SEC = 24 * 3600;

const DAY_MS = 24 * 3600 * 1000;
const SEOUL_OFFSET_MS = 9 * 3600 * 1000; // 서울은 UTC+9 (서머타임 없음)

/**
 * 일시정지한 시간을 뺀 공부 시간을 서울 날짜별 초로 나눈다.
 * 자정을 넘긴 세션은 각 날짜에 걸친 만큼씩 따로 센다. 아직 끝나지 않은 정지는 endedAt까지로 본다
 */
export function secondsBySeoulDay(startedAt: Date, endedAt: Date, pauses: PauseSpan[]): Map<string, number> {
    const endMs = endedAt.getTime();
    const ms = new Map<string, number>();
    const add = (from: number, to: number) => {
        let at = from;
        while (at < to) {
            const dayStart = Math.floor((at + SEOUL_OFFSET_MS) / DAY_MS) * DAY_MS - SEOUL_OFFSET_MS;
            const until = Math.min(to, dayStart + DAY_MS);
            const day = seoulDate(new Date(at));
            ms.set(day, (ms.get(day) ?? 0) + until - at);
            at = until;
        }
    };

    let cursor = startedAt.getTime();
    const sorted = [...pauses].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
    for (const pause of sorted) {
        add(cursor, Math.min(pause.startedAt.getTime(), endMs));
        cursor = Math.max(cursor, Math.min((pause.endedAt ?? endedAt).getTime(), endMs));
    }
    add(cursor, endMs);
    return new Map([...ms].map(([day, value]) => [day, Math.floor(value / 1000)]));
}
