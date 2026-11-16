import { describe, expect, it } from 'vitest';

import { addDays, daysBetween, sumRange, weekStartOf } from '../src/modules/progress/week.js';
import { seoulDate } from '../src/modules/session/study-time.js';

describe('주 계산 (서울 기준 월~일)', () => {
    it('월요일은 자기 자신, 일요일은 그 주 월요일을 돌려준다', () => {
        expect(weekStartOf('2026-11-09')).toBe('2026-11-09'); // 월
        expect(weekStartOf('2026-11-15')).toBe('2026-11-09'); // 일
        expect(weekStartOf('2026-11-16')).toBe('2026-11-16'); // 다음 월
    });

    it('서울 월요일 0시 직전은 지난주, 직후는 새 주다', () => {
        // 서울 일요일 23:59:59 = UTC 14:59:59 (같은 날)
        expect(weekStartOf(seoulDate(new Date('2026-11-15T14:59:59Z')))).toBe('2026-11-09');
        // 서울 월요일 00:00:00 = UTC 일요일 15:00:00 — UTC 날짜로는 아직 일요일이지만 서울은 새 주
        expect(weekStartOf(seoulDate(new Date('2026-11-15T15:00:00Z')))).toBe('2026-11-16');
    });

    it('월말 · 연말을 넘겨도 날짜 더하기가 맞다', () => {
        expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
        expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
        expect(weekStartOf('2027-01-01')).toBe('2026-12-28');
    });

    it('daysBetween · sumRange', () => {
        expect(daysBetween('2026-11-09', '2026-11-12')).toBe(3);
        const totals = new Map([
            ['2026-11-09', 60],
            ['2026-11-10', 30],
            ['2026-11-20', 999],
        ]);
        expect(sumRange(totals, '2026-11-09', 7)).toBe(90);
        expect(sumRange(totals, '2026-11-09', 1)).toBe(60);
    });
});
