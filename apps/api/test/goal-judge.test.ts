import { describe, expect, it } from 'vitest';

import { judgeDay, weeklyStreak, type DayStudy, type GoalRule } from '../src/modules/progress/goal-judge.js';
import { seoulDate } from '../src/modules/session/study-time.js';
import { weekStartOf } from '../src/modules/progress/week.js';

// 2026-11-09는 월요일이다. 목표 요일은 월(1) · 수(3), 하루 30분
const goal = (over: Partial<GoalRule> = {}): GoalRule => ({
    isActive: true,
    days: [1, 3],
    targetSec: 1800,
    subjectId: null,
    createdDate: '2026-10-01',
    pausedUntil: null,
    ...over,
});
/** 날짜마다 총 공부 초를 가진 기록 */
const study = (entries: Record<string, number | { total: number; subject: Record<string, number> }>) =>
    new Map<string, DayStudy>(
        Object.entries(entries).map(([day, v]) =>
            typeof v === 'number'
                ? [day, { totalSec: v, bySubject: new Map() }]
                : [day, { totalSec: v.total, bySubject: new Map(Object.entries(v.subject)) }],
        ),
    );
const DONE = 1800;
const none = new Set<string>();

// 월 · 수 날짜: 10-19 10-21 | 10-26 10-28 | 11-02 11-04 | 11-09 11-11 | 11-16 11-18
const PAST_THREE_WEEKS = ['2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28', '2026-11-02', '2026-11-04'];
const all = (days: string[], sec = DONE) => Object.fromEntries(days.map((d) => [d, sec]));

describe('judgeDay (하루 판정)', () => {
    it('목표 요일이 아니거나 만든 날 이전이면 none', () => {
        expect(judgeDay(goal(), '2026-11-10', '2026-11-14', study({}), none)).toBe('none'); // 화요일
        expect(judgeDay(goal({ createdDate: '2026-11-03' }), '2026-11-02', '2026-11-14', study({}), none)).toBe('none');
        expect(judgeDay(goal({ createdDate: '2026-11-02' }), '2026-11-02', '2026-11-14', study({}), none)).toBe('missed'); // 만든 날 당일은 대상
    });

    it('목표 시간 이상이면 achieved, 모자라면 missed, 오늘은 모자라도 pending, 앞으로 올 날도 pending', () => {
        expect(judgeDay(goal(), '2026-11-02', '2026-11-14', study({ '2026-11-02': 1800 }), none)).toBe('achieved');
        expect(judgeDay(goal(), '2026-11-02', '2026-11-14', study({ '2026-11-02': 1799 }), none)).toBe('missed');
        expect(judgeDay(goal(), '2026-11-02', '2026-11-14', study({}), none)).toBe('missed');
        expect(judgeDay(goal(), '2026-11-09', '2026-11-09', study({}), none)).toBe('pending'); // 오늘
        expect(judgeDay(goal(), '2026-11-09', '2026-11-09', study({ '2026-11-09': 1800 }), none)).toBe('achieved'); // 오늘 이미 채움
        expect(judgeDay(goal(), '2026-11-11', '2026-11-09', study({}), none)).toBe('pending'); // 앞으로 올 날
    });

    it('공휴일 · 제외일(skipDates)과 pausedUntil 이전(그날 포함)은 skipped', () => {
        expect(judgeDay(goal(), '2026-11-02', '2026-11-14', study({}), new Set(['2026-11-02']))).toBe('skipped');
        expect(judgeDay(goal({ pausedUntil: '2026-11-02' }), '2026-11-02', '2026-11-14', study({}), none)).toBe('skipped');
        expect(judgeDay(goal({ pausedUntil: '2026-11-02' }), '2026-11-04', '2026-11-14', study({}), none)).toBe('missed');
    });

    it('과목을 지정하면 그 과목 시간만 센다 (총 시간이 많아도 다른 과목이면 미달)', () => {
        const s = study({ '2026-11-02': { total: 7200, subject: { math: 600, eng: 1800 } } });
        expect(judgeDay(goal({ subjectId: 'math' }), '2026-11-02', '2026-11-14', s, none)).toBe('missed');
        expect(judgeDay(goal({ subjectId: 'eng' }), '2026-11-02', '2026-11-14', s, none)).toBe('achieved');
        expect(judgeDay(goal({ subjectId: 'bio' }), '2026-11-02', '2026-11-14', s, none)).toBe('missed');
        expect(judgeDay(goal(), '2026-11-02', '2026-11-14', s, none)).toBe('achieved'); // 과목 없음 → 그날 전체
    });
});

describe('weeklyStreak (연속 달성 주 수)', () => {
    it('지난 주부터 거꾸로 연속 달성한 주 수를 센다 (이번 주가 진행 중이면 세지 않는다)', () => {
        const s = study({ ...all(PAST_THREE_WEEKS), '2026-11-09': DONE }); // 이번 주(11-09 주)는 월요일만 채움, 수요일이 남음
        expect(weeklyStreak(goal(), '2026-11-10', s, none)).toBe(3);
    });

    it('이번 주 대상 날을 모두 달성했으면 이번 주도 센다', () => {
        const s = study({ ...all(PAST_THREE_WEEKS), '2026-11-09': DONE, '2026-11-11': DONE });
        expect(weeklyStreak(goal(), '2026-11-14', s, none)).toBe(4);
    });

    it('한 주라도 못 하면 거기서 끊긴다 (그 뒤 달성한 주만 센다)', () => {
        // 11-02 주에 월요일만 하고 수요일을 못 함
        const s = study({ '2026-10-19': DONE, '2026-10-21': DONE, '2026-10-26': DONE, '2026-10-28': DONE, '2026-11-02': DONE, '2026-11-09': DONE, '2026-11-11': DONE });
        expect(weeklyStreak(goal(), '2026-11-16', s, none)).toBe(1); // 11-09 주만 (오늘 월요일은 보류)
    });

    it('이번 주에 이미 못 한 날(오늘 전)이 있으면 0이다', () => {
        const s = study({ ...all(PAST_THREE_WEEKS), '2026-11-11': DONE }); // 월요일(11-09)을 못 함
        expect(weeklyStreak(goal(), '2026-11-12', s, none)).toBe(0);
    });

    it('오늘 아직 못 채웠어도 끊지 않는다 (보류)', () => {
        const s = study(all(PAST_THREE_WEEKS));
        expect(weeklyStreak(goal(), '2026-11-09', s, none)).toBe(3); // 월요일 오늘, 기록 없음
        expect(weeklyStreak(goal(), '2026-11-11', study({ ...all(PAST_THREE_WEEKS), '2026-11-09': DONE }), none)).toBe(3); // 수요일 오늘 미달
    });

    it('공휴일 · 제외일은 세지도 끊지도 않는다 (그 날을 못 채워도 주가 달성이다)', () => {
        const s = study({ ...all(PAST_THREE_WEEKS.filter((d) => d !== '2026-11-04')) }); // 11-04는 기록 없음
        expect(weeklyStreak(goal(), '2026-11-09', s, none)).toBe(0); // 11-04를 못 해서 11-02 주에서 끊김
        expect(weeklyStreak(goal(), '2026-11-09', s, new Set(['2026-11-04']))).toBe(3); // 공휴일 · 제외일이면 3주
    });

    it('pausedUntil 이전 날(그날 포함)도 건너뛴다', () => {
        // 월요일 11-02는 쉬는 날(못 해도 됨), 수요일 11-04부터는 하는 날
        const s = study({ '2026-11-04': DONE, '2026-11-09': DONE, '2026-11-11': DONE });
        expect(weeklyStreak(goal({ pausedUntil: '2026-11-02' }), '2026-11-14', s, none)).toBe(2); // 11-02 주는 수요일만 대상이고 달성
        expect(weeklyStreak(goal(), '2026-11-14', s, none)).toBe(1); // 쉬지 않았다면 11-02 주(월요일 미달)에서 끊김
        expect(weeklyStreak(goal({ pausedUntil: '2026-11-01' }), '2026-11-14', s, none)).toBe(1); // 하루 일찍 끝나면 월요일은 대상
    });

    it('대상 날이 전부 건너뛴 주는 세지도 끊지도 않는다', () => {
        const s = study({ ...all(['2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28']), '2026-11-09': DONE, '2026-11-11': DONE });
        const skip = new Set(['2026-11-02', '2026-11-04']); // 11-02 주는 통째로 공휴일
        expect(weeklyStreak(goal(), '2026-11-16', s, skip)).toBe(3); // 11-09, 10-26, 10-19 주
    });

    it('만든 날 이전은 판정하지 않는다 (그 전에 기록이 없어도 끊기지 않는다)', () => {
        const g = goal({ createdDate: '2026-11-04' }); // 11-02(월)는 만들기 전
        const s = study({ '2026-11-04': DONE, '2026-11-09': DONE });
        expect(weeklyStreak(g, '2026-11-10', s, none)).toBe(1); // 11-02 주는 수요일만 대상이고 달성
        expect(judgeDay(g, '2026-11-02', '2026-11-10', s, none)).toBe('none');
    });

    it('목표 시간을 채운 날이 없는 새 목표는 0이다', () => {
        expect(weeklyStreak(goal({ createdDate: '2026-11-09' }), '2026-11-09', study({}), none)).toBe(0);
    });

    it('과목을 지정하면 그 과목 시간으로만 주를 판정한다', () => {
        const days = PAST_THREE_WEEKS;
        const make = (subjectSec: number) =>
            study(Object.fromEntries(days.map((d) => [d, { total: 7200, subject: { math: subjectSec } }])));
        expect(weeklyStreak(goal({ subjectId: 'math' }), '2026-11-09', make(1800), none)).toBe(3);
        expect(weeklyStreak(goal({ subjectId: 'math' }), '2026-11-09', make(600), none)).toBe(0);
        expect(weeklyStreak(goal({ subjectId: null }), '2026-11-09', make(600), none)).toBe(3); // 과목 없음은 총 시간
    });

    it('isActive가 false면 0이다', () => {
        expect(weeklyStreak(goal({ isActive: false }), '2026-11-10', study(all(PAST_THREE_WEEKS)), none)).toBe(0);
    });

    it('since보다 앞의 주는 기록이 없는 것이지 못 한 것이 아니라서 판정하지 않는다', () => {
        const s = study(all(['2026-11-02', '2026-11-04']));
        // 기록은 11-03부터 읽었다: 11-02 주는 잘린 주라서 건너뛰고, 그 앞도 보지 않는다
        expect(weeklyStreak(goal(), '2026-11-10', s, none, '2026-11-03')).toBe(0);
        expect(weeklyStreak(goal(), '2026-11-16', study({ '2026-11-09': DONE, '2026-11-11': DONE }), none, '2026-11-03')).toBe(1);
    });
});

describe('서울 주 경계 (일요일 23:59 · 월요일 0시)', () => {
    // 목표 요일은 일요일(0). 11-01 · 11-08은 달성, 11-15(일)는 아직 안 함
    const sunday = goal({ days: [0] });
    const s = study({ '2026-10-25': DONE, '2026-11-01': DONE, '2026-11-08': DONE });
    const today = (iso: string) => seoulDate(new Date(iso));

    it('주는 월요일에 시작하고 일요일에 끝난다', () => {
        expect(weekStartOf('2026-11-15')).toBe('2026-11-09'); // 일요일은 그 주 마지막 날
        expect(weekStartOf('2026-11-16')).toBe('2026-11-16'); // 월요일은 새 주의 첫 날
    });

    it('일요일 23:59(서울)는 아직 그 일요일이라 못 채워도 보류, 월요일 0시(서울)가 되면 못 한 것이 된다', () => {
        const beforeMidnight = today('2026-11-15T14:59:59Z'); // 서울 일요일 23:59:59
        const afterMidnight = today('2026-11-15T15:00:00Z'); // 서울 월요일 00:00:00
        expect(beforeMidnight).toBe('2026-11-15');
        expect(afterMidnight).toBe('2026-11-16');
        expect(weeklyStreak(sunday, beforeMidnight, s, none)).toBe(3); // 11-15 주는 진행 중, 앞의 3주(10-19 주 포함)
        expect(weeklyStreak(sunday, afterMidnight, s, none)).toBe(0); // 11-15를 못 한 채 지난 주가 되어 끊김
    });

    it('UTC 날짜로는 아직 일요일이어도 서울은 월요일이면 서울 기준으로 판정한다', () => {
        // UTC 11-15 20:00 = 서울 11-16 05:00
        expect(today('2026-11-15T20:00:00Z')).toBe('2026-11-16');
    });
});
