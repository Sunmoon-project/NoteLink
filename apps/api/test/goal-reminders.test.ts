// 반복 목표 리마인드 푸시(FR-11-07 · 08) 단위 테스트: 시각 · 창 · 문구 · 설정 변경 규칙(순수 함수)과,
// 가짜 모델로 대상 고르기(요일 · 끔 · 일시정지 · 공휴일 · 이미 채움 · 시각 · 늦게 만든 목표)와 발송 문구를 본다.
// 실제 DB에서 서버 둘이 겹칠 때 · 실패 재시도 · 만료 토큰 삭제는 goal-reminders-real-db.test.ts
import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { GoalRemindersService } from '../src/modules/progress/goal-reminders.service.js';
import {
  DEFAULT_REMIND_TIME,
  REMIND_MAX_ATTEMPTS,
  inRemindWindow,
  normalizeRemindTime,
  remindEnd,
  remindMessage,
  remindStart,
  weekdayOfDate,
} from '../src/modules/progress/goal-remind.js';

// 2026-11-16(월) 서울 기준 시각을 만든다
const seoul = (hhmm: string, day = '2026-11-16') => new Date(`${day}T${hhmm}:00+09:00`);
const TODAY = '2026-11-16';
const MON = 1;

describe('리마인드 시각 · 창', () => {
  it('시각이 없거나 형식이 틀리면 기본 21:00', () => {
    expect(DEFAULT_REMIND_TIME).toBe('21:00');
    expect(normalizeRemindTime(null)).toBe('21:00');
    expect(normalizeRemindTime(undefined)).toBe('21:00');
    expect(normalizeRemindTime('25:99')).toBe('21:00');
    expect(normalizeRemindTime('07:05')).toBe('07:05');
  });

  it('리마인드 시각부터 2시간 뒤까지가 창이다(시작 포함 · 끝 제외)', () => {
    expect(inRemindWindow(seoul('20:59'), TODAY, '21:00')).toBe(false);
    expect(inRemindWindow(seoul('21:00'), TODAY, '21:00')).toBe(true);
    expect(inRemindWindow(seoul('22:59'), TODAY, '21:00')).toBe(true);
    expect(inRemindWindow(seoul('23:00'), TODAY, '21:00')).toBe(false);
    expect(inRemindWindow(seoul('21:00'), TODAY, null)).toBe(true); // 기본 21:00
  });

  it('창은 서울 자정을 넘지 않는다', () => {
    expect(remindEnd(TODAY, '23:30').toISOString()).toBe(
      seoul('00:00', '2026-11-17').toISOString(),
    );
    expect(inRemindWindow(seoul('23:59'), TODAY, '23:30')).toBe(true);
    expect(inRemindWindow(seoul('00:00', '2026-11-17'), TODAY, '23:30')).toBe(false);
  });

  it('서울 날짜의 요일 번호 (0=일)', () => {
    expect(weekdayOfDate('2026-11-16')).toBe(MON);
    expect(weekdayOfDate('2026-11-15')).toBe(0);
  });
});

describe('푸시 문구', () => {
  it('제목에 남은 분, 본문에 목표 이름과 채운 분', () => {
    expect(remindMessage('영어 단어', 30, 12)).toEqual({
      title: '오늘 목표까지 18분 남았어요',
      body: '영어 단어 · 30분 중 12분을 채웠어요',
    });
    expect(remindMessage('수학', 60, 0).title).toBe('오늘 목표까지 60분 남았어요');
  });
});

describe('GoalRemindersService 대상 고르기', () => {
  const userId = new Types.ObjectId();
  const goal = (over: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    userId,
    name: '영어 단어',
    days: [MON],
    targetMin: 30,
    remindEnabled: true,
    remindTime: '21:00',
    isActive: true,
    deletedAt: null,
    pausedUntil: null,
    subjectId: null,
    lastRemindedOn: null,
    createdAt: seoul('09:00', '2026-11-01'),
    ...over,
  });

  function setup(opts: {
    goals: Record<string, unknown>[];
    totalSec?: number;
    skip?: string[];
    devices?: string[];
    send?: (messages: { to: string }[]) => unknown;
  }) {
    const filters: Record<string, unknown>[] = [];
    const claims: unknown[] = [];
    const goals = {
      find: (filter: Record<string, unknown>) => {
        filters.push(filter);
        const chain = {
          sort: () => chain,
          limit: () => chain,
          lean: () => Promise.resolve(opts.goals),
        };
        return chain;
      },
      updateOne: (filter: unknown, update: unknown) => {
        claims.push({ filter, update });
        return Promise.resolve({ matchedCount: 1 });
      },
    };
    const daily = {
      find: () => ({
        lean: () =>
          Promise.resolve(
            opts.totalSec === undefined ? [] : [{ studyDate: TODAY, totalSec: opts.totalSec }],
          ),
      }),
    };
    const devices = {
      find: () => ({
        lean: () =>
          Promise.resolve(
            (opts.devices ?? ['ExponentPushToken[aaa]']).map((pushToken) => ({ pushToken })),
          ),
      }),
      deleteMany: vi.fn(),
    };
    const holidays = { skipDates: () => Promise.resolve(opts.skip ?? []) };
    const push = {
      send: vi.fn(
        (messages: { to: string }[]) =>
          opts.send?.(messages) ?? Promise.resolve({ invalidTokens: [], failedTickets: [] }),
      ),
    };
    const service = new GoalRemindersService(
      goals as never,
      daily as never,
      devices as never,
      holidays as never,
      push as never,
    );
    return { service, push, filters, claims, devices };
  }

  it('요일 · 켬 · 쉬지 않음 · 안 지움 · 오늘 안 보냄을 조건으로 찾는다', async () => {
    const { service, filters } = setup({ goals: [] });
    await service.runOnce(seoul('21:05'));
    expect(filters[0]).toMatchObject({
      isActive: true,
      remindEnabled: true,
      deletedAt: null,
      days: MON,
      lastRemindedOn: { $ne: TODAY },
    });
    expect(REMIND_MAX_ATTEMPTS).toBe(3);
  });

  it('시각이 지났고 목표보다 적게 공부했으면 남은 분과 data 로 보낸다(채널은 비움)', async () => {
    const g = goal();
    const { service, push, claims } = setup({ goals: [g], totalSec: 12 * 60 + 59 });
    await service.runOnce(seoul('21:05'));
    expect(push.send).toHaveBeenCalledTimes(1);
    const [[messages]] = push.send.mock.calls as unknown as [[Record<string, unknown>[]]];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      to: 'ExponentPushToken[aaa]',
      title: '오늘 목표까지 18분 남았어요',
      body: '영어 단어 · 30분 중 12분을 채웠어요',
      data: { type: 'goal-remind', goalId: String(g._id) },
    });
    expect(messages[0]).not.toHaveProperty('channelId');
    expect(claims).toHaveLength(1); // 오늘 날짜로 표시를 잡았다
    expect(claims[0]).toMatchObject({ update: { $set: { lastRemindedOn: TODAY } } });
  });

  it('공부를 아직 안 했으면 목표 전체가 남은 분이다', async () => {
    const { service, push } = setup({ goals: [goal({ targetMin: 45 })] });
    await service.runOnce(seoul('21:00'));
    const [[messages]] = push.send.mock.calls as unknown as [[{ title: string }[]]];
    expect(messages[0]!.title).toBe('오늘 목표까지 45분 남았어요');
  });

  it('리마인드 시각 전이나 창이 지난 뒤에는 잡지도 보내지도 않는다', async () => {
    const { service, push, claims } = setup({ goals: [goal()] });
    await service.runOnce(seoul('20:59'));
    await service.runOnce(seoul('23:00'));
    expect(push.send).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
  });

  it('리마인드 시각이 목표마다 다르다(없으면 21:00)', async () => {
    const { service, push } = setup({ goals: [goal({ remindTime: '19:30' })] });
    await service.runOnce(seoul('19:29'));
    expect(push.send).not.toHaveBeenCalled();
    await service.runOnce(seoul('19:30'));
    expect(push.send).toHaveBeenCalledTimes(1);
    const none = setup({ goals: [goal({ remindTime: null })] });
    await none.service.runOnce(seoul('20:59'));
    expect(none.push.send).not.toHaveBeenCalled();
    await none.service.runOnce(seoul('21:00'));
    expect(none.push.send).toHaveBeenCalledTimes(1);
  });

  it('이미 목표를 채웠으면 보내지 않고 표시만 남긴다', async () => {
    const { service, push, claims } = setup({ goals: [goal()], totalSec: 30 * 60 });
    await service.runOnce(seoul('21:05'));
    expect(push.send).not.toHaveBeenCalled();
    expect(claims).toHaveLength(1);
  });

  it('일시정지 중이거나 공휴일 · 제외일이면 보내지 않는다', async () => {
    const paused = setup({ goals: [goal({ pausedUntil: seoul('00:00', '2026-11-17') })] });
    await paused.service.runOnce(seoul('21:05'));
    expect(paused.push.send).not.toHaveBeenCalled();
    const holiday = setup({ goals: [goal()], skip: [TODAY] });
    await holiday.service.runOnce(seoul('21:05'));
    expect(holiday.push.send).not.toHaveBeenCalled();
  });

  it('리마인드 시각 이후에 만든 목표는 그날 건너뛴다', async () => {
    const { service, push, claims } = setup({
      goals: [goal({ createdAt: seoul('21:30') })],
    });
    await service.runOnce(seoul('21:40'));
    expect(push.send).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
  });

  it('과목 목표는 그 과목에서 쌓은 시간만 센다(기록에 그 과목이 없으면 0분)', async () => {
    const { service, push } = setup({
      goals: [goal({ subjectId: new Types.ObjectId() })],
      totalSec: 3600, // 다른 과목으로 한 시간 공부했어도 이 목표에는 0분
    });
    await service.runOnce(seoul('21:05'));
    const [[messages]] = push.send.mock.calls as unknown as [[{ title: string }[]]];
    expect(messages[0]!.title).toBe('오늘 목표까지 30분 남았어요');
  });

  it('기기가 없거나 푸시 토큰 형식이 아니면 보내지 않고 표시만 남긴다', async () => {
    const none = setup({ goals: [goal()], devices: [] });
    await none.service.runOnce(seoul('21:05'));
    expect(none.push.send).not.toHaveBeenCalled();
    expect(none.claims).toHaveLength(1);
    const bad = setup({ goals: [goal()], devices: ['not-a-token'] });
    await bad.service.runOnce(seoul('21:05'));
    expect(bad.push.send).not.toHaveBeenCalled();
  });

  it('다시 시도 시각 전인 목표는 건너뛴다', async () => {
    const { service, push, claims } = setup({
      goals: [goal({ remindRetryAt: seoul('21:10'), remindAttempts: 1, remindAttemptsOn: TODAY })],
    });
    await service.runOnce(seoul('21:05'));
    expect(push.send).not.toHaveBeenCalled();
    expect(claims).toHaveLength(0);
  });
});
