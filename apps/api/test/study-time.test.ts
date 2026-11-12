import { describe, expect, it } from 'vitest';

import { ABUSE_SEC, netDurationSec, secondsBySeoulDay } from '../src/modules/session/study-time.js';

// 서울 시각을 UTC Date로 (서울은 UTC+9)
const seoul = (text: string) => new Date(`${text}+09:00`);

describe('netDurationSec (전체 순공 시간)', () => {
    it('밀리초 경계: 12:00:00.500부터 정확히 24시간이면 86400초, 1밀리초 모자라면 86399초', () => {
        const start = seoul('2026-11-04T12:00:00.500');
        expect(netDurationSec(start, [], seoul('2026-11-05T12:00:00.500'))).toBe(ABUSE_SEC);
        expect(netDurationSec(start, [], new Date(seoul('2026-11-05T12:00:00.500').getTime() - 1))).toBe(ABUSE_SEC - 1);
    });

    it('자정을 넘겨도 날짜별로 따로 버리지 않고 전체에서 한 번만 버린다', () => {
        // 1초 중 0.5초씩 걸친 경우: 전체는 1초, 날짜별로 나누면 둘 다 0초
        const start = seoul('2026-11-04T23:59:59.500');
        const end = seoul('2026-11-05T00:00:00.500');
        expect(netDurationSec(start, [], end)).toBe(1);
        expect([...secondsBySeoulDay(start, end, []).values()]).toEqual([0, 0]);
    });
});

describe('secondsBySeoulDay (공부 시간을 서울 날짜별로 나누기)', () => {
    it('하루 안이면 그 날짜 한 칸', () => {
        const days = secondsBySeoulDay(seoul('2026-11-04T10:00:00'), seoul('2026-11-04T10:30:00'), []);
        expect([...days]).toEqual([['2026-11-04', 1800]]);
    });

    it('자정을 넘기면 날짜마다 걸친 만큼 나눈다', () => {
        const days = secondsBySeoulDay(seoul('2026-11-04T23:30:00'), seoul('2026-11-05T00:10:00'), []);
        expect(Object.fromEntries(days)).toEqual({ '2026-11-04': 1800, '2026-11-05': 600 });
    });

    it('UTC로는 같은 날이어도 서울 자정을 기준으로 나눈다', () => {
        // UTC 14:50 ~ 15:10 = 서울 23:50 ~ 00:10
        const days = secondsBySeoulDay(new Date('2026-11-04T14:50:00Z'), new Date('2026-11-04T15:10:00Z'), []);
        expect(Object.fromEntries(days)).toEqual({ '2026-11-04': 600, '2026-11-05': 600 });
    });

    it('일시정지한 시간은 뺀다 (끝난 정지 + 아직 열려 있는 정지)', () => {
        const days = secondsBySeoulDay(seoul('2026-11-04T10:00:00'), seoul('2026-11-04T11:00:00'), [
            { startedAt: seoul('2026-11-04T10:10:00'), endedAt: seoul('2026-11-04T10:20:00') }, // 10분
            { startedAt: seoul('2026-11-04T10:50:00'), endedAt: null }, // 끝까지 10분
        ]);
        expect([...days]).toEqual([['2026-11-04', 2400]]);
    });

    it('자정에 걸친 정지는 양쪽 날짜에서 모두 뺀다', () => {
        const days = secondsBySeoulDay(seoul('2026-11-04T23:00:00'), seoul('2026-11-05T01:00:00'), [
            { startedAt: seoul('2026-11-04T23:50:00'), endedAt: seoul('2026-11-05T00:10:00') },
        ]);
        expect(Object.fromEntries(days)).toEqual({ '2026-11-04': 3000, '2026-11-05': 3000 });
    });
});
