import { describe, expect, it } from 'vitest';

import { isStreakDay, levelOf, longestStreak, peakHour, seoulHour } from '../src/modules/progress/stats.js';

describe('levelOf (공부 시간 → 색 진하기)', () => {
    it.each([
        [0, 0],
        [-5, 0],
        [1, 1], // 1초
        [30 * 60 - 1, 1],
        [30 * 60, 2], // 30분
        [60 * 60 - 1, 2],
        [60 * 60, 3], // 1시간
        [2 * 3600 - 1, 3],
        [2 * 3600, 4], // 2시간
        [16 * 3600, 4],
    ])('%i초 → level %i', (sec, level) => {
        expect(levelOf(sec)).toBe(level);
    });
});

describe('isStreakDay', () => {
    it('10분(600초) 이상이면 공부한 날이다', () => {
        expect(isStreakDay(599)).toBe(false);
        expect(isStreakDay(600)).toBe(true);
    });
});

describe('longestStreak', () => {
    it('가장 길게 이어진 날수를 센다 (하루 건너뛰면 끊긴다)', () => {
        const days = new Set(['2026-11-01', '2026-11-02', '2026-11-04', '2026-11-05', '2026-11-06']);
        expect(longestStreak(days)).toBe(3);
    });

    it('월 · 연을 넘어도 이어진다', () => {
        expect(longestStreak(new Set(['2026-12-30', '2026-12-31', '2027-01-01']))).toBe(3);
    });

    it('기록이 없으면 0', () => {
        expect(longestStreak(new Set())).toBe(0);
    });
});

describe('seoulHour / peakHour', () => {
    it('UTC 15:00은 서울 다음 날 0시, UTC 14:59는 서울 23시다', () => {
        expect(seoulHour(new Date('2026-11-15T15:00:00Z'))).toBe(0);
        expect(seoulHour(new Date('2026-11-15T14:59:59Z'))).toBe(23);
    });

    it('기록이 없으면 -1', () => {
        expect(peakHour([])).toBe(-1);
        expect(peakHour([{ startedAt: new Date('2026-11-10T01:00:00Z'), durationSec: 0 }])).toBe(-1);
    });

    it('공부 시간이 가장 많은 시작 시각(서울)을 돌려준다', () => {
        const sessions = [
            { startedAt: new Date('2026-11-10T00:30:00Z'), durationSec: 600 }, // 서울 9시
            { startedAt: new Date('2026-11-11T00:10:00Z'), durationSec: 600 }, // 서울 9시 → 합 1200
            { startedAt: new Date('2026-11-10T13:00:00Z'), durationSec: 1000 }, // 서울 22시
        ];
        expect(peakHour(sessions)).toBe(9);
    });

    it('같으면 이른 시각을 고른다', () => {
        const sessions = [
            { startedAt: new Date('2026-11-10T13:00:00Z'), durationSec: 500 }, // 서울 22시
            { startedAt: new Date('2026-11-10T01:00:00Z'), durationSec: 500 }, // 서울 10시
        ];
        expect(peakHour(sessions)).toBe(10);
    });
});
