// 진짜 MongoDB에서 반복 목표 리마인드 푸시(FR-11-07 · 08)를 확인하는 테스트.
// 확인하는 것: 서버 둘이 같은 순간 runOnce 해도 푸시 1번, 발송이 모두 실패하면 다음 확인에서 다시 보내고 하루 3회에서 멈춤,
// 만료 토큰 삭제, 기기 없음 · 이미 채움이면 표시만 남김, 하루 한 번(이미 보낸 날은 다시 안 보냄),
// 설정을 지난 시각으로 바꾸면 오늘 건너뜀(update), 이름만 고치면 막지 않음, 인덱스.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다. ExpoPushService는 가짜다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/goal-reminders-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { GoalRemindersService } from '../src/modules/progress/goal-reminders.service.js';
import { RecurringGoalsService } from '../src/modules/progress/recurring-goals.service.js';
import {
  DailyRecord,
  DailyRecordSchema,
} from '../src/modules/progress/schemas/daily-record.schema.js';
import {
  RecurringGoal,
  RecurringGoalSchema,
} from '../src/modules/progress/schemas/recurring-goal.schema.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';
import { Device, DeviceSchema } from '../src/modules/users/schemas/device.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_remind_${process.pid}_${Date.now()}`;

const TODAY = '2026-11-16'; // 월요일
const MON = 1;
const seoul = (hhmm: string, day = TODAY) => new Date(`${day}T${hhmm}:00+09:00`);
const token = (n: string) => `ExponentPushToken[${n}]`;

type SendResult = {
  invalidTokens: string[];
  failedTickets: { message: { to: string }; error: string }[];
};

describe.skipIf(!isLocal)('진짜 DB 반복 목표 리마인드 푸시', () => {
  let conn: Connection;
  let goals: Model<RecurringGoal>;
  let daily: Model<DailyRecord>;
  let devices: Model<Device>;
  let sent: { to: string; title: string; data: Record<string, unknown> }[];
  let sendImpl: (messages: { to: string }[]) => Promise<SendResult>;
  const user = new Types.ObjectId();
  const ok: SendResult = { invalidTokens: [], failedTickets: [] };

  const makeService = () =>
    new GoalRemindersService(
      goals as never,
      daily as never,
      devices as never,
      { skipDates: () => Promise.resolve([]) } as never,
      {
        send: (messages: { to: string; title: string; data: Record<string, unknown> }[]) => {
          sent.push(...messages);
          return sendImpl(messages);
        },
      } as never,
    );

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    goals = conn.model(RecurringGoal.name, RecurringGoalSchema) as unknown as Model<RecurringGoal>;
    daily = conn.model(DailyRecord.name, DailyRecordSchema) as unknown as Model<DailyRecord>;
    devices = conn.model(Device.name, DeviceSchema) as unknown as Model<Device>;
    await Promise.all([goals.syncIndexes(), devices.syncIndexes()]);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    sent = [];
    sendImpl = () => Promise.resolve(ok);
    await Promise.all([goals.deleteMany({}), daily.deleteMany({}), devices.deleteMany({})]);
  });

  const goal = async (over: Record<string, unknown> = {}) =>
    (
      await goals.create({
        userId: user,
        name: '영어 단어',
        days: [MON],
        targetMin: 30,
        remindEnabled: true,
        remindTime: '21:00',
        isActive: true,
        createdAt: seoul('09:00', '2026-11-01'),
        ...over,
      } as never)
    )._id;
  const device = (n: string, userId = user) =>
    devices.create({
      userId,
      platform: 'android',
      pushToken: token(n),
      locale: 'ko-KR',
      lastSeenAt: new Date(),
    });
  const studied = (min: number) =>
    daily.create({ userId: user, studyDate: TODAY, totalSec: min * 60, items: [] });
  const row = (id: Types.ObjectId) => goals.findById(id).lean();

  it('서버 둘이 같은 순간 runOnce 해도 푸시는 1번이고 표시가 남는다', async () => {
    const id = await goal();
    await device('a');
    const a = makeService();
    const b = makeService();
    await Promise.all([a.runOnce(seoul('21:05')), b.runOnce(seoul('21:05'))]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      to: token('a'),
      title: '오늘 목표까지 30분 남았어요',
      data: { type: 'goal-remind', goalId: id.toHexString() },
    });
    expect((await row(id))!.lastRemindedOn).toBe(TODAY);
    // 이어서 다시 확인해도 오늘은 더 보내지 않는다(하루 한 번)
    await a.runOnce(seoul('21:30'));
    await b.runOnce(seoul('21:31'));
    expect(sent).toHaveLength(1);
  });

  it('여러 기기가 있으면 모두에게 한 번씩 보낸다', async () => {
    await goal();
    await device('a');
    await device('b');
    await makeService().runOnce(seoul('21:05'));
    expect(sent.map((m) => m.to).sort()).toEqual([token('a'), token('b')]);
  });

  it('발송이 모두 실패하면 표시를 풀어 다음 확인(2분 뒤)에서 다시 보내고, 하루 3회에서 멈춘다', async () => {
    const id = await goal();
    await device('a');
    sendImpl = (messages) =>
      Promise.resolve({
        invalidTokens: [],
        failedTickets: messages.map((message) => ({
          message,
          error: 'Expo Push Service 연결 실패',
        })),
      });
    const service = makeService();
    await service.runOnce(seoul('21:05'));
    expect(sent).toHaveLength(1);
    let doc = (await row(id))!;
    expect(doc.lastRemindedOn).toBeNull(); // 표시를 풀었다
    expect(doc.remindAttempts).toBe(1);
    expect(doc.remindRetryAt!.getTime()).toBe(seoul('21:07').getTime());

    await service.runOnce(seoul('21:06')); // 아직 2분이 안 지났다
    expect(sent).toHaveLength(1);

    await service.runOnce(seoul('21:07')); // 2번째 시도도 실패 → 10분 뒤
    expect(sent).toHaveLength(2);
    doc = (await row(id))!;
    expect(doc.remindAttempts).toBe(2);
    expect(doc.remindRetryAt!.getTime()).toBe(seoul('21:17').getTime());

    await service.runOnce(seoul('21:16'));
    expect(sent).toHaveLength(2);
    await service.runOnce(seoul('21:17')); // 3번째도 실패 → 그날은 포기, 표시 유지
    expect(sent).toHaveLength(3);
    doc = (await row(id))!;
    expect(doc.lastRemindedOn).toBe(TODAY);
    await service.runOnce(seoul('21:40'));
    await service.runOnce(seoul('22:00'));
    expect(sent).toHaveLength(3);
  });

  it('실패한 뒤 다음 확인에서 성공하면 거기서 끝난다', async () => {
    const id = await goal();
    await device('a');
    let calls = 0;
    sendImpl = (messages) =>
      Promise.resolve(
        ++calls === 1
          ? {
              invalidTokens: [],
              failedTickets: messages.map((message) => ({ message, error: 'x' })),
            }
          : ok,
      );
    const service = makeService();
    await service.runOnce(seoul('21:05'));
    await service.runOnce(seoul('21:07'));
    await service.runOnce(seoul('21:30'));
    expect(sent).toHaveLength(2);
    expect((await row(id))!.lastRemindedOn).toBe(TODAY);
  });

  it('한 기기라도 보냈으면 완료로 본다(다시 보내지 않는다)', async () => {
    const id = await goal();
    await device('a');
    await device('b');
    sendImpl = (messages) =>
      Promise.resolve({
        invalidTokens: [],
        failedTickets: messages
          .filter((m) => m.to === token('b'))
          .map((message) => ({ message, error: 'x' })),
      });
    const service = makeService();
    await service.runOnce(seoul('21:05'));
    await service.runOnce(seoul('21:10'));
    expect(sent).toHaveLength(2);
    expect((await row(id))!.lastRemindedOn).toBe(TODAY);
  });

  it('만료된 토큰은 devices 에서 지우고 다시 보내지 않는다', async () => {
    const id = await goal();
    await device('dead');
    await device('live');
    sendImpl = () => Promise.resolve({ invalidTokens: [token('dead')], failedTickets: [] });
    const service = makeService();
    await service.runOnce(seoul('21:05'));
    expect((await devices.find({}).lean()).map((d) => d.pushToken)).toEqual([token('live')]);
    await service.runOnce(seoul('21:10'));
    expect(sent).toHaveLength(2); // 두 기기에 한 번씩, 이후는 없음
    expect((await row(id))!.lastRemindedOn).toBe(TODAY);
  });

  it('기기가 없으면 표시만 남기고 끝난다', async () => {
    const id = await goal();
    await makeService().runOnce(seoul('21:05'));
    expect(sent).toHaveLength(0);
    expect((await row(id))!.lastRemindedOn).toBe(TODAY);
  });

  it('이미 목표를 채웠으면 보내지 않고 표시만 남긴다', async () => {
    const id = await goal();
    await device('a');
    await studied(30);
    await makeService().runOnce(seoul('21:05'));
    expect(sent).toHaveLength(0);
    expect((await row(id))!.lastRemindedOn).toBe(TODAY);
  });

  it('공부한 만큼 뺀 남은 분을 보낸다', async () => {
    await goal();
    await device('a');
    await studied(12);
    await makeService().runOnce(seoul('21:05'));
    expect(sent[0]!.title).toBe('오늘 목표까지 18분 남았어요');
  });

  it('끈 목표 · 쉬는 목표 · 지운 목표 · 다른 요일 · 시각 전 · 창이 지난 뒤는 건드리지 않는다', async () => {
    await device('a');
    const off = await goal({ remindEnabled: false });
    const rest = await goal({ isActive: false });
    const gone = await goal({ deletedAt: new Date() });
    const tue = await goal({ days: [2] });
    const late = await goal({ remindTime: '22:30' });
    const service = makeService();
    await service.runOnce(seoul('21:05'));
    expect(sent).toHaveLength(0);
    for (const id of [off, rest, gone, tue, late])
      expect((await row(id))!.lastRemindedOn).toBeNull();
    await service.runOnce(seoul('23:30')); // 21:00 목표의 창(23:00)은 지났고, 22:30 목표의 창(00:30)은 자정에서 끝나므로 아직 열려 있다
    expect(sent).toHaveLength(1);
    expect((await row(late))!.lastRemindedOn).toBe(TODAY);
  });

  it('리마인드 시각 이후에 만든 목표는 그날 건너뛰고 다음 요일에는 보낸다', async () => {
    const id = await goal({ createdAt: seoul('21:30') });
    await device('a');
    const service = makeService();
    await service.runOnce(seoul('21:40'));
    expect(sent).toHaveLength(0);
    expect((await row(id))!.lastRemindedOn).toBeNull();
    await service.runOnce(seoul('21:05', '2026-11-23')); // 다음 주 월요일
    expect(sent).toHaveLength(1);
  });

  it('다음 날이 되면 어제 표시와 상관없이 다시 보낸다', async () => {
    const id = await goal({ lastRemindedOn: '2026-11-09' });
    await device('a');
    await makeService().runOnce(seoul('21:05'));
    expect(sent).toHaveLength(1);
    expect((await row(id))!.lastRemindedOn).toBe(TODAY);
  });

  it('후보를 찾는 부분 인덱스가 있다', async () => {
    const indexes = await goals.collection.indexes();
    expect(indexes).toContainEqual(
      expect.objectContaining({
        key: { days: 1, lastRemindedOn: 1 },
        partialFilterExpression: { remindEnabled: true, isActive: true },
      }),
    );
  });

  describe('설정을 바꿀 때 (FR-11-08)', () => {
    let service: RecurringGoalsService;
    beforeAll(() => {
      const subjects = conn.model(Subject.name, SubjectSchema) as unknown as Model<Subject>;
      service = new RecurringGoalsService(
        goals as never,
        subjects as never,
        daily as never,
        { skipDates: () => Promise.resolve([]) } as never,
      );
    });
    const owner = () => user.toHexString();

    it('지난 시각으로 알림을 켜면 오늘은 건너뛰고 푸시가 가지 않는다', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: seoul('21:40') });
      try {
        const id = await goal({ remindEnabled: false });
        await device('a');
        await service.update(owner(), id.toHexString(), { remindEnabled: true });
        expect((await row(id))!.lastRemindedOn).toBe(TODAY);
        await makeService().runOnce(seoul('21:41'));
        expect(sent).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('아직 안 지난 시각으로 바꾸면 표시하지 않고 새 시각에 보낸다', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: seoul('20:00') });
      try {
        const id = await goal({ remindTime: '19:00', lastRemindedOn: null });
        await device('a');
        await service.update(owner(), id.toHexString(), { remindTime: '22:00' });
        expect((await row(id))!.lastRemindedOn).toBeNull();
      } finally {
        vi.useRealTimers();
      }
      const service2 = makeService();
      await service2.runOnce(seoul('21:30'));
      expect(sent).toHaveLength(0);
      await service2.runOnce(seoul('22:00'));
      expect(sent).toHaveLength(1);
    });

    it('이미 보낸 날은 시각을 바꾸거나 껐다 켜도 다시 보내지 않는다', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: seoul('21:30') });
      try {
        const id = await goal();
        await device('a');
        await makeService().runOnce(seoul('21:05'));
        expect(sent).toHaveLength(1);
        await service.update(owner(), id.toHexString(), { remindTime: '21:10' });
        await service.update(owner(), id.toHexString(), { remindEnabled: false });
        await service.update(owner(), id.toHexString(), { remindEnabled: true });
        await makeService().runOnce(seoul('21:31'));
        expect(sent).toHaveLength(1);
        expect((await row(id))!.lastRemindedOn).toBe(TODAY);
      } finally {
        vi.useRealTimers();
      }
    });

    it('이름만 고치는 편집은 오늘 리마인드를 막지 않는다', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: seoul('21:30') });
      try {
        const id = await goal();
        await device('a');
        await service.update(owner(), id.toHexString(), {
          name: '새 이름',
          remindEnabled: true,
          remindTime: '21:00',
          days: [MON],
        });
        expect((await row(id))!.lastRemindedOn).toBeNull();
        await makeService().runOnce(seoul('21:31'));
        expect(sent).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
