// 진짜 MongoDB에서 복습 알림(FR-37-08)을 확인하는 테스트.
// 확인하는 것: 복습할 문제가 있는 사용자만 받음(지운 세트 · 다 익힌 문제 · 넘긴 문제 · 결함 표시 · 내일 이후 날짜 제외, 서울 0시 경계),
// 오늘의 복습을 만든 사용자 제외, 탈퇴 중 · 탈퇴한 사용자 제외, 하루 한 번, 서버 둘이 동시에 돌아도 1번, 보내는 시각 전 · 날짜가 바뀌면 안 보냄,
// 기록 실패 뒤 재발송 없음, 서버 재시작 뒤 다시 집계해도 이미 보낸 사용자는 걸러짐, 선점한 서버가 죽으면 이어받기, 실제 시도 횟수,
// 한도에 닿은 만료된 선점 정리, review_reminders 색인(유니크 · TTL), quiz_sets 에는 색인을 만들지 않음.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 이번 실행에서만 쓰는 전용 DB를 만들고 끝나면 지운다. ExpoPushService는 가짜다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/review-reminders-real-db.test.ts
import mongoose, { type Connection, type Model, Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { QuizSet, QuizSetSchema } from '../src/modules/quiz/schemas/quiz-set.schema.js';
import { Device, DeviceSchema } from '../src/modules/users/schemas/device.schema.js';
import {
  REVIEW_REMIND_LEASE_MS,
  REVIEW_REMIND_MAX_ATTEMPTS,
  REVIEW_REMIND_TTL_SECONDS,
  dayEnd,
} from '../src/review-reminders/review-remind.js';
import {
  ReviewReminder,
  ReviewReminderSchema,
} from '../src/review-reminders/review-reminder.schema.js';
import { ReviewRemindersService } from '../src/review-reminders/review-reminders.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_review_remind_${process.pid}_${Date.now()}`;

const DAY = '2026-11-17';
const NEXT_DAY = '2026-11-18';
const seoul = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00+09:00`);
const NOW = seoul('19:30');
const TOMORROW = dayEnd(DAY); // 서울 내일 0시(UTC 2026-11-17T15:00Z): 이 시각 전이 복습 날짜인 문제가 오늘의 복습 대상
const TODAY_MIDNIGHT = seoul('00:00'); // 오늘 서울 0시: 오늘 복습할 날짜
const token = (n: string) => `ExponentPushToken[${n}]`;

type SendResult = {
  invalidTokens: string[];
  failedTickets: { message: { to: string }; error: string }[];
};
type Sent = {
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  collapseId: string;
};

describe.skipIf(!isLocal)('진짜 DB 복습 알림', () => {
  let conn: Connection;
  let sets: Model<QuizSet>;
  let reminders: Model<ReviewReminder>;
  let devices: Model<Device>;
  let users: Model<User>;
  let sent: Sent[];
  let sendImpl: () => Promise<SendResult>;
  const ok: SendResult = { invalidTokens: [], failedTickets: [] };
  const fail: SendResult = {
    invalidTokens: [],
    failedTickets: [{ message: { to: token('a') }, error: 'x' }],
  };

  const makeService = () => {
    const service = new ReviewRemindersService(
      sets as never,
      reminders as never,
      devices as never,
      users as never,
      {
        send: (messages: Sent[]) => {
          sent.push(...messages);
          return sendImpl();
        },
      } as never,
    );
    service.recordWait = () => Promise.resolve(); // 기록 다시 쓰기 사이의 기다림은 실제로 기다리지 않는다
    return service;
  };

  beforeAll(async () => {
    if (!isLocal) throw new Error('MONGODB_VERIFY_URI는 localhost만 받습니다');
    conn = await mongoose.createConnection(uri!, { dbName }).asPromise();
    sets = conn.model(QuizSet.name, QuizSetSchema) as unknown as Model<QuizSet>;
    reminders = conn.model(
      ReviewReminder.name,
      ReviewReminderSchema,
    ) as unknown as Model<ReviewReminder>;
    devices = conn.model(Device.name, DeviceSchema) as unknown as Model<Device>;
    users = conn.model(User.name, UserSchema) as unknown as Model<User>;
    await Promise.all([reminders.syncIndexes(), devices.syncIndexes()]);
  });

  afterAll(async () => {
    await conn?.dropDatabase();
    await conn?.close();
  });

  beforeEach(async () => {
    sent = [];
    sendImpl = () => Promise.resolve(ok);
    await Promise.all([
      sets.deleteMany({}),
      reminders.deleteMany({}),
      devices.deleteMany({}),
      users.deleteMany({}),
    ]);
  });

  /** 사용자(기본: 정상 계정) + 기기 하나 */
  const user = async (over: Record<string, unknown> = {}, withDevice = true) => {
    const _id = new Types.ObjectId();
    // users 의 유니크 색인(nickname · 소셜 계정 등)에 걸리지 않게 사용자마다 다른 값을 넣는다
    await users.collection.insertOne({
      _id,
      nickname: `u${_id.toHexString()}`,
      deletedAt: null,
      withdrawingAt: null,
      ...over,
    });
    if (withDevice) {
      await devices.create({
        userId: _id,
        platform: 'android',
        pushToken: token(_id.toHexString()),
        locale: 'ko-KR',
        lastSeenAt: new Date(),
      });
    }
    return _id;
  };
  const question = (state: string, dueAt: Date | null, extra: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    order: 1,
    type: 'multiple_choice',
    prompt: '문제',
    answer: '가',
    conceptTags: [],
    srs: { state, dueAt, step: 0, streak: 0, reviews: 1, lastResult: 'wrong', ...extra },
  });
  const quizSet = async (
    owner: Types.ObjectId,
    questions: ReturnType<typeof question>[],
    over: Record<string, unknown> = {},
  ) => {
    const _id = new Types.ObjectId();
    await sets.collection.insertOne({
      _id,
      ownerId: owner,
      materialId: new Types.ObjectId(),
      folderId: new Types.ObjectId(),
      source: 'ai_generated',
      sourceSetId: null,
      reviewDay: null,
      title: '세트',
      status: 'ready',
      progress: 100,
      questionCount: questions.length,
      questions,
      deletedAt: null,
      createdAt: new Date('2026-11-01T00:00:00Z'),
      ...over,
    });
    return _id;
  };
  const dueQuestion = () => question('active', TODAY_MIDNIGHT);
  const row = (userId: Types.ObjectId, day = DAY) => reminders.findOne({ userId, day }).lean();
  const sentTo = (userId: Types.ObjectId) =>
    sent.filter((m) => m.to === token(userId.toHexString()));

  it('복습할 문제가 있는 사용자만 받는다: 지운 세트 · 다 익힘 · 넘김 · 멈춤 · 결함 표시 · 내일 이후 · 만드는 중 세트는 제외', async () => {
    const due = await user();
    await quizSet(due, [
      dueQuestion(),
      dueQuestion(),
      question('mastered', null),
      question('moved', null, { movedTo: 'x' }),
    ]);
    const edge = await user(); // 내일 서울 0시 1ms 전: 오늘의 복습 대상
    await quizSet(edge, [question('active', new Date(TOMORROW.getTime() - 1))]);

    const tomorrowExact = await user(); // 내일 서울 0시 정각: 내일 복습
    await quizSet(tomorrowExact, [question('active', TOMORROW)]);
    const deleted = await user();
    await quizSet(deleted, [dueQuestion()], { deletedAt: new Date('2026-11-10T00:00:00Z') });
    const mastered = await user();
    await quizSet(mastered, [question('mastered', null)]);
    const moved = await user();
    await quizSet(moved, [question('moved', null, { movedTo: 'x' })]);
    const stopped = await user();
    await quizSet(stopped, [question('stopped', null)]);
    const flawed = await user();
    await quizSet(flawed, [question('flawed', null, { flaw: '정답이 둘' })]);
    const deferredFlaw = await user(); // 결함 표시가 이미 있는 복습 중 문제: 오늘의 복습이 검사해 미룰 수 있어 세지 않는다
    await quizSet(deferredFlaw, [question('active', TODAY_MIDNIGHT, { flaw: '정답이 둘' })]);
    const generating = await user();
    await quizSet(generating, [dueQuestion()], { status: 'generating' });
    const noMaterial = await user();
    await quizSet(noMaterial, [dueQuestion()], { materialId: null });
    const none = await user(); // 세트가 없다
    void none;

    await makeService().runOnce(NOW);

    const got = new Set(sent.map((m) => m.to));
    expect(got).toEqual(new Set([token(due.toHexString()), token(edge.toHexString())]));
    // 문제 수는 복습할 문제만 센다(다 익힘 · 넘김 제외): due 사용자는 2개
    expect(sentTo(due)[0]).toMatchObject({
      title: '오늘 복습할 문제가 있어요',
      body: '복습할 문제 2개가 기다리고 있어요',
      data: { type: 'today-review' },
      collapseId: `today-review:${DAY}:${due.toHexString()}`,
    });
    expect(sentTo(due)[0]).not.toHaveProperty('channelId');
    expect((await row(due))!.state).toBe('sent');
  });

  it('여러 세트의 문제를 합쳐 세고, 문제 수는 5개를 넘겨 적지 않는다', async () => {
    const owner = await user();
    await quizSet(owner, [dueQuestion(), dueQuestion(), dueQuestion()]);
    await quizSet(owner, [dueQuestion(), dueQuestion(), dueQuestion(), dueQuestion()]);
    await makeService().runOnce(NOW);
    expect(sentTo(owner)[0]!.body).toBe('복습할 문제 5개가 기다리고 있어요');
  });

  it('하루에 한 번만 보낸다(다시 확인해도 · 서버 둘이 동시에 돌아도 1번)', async () => {
    const owner = await user();
    await quizSet(owner, [dueQuestion()]);
    const a = makeService();
    const b = makeService();
    await Promise.all([a.runOnce(NOW), b.runOnce(NOW)]);
    expect(sentTo(owner)).toHaveLength(1);
    expect((await row(owner))!.state).toBe('sent');
    await a.runOnce(seoul('19:31'));
    await b.runOnce(seoul('20:00'));
    expect(sentTo(owner)).toHaveLength(1);
  });

  it('서버가 19:00 이후에 재시작해 다시 집계해도, 이미 보낸 사용자는 review_reminders 로 걸러져 한 번만 간다', async () => {
    const first = await user();
    const second = await user();
    await quizSet(first, [dueQuestion()]);
    await quizSet(second, [dueQuestion()]);
    await makeService().runOnce(NOW);
    expect(sent).toHaveLength(2);

    const aggregate = vi.spyOn(sets, 'aggregate');
    const restarted = makeService(); // 메모리의 집계 목록이 없는 새 서버
    await restarted.runOnce(seoul('20:10'));
    expect(aggregate).toHaveBeenCalled(); // 다시 집계했다
    aggregate.mockRestore();
    expect(sent).toHaveLength(2); // 그래도 더 보내지 않았다

    // 재시작 전에 보낸 사용자 말고 그 사이 새로 생긴 대상은 받는다
    const late = await user();
    await quizSet(late, [dueQuestion()]);
    await makeService().runOnce(seoul('20:20'));
    expect(sentTo(late)).toHaveLength(1);
    expect(sent).toHaveLength(3);
  });

  it('오늘의 복습 세트를 이미 만든 사용자는 제외한다(지운 오늘의 복습 세트는 만든 것으로 치지 않는다)', async () => {
    const made = await user();
    await quizSet(made, [dueQuestion()]);
    await quizSet(made, [], { materialId: undefined, reviewDay: DAY, status: 'generating' });
    const deletedToday = await user();
    await quizSet(deletedToday, [dueQuestion()]);
    await quizSet(deletedToday, [], { reviewDay: DAY, deletedAt: new Date() });
    const otherDay = await user();
    await quizSet(otherDay, [dueQuestion()]);
    await quizSet(otherDay, [], { reviewDay: '2026-11-16' });

    await makeService().runOnce(NOW);
    expect(sentTo(made)).toHaveLength(0);
    expect((await row(made))!.state).toBe('skipped');
    expect(sentTo(deletedToday)).toHaveLength(1);
    expect(sentTo(otherDay)).toHaveLength(1);
  });

  it('탈퇴 중 · 탈퇴한 사용자와 기기가 없는 사용자에게는 보내지 않고 skipped 로 끝낸다', async () => {
    const withdrawing = await user({ withdrawingAt: new Date('2026-11-17T01:00:00Z') });
    const deleted = await user({ deletedAt: new Date('2026-11-16T01:00:00Z') });
    const noDevice = await user({}, false);
    const normal = await user();
    for (const id of [withdrawing, deleted, noDevice, normal]) await quizSet(id, [dueQuestion()]);

    await makeService().runOnce(NOW);
    expect(sent.map((m) => m.to)).toEqual([token(normal.toHexString())]);
    for (const id of [withdrawing, deleted, noDevice]) {
      expect((await row(id))!.state).toBe('skipped');
    }
  });

  it('보내는 시각(19:00) 전에는 안 보내고, 그 이후에 보낸다', async () => {
    const owner = await user();
    await quizSet(owner, [dueQuestion()]);
    const svc = makeService();
    const aggregate = vi.spyOn(sets, 'aggregate');
    await svc.runOnce(seoul('18:59'));
    expect(aggregate).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    aggregate.mockRestore();
    await svc.runOnce(seoul('19:00'));
    expect(sent).toHaveLength(1);
  });

  it('날짜가 바뀌면 그날 것은 보내지 않는다(자정 이후 · 발송 직전 자정을 넘김)', async () => {
    const early = await user();
    await quizSet(early, [dueQuestion()]);
    await makeService().runOnce(seoul('00:30', NEXT_DAY)); // 다음 날 새벽: 19:00 전이라 아무것도 안 한다
    expect(sent).toHaveLength(0);
    expect(await row(early, NEXT_DAY)).toBeNull();

    // 발송 직전에 자정을 넘기면 보내지 않는다(기기를 읽은 뒤 시계가 다음 날이 된다)
    let late = false;
    const original = devices.find.bind(devices);
    const spy = vi.spyOn(devices, 'find').mockImplementation(((...args: unknown[]) => {
      late = true;
      return (original as (...a: unknown[]) => unknown)(...args);
    }) as never);
    try {
      await makeService().runOnce(undefined, () =>
        late ? seoul('00:00', NEXT_DAY) : seoul('23:59'),
      );
    } finally {
      spy.mockRestore();
    }
    expect(sent).toHaveLength(0);
    expect((await row(early))!.state).toBe('claimed'); // 기록하지 않았다(다음 날 것으로 넘기지 않는다)
  });

  it('발송 성공 뒤 sent 기록이 끝내 실패해도 푸시는 1번이고, 다음 확인에서 먼저 다시 써서 sent 가 된다', async () => {
    const owner = await user();
    await quizSet(owner, [dueQuestion()]);
    const original = reminders.updateOne.bind(reminders);
    let failed = 0;
    const spy = vi.spyOn(reminders, 'updateOne').mockImplementation(((
      filter: never,
      update: { $set?: Record<string, unknown> },
      options: never,
    ) => {
      if (failed < 3 && update.$set?.['state'] === 'sent') {
        failed += 1;
        return Promise.reject(new Error('db down'));
      }
      return original(filter, update, options);
    }) as never);
    try {
      const svc = makeService();
      await svc.runOnce(NOW);
      expect(sent).toHaveLength(1);
      expect((await row(owner))!.state).toBe('claimed'); // 선점이 남아 있다
      await svc.runOnce(seoul('19:31')); // 선점이 아직 살아 있는 동안 먼저 다시 쓴다
      expect(sent).toHaveLength(1);
      expect((await row(owner))!.state).toBe('sent');
    } finally {
      spy.mockRestore();
    }
  });

  it('선점한 서버가 죽어 claimed 로 남으면 2분 뒤 다른 서버가 이어받는다(그 전에는 보내지 않는다)', async () => {
    const owner = await user();
    await quizSet(owner, [dueQuestion()]);
    await reminders.collection.insertOne({
      userId: owner,
      day: DAY,
      state: 'claimed',
      claimId: 'dead',
      claimedAt: NOW,
      attempts: 1,
      retryAt: null,
      createdAt: NOW,
    });
    const svc = makeService();
    await svc.runOnce(new Date(NOW.getTime() + REVIEW_REMIND_LEASE_MS - 1000));
    expect(sent).toHaveLength(0);
    // 선점이 만료된 뒤 첫 확인(한 번의 확인 간격 안)에서 이어받는다
    await svc.runOnce(new Date(NOW.getTime() + REVIEW_REMIND_LEASE_MS + 61_000));
    expect(sent).toHaveLength(1);
    expect(await row(owner)).toMatchObject({ state: 'sent', attempts: 2 });
  });

  it('발송이 계속 실패하면 3번까지만 다시 시도하고 gave_up 으로 멈춘다(실제 시도 횟수로 판정)', async () => {
    const owner = await user();
    await quizSet(owner, [dueQuestion()]);
    sendImpl = () => Promise.resolve(fail);
    const svc = makeService();
    await svc.runOnce(NOW);
    expect((await row(owner))!.state).toBeNull(); // 풀렸고 retryAt 이 잡혔다
    await svc.runOnce(new Date(NOW.getTime() + 60_000)); // 2분 전이라 건너뜀
    expect(sent).toHaveLength(1);
    await svc.runOnce(new Date(NOW.getTime() + 3 * 60_000));
    await svc.runOnce(new Date(NOW.getTime() + 20 * 60_000));
    await svc.runOnce(new Date(NOW.getTime() + 40 * 60_000));
    expect(sent).toHaveLength(REVIEW_REMIND_MAX_ATTEMPTS);
    expect(await row(owner)).toMatchObject({
      state: 'gave_up',
      attempts: REVIEW_REMIND_MAX_ATTEMPTS,
    });
  });

  it('다른 서버가 먼저 재시도해 DB의 횟수가 올라 있으면, 이 서버가 읽은 값과 상관없이 실제 3번째 실패에서 gave_up 으로 기록한다', async () => {
    const owner = await user();
    await quizSet(owner, [dueQuestion()]);
    await reminders.collection.insertOne({
      userId: owner,
      day: DAY,
      state: null,
      attempts: 2,
      retryAt: null,
      createdAt: NOW,
    });
    sendImpl = () => Promise.resolve(fail);
    await makeService().runOnce(NOW);
    expect(await row(owner)).toMatchObject({
      state: 'gave_up',
      attempts: REVIEW_REMIND_MAX_ATTEMPTS,
    });
  });

  it('시도 횟수가 한도에 닿은 만료된 claimed 는 gave_up 으로 닫고, 살아 있는 선점은 건드리지 않는다', async () => {
    const expired = await user();
    const live = await user();
    const claimed = (userId: Types.ObjectId, claimedAt: Date) => ({
      userId,
      day: DAY,
      state: 'claimed',
      claimId: 'x',
      claimedAt,
      attempts: REVIEW_REMIND_MAX_ATTEMPTS,
      retryAt: null,
      createdAt: NOW,
    });
    await reminders.collection.insertOne(claimed(expired, new Date(NOW.getTime() - 3 * 60_000)));
    await reminders.collection.insertOne(claimed(live, new Date(NOW.getTime() - 30_000)));
    await makeService().runOnce(NOW);
    expect((await row(expired))!.state).toBe('gave_up');
    expect((await row(live))!.state).toBe('claimed');
    expect(sent).toHaveLength(0);
  });

  it('review_reminders 에는 (userId, day) 유니크 색인과 TTL 색인이 있다', async () => {
    const indexes = await reminders.collection.indexes();
    const unique = indexes.find((i) => JSON.stringify(i.key) === '{"userId":1,"day":1}');
    expect(unique?.unique).toBe(true);
    const ttl = indexes.find((i) => JSON.stringify(i.key) === '{"createdAt":1}');
    expect(ttl?.expireAfterSeconds).toBe(REVIEW_REMIND_TTL_SECONDS);
    const owner = new Types.ObjectId();
    await reminders.collection.insertOne({ userId: owner, day: DAY, createdAt: NOW });
    await expect(
      reminders.collection.insertOne({ userId: owner, day: DAY, createdAt: NOW }),
    ).rejects.toMatchObject({ code: 11000 });
  });

  it('quiz_sets 에는 복습 알림용 색인을 만들지 않는다(집계는 하루 한 번)', async () => {
    const owner = await user();
    await quizSet(owner, [dueQuestion()]);
    await makeService().runOnce(NOW);
    const indexes = await sets.collection.indexes();
    expect(JSON.stringify(indexes.map((i) => i.key))).not.toContain('questions.srs');
  });
});
