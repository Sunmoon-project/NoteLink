// 진짜 MongoDB에서 「나에게 공유된 친구 시간표」(GET /timetable/shared, SOC-009)를 확인한다.
// 친구 요청 · 수락 · 끊기(FriendsController)와 시간표 공유(TimetableController)를 실제 API로 거쳐, 공유받은 친구만 ·
// 지금 관계로 한 공유만 · 탈퇴(중)한 주인 제외 · 빈 시간만이면 과목명 없는 바쁜 시간만 보이는지 본다.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/timetable-shared-real-db.test.ts
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { SharedTimetable } from '@notelink/shared';
import { type Connection, type Model, Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../src/modules/calendar/schemas/timetable-share.schema.js';
import { Timetable, TimetableSchema } from '../src/modules/calendar/schemas/timetable.schema.js';
import { NotificationService } from '../src/modules/notification/notification.service.js';
import { FriendsController } from '../src/modules/social/friends/friends.controller.js';
import { FriendsService } from '../src/modules/social/friends/friends.service.js';
import {
  FriendSharedItem,
  FriendSharedItemSchema,
} from '../src/modules/social/schemas/friend-shared-item.schema.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';
import { TimetableController } from '../src/modules/timetable/timetable.controller.js';
import { TimetableService } from '../src/modules/timetable/timetable.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_timetable_shared_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 공유받은 친구 시간표', () => {
  const people = {
    me: new Types.ObjectId(),
    full: new Types.ObjectId(), // 나에게 전체 공개
    free: new Types.ObjectId(), // 나에게 빈 시간만
    other: new Types.ObjectId(), // 친구지만 나에게는 공유 안 함(full 이 다른 사람에게 공유한 것도 섞이면 안 된다)
    cut: new Types.ObjectId(), // 공유한 뒤 친구를 끊음
    renewed: new Types.ObjectId(), // 끊었다 다시 친구가 됨(예전 관계의 공유 줄이 남아 있음)
    stranger: new Types.ObjectId(), // 친구가 아닌데 공유 줄만 있음
    gone: new Types.ObjectId(), // 공유한 뒤 탈퇴
    leaving: new Types.ObjectId(), // 공유한 뒤 탈퇴 중
  };
  type Name = keyof typeof people;
  let app: INestApplication;
  let conn: Connection;
  const http = () => request(app.getHttpServer());
  const as = (name: Name) => ({ Authorization: `Bearer token-${name}` });
  const befriend = async (a: Name, b: Name) => {
    await http()
      .post('/api/v1/friend-requests')
      .set(as(a))
      .send({ userId: people[b].toHexString() })
      .expect(204);
    // 상대가 맞요청하면 친구가 된다
    await http()
      .post('/api/v1/friend-requests')
      .set(as(b))
      .send({ userId: people[a].toHexString() })
      .expect(204);
  };
  const share = (from: Name, to: Name[], mode: 'full' | 'free_only') =>
    http()
      .post('/api/v1/timetable/shares')
      .set(as(from))
      .send({ friendIds: to.map((n) => people[n].toHexString()), mode })
      .expect(204);
  const addClass = (
    who: Name,
    subjectName: string,
    days: number[],
    startTime: string,
    endTime: string,
  ) =>
    http()
      .post('/api/v1/timetable/classes')
      .set(as(who))
      .send({
        subjectName,
        days,
        startTime,
        endTime,
        location: `${subjectName} 강의실`,
        color: '#abcdef',
      })
      .expect(201);
  const sharedOf = async (who: Name) =>
    (await http().get('/api/v1/timetable/shared').set(as(who)).expect(200)).body
      .data as SharedTimetable[];

  beforeAll(async () => {
    if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
    const byToken = new Map(
      Object.entries(people).map(([name, id]) => [`token-${name}`, id.toHexString()]),
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: Friendship.name, schema: FriendshipSchema },
          { name: TimetableShare.name, schema: TimetableShareSchema },
          { name: Timetable.name, schema: TimetableSchema },
          { name: FriendSharedItem.name, schema: FriendSharedItemSchema },
        ]),
      ],
      controllers: [FriendsController, TimetableController],
      providers: [
        FriendsService,
        TimetableService,
        { provide: NotificationService, useValue: { notify: async () => {} } },
        {
          provide: TokenService,
          useValue: {
            verifyAccess: (t: string) =>
              byToken.has(t)
                ? Promise.resolve({ userId: byToken.get(t) })
                : Promise.reject(new UnauthorizedException()),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    conn = moduleRef.get<Connection>(getConnectionToken());
    await moduleRef.get<Model<TimetableShare>>(getModelToken(TimetableShare.name)).syncIndexes();
    await conn.collection('users').insertMany(
      Object.entries(people).map(([name, _id]) => ({
        _id,
        nickname: `${name}_${process.pid}`,
        email: null,
        status: 'active',
        deletedAt: null,
        withdrawingAt: null,
      })),
    );

    await addClass('full', '수학 II', [2, 4], '10:00', '11:30');
    await addClass('free', '비밀 과목 A', [1], '09:00', '10:00');
    await addClass('free', '비밀 과목 B', [1], '10:00', '11:00'); // 이어짐 → 09:00-11:00 한 덩어리
    await addClass('free', '비밀 과목 C', [3], '13:00', '14:00');
    for (const n of ['other', 'cut', 'renewed', 'stranger', 'gone', 'leaving'] as const)
      await addClass(n, `${n} 과목`, [5], '09:00', '10:00');

    for (const n of ['full', 'free', 'other', 'cut', 'renewed', 'gone', 'leaving'] as const)
      await befriend('me', n);
    await befriend('full', 'other');

    await share('full', ['me', 'other'], 'full');
    await share('free', ['me'], 'free_only');
    await share('other', ['full'], 'full'); // 나에게는 공유하지 않았다
    await share('cut', ['me'], 'full');
    await share('gone', ['me'], 'full');
    await share('leaving', ['me'], 'full');

    // 공유한 뒤 친구를 끊는다(끊기가 공유를 정리한다)
    await http().delete(`/api/v1/friends/${people.cut.toHexString()}`).set(as('me')).expect(204);
    // 끊었다 다시 친구가 됐는데, 예전 관계로 만든 공유 줄이 정리되지 않고 남아 있다
    await share('renewed', ['me'], 'full');
    const old = await conn
      .collection('timetable_shares')
      .findOne({ ownerId: people.renewed, friendId: people.me });
    await http()
      .delete(`/api/v1/friends/${people.renewed.toHexString()}`)
      .set(as('me'))
      .expect(204);
    await befriend('me', 'renewed');
    await conn.collection('timetable_shares').insertOne(old!);
    // 친구가 아닌 사람의 공유 줄(직접 넣음)
    await conn.collection('timetable_shares').insertOne({
      ownerId: people.stranger,
      friendId: people.me,
      mode: 'full',
      sharedAt: new Date(),
      friendshipId: null,
    });
    await conn
      .collection('users')
      .updateOne({ _id: people.gone }, { $set: { deletedAt: new Date() } });
    await conn
      .collection('users')
      .updateOne({ _id: people.leaving }, { $set: { withdrawingAt: new Date() } });
  }, 60_000);

  afterAll(async () => {
    if (conn) await conn.dropDatabase();
    await app?.close();
  });

  it('로그인 없이는 401', async () => {
    await http().get('/api/v1/timetable/shared').expect(401);
  });

  it('나에게 공유한 지금 친구만, 공유한 순서로 보인다(끊김 · 다시 맺기 전 공유 · 친구 아님 · 탈퇴 · 남에게 한 공유 제외)', async () => {
    const list = await sharedOf('me');
    expect(list.map((t) => t.ownerId)).toEqual(
      [people.full, people.free].map((id) => id.toHexString()),
    );
    for (const t of list) expect(SharedTimetable.safeParse(t).success).toBe(true);
    expect(list[0]).toMatchObject({
      nickname: `full_${process.pid}`,
      mode: 'full',
      classes: [
        {
          days: [2, 4],
          startTime: '10:00',
          endTime: '11:30',
          subjectName: '수학 II',
          location: '수학 II 강의실',
        },
      ],
    });
  });

  it('빈 시간만 공유는 과목명 · 장소 없이 요일별로 합친 바쁜 시간만 준다', async () => {
    const free = (await sharedOf('me')).find((t) => t.ownerId === people.free.toHexString())!;
    expect(free.mode).toBe('free_only');
    expect(free.classes).toEqual([
      { days: [1], startTime: '09:00', endTime: '11:00', subjectName: null, location: null },
      { days: [3], startTime: '13:00', endTime: '14:00', subjectName: null, location: null },
    ]);
    expect(JSON.stringify(free)).not.toMatch(/비밀/);
  });

  it('공유받은 쪽에서만 보인다: 공유한 사람 자신 · 공유받지 않은 친구에게는 보이지 않는다', async () => {
    // full 은 other 에게서만 공유받았다
    expect((await sharedOf('full')).map((t) => t.ownerId)).toEqual([people.other.toHexString()]);
    // 아무것도 공유받지 않은 사람
    expect(await sharedOf('stranger')).toEqual([]);
  });

  it('받은 공유를 찾는 인덱스(friendId · sharedAt)가 있다', async () => {
    const indexes = await conn.collection('timetable_shares').indexes();
    expect(
      indexes.some((i) => JSON.stringify(i.key) === JSON.stringify({ friendId: 1, sharedAt: 1 })),
    ).toBe(true);
  });
});
