// 진짜 MongoDB에서 「내가 보낸 대기 중 친구 요청」(GET /friend-requests/sent)을 확인한다.
// 스터디룸 멤버 창 · 친구 추가 화면이 다시 열어도 「요청 보냄」을 보이려고 쓴다.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../src/modules/calendar/schemas/timetable-share.schema.js';
import { NotificationService } from '../src/modules/notification/notification.service.js';
import { FriendsController } from '../src/modules/social/friends/friends.controller.js';
import { FriendsService } from '../src/modules/social/friends/friends.service.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_friend_sent_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 내가 보낸 친구 요청', () => {
  const people = {
    me: new Types.ObjectId(),
    pending: new Types.ObjectId(),
    toMe: new Types.ObjectId(),
    friend: new Types.ObjectId(),
    gone: new Types.ObjectId(),
    rejecter: new Types.ObjectId(),
  };
  const token = (name: keyof typeof people) => `token-${name}`;
  const notify = vi.fn(async () => {});
  let app: INestApplication;
  let conn: Connection;
  const http = () => request(app.getHttpServer());
  const as = (name: keyof typeof people) => ({ Authorization: `Bearer ${token(name)}` });
  const send = (from: keyof typeof people, to: keyof typeof people) =>
    http()
      .post('/api/v1/friend-requests')
      .set(as(from))
      .send({ userId: people[to].toHexString() })
      .expect(204);

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
        ]),
      ],
      controllers: [FriendsController],
      providers: [
        FriendsService,
        { provide: NotificationService, useValue: { notify } },
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
    await conn.collection('users').insertMany(
      Object.entries(people).map(([name, _id]) => ({
        _id,
        nickname: `${name}_${process.pid}`,
        email: null,
        status: 'active',
        deletedAt: null,
      })),
    );
    await send('me', 'pending');
    await send('toMe', 'me');
    await send('me', 'friend');
    await send('friend', 'me'); // 상대가 맞요청하면 친구가 된다(대기 아님)
    await send('me', 'gone');
    await send('me', 'rejecter');
    const [request] = (
      await http().get('/api/v1/friend-requests/received').set(as('rejecter')).expect(200)
    ).body.data as { _id: string }[];
    await http()
      .post(`/api/v1/friend-requests/${request!._id}/reject`)
      .set(as('rejecter'))
      .expect(204);
    await conn
      .collection('users')
      .updateOne({ _id: people.gone }, { $set: { deletedAt: new Date() } });
  }, 30_000);

  afterAll(async () => {
    if (conn) await conn.dropDatabase();
    await app?.close();
  });

  it('내가 보내고 아직 대기 중인 상대만 돌려준다(받은 요청 · 친구 · 탈퇴 · 거절당한 사람은 빼고)', async () => {
    const res = await http().get('/api/v1/friend-requests/sent').set(as('me')).expect(200);
    // 거절당하면 「친구 요청」으로 돌아가 다시 보낼 수 있다
    expect(res.body.data).toEqual([people.pending.toHexString()]);
  });

  it('거절당한 뒤 하루 안에 다시 요청하면 대기로 돌아가 상대의 받은 요청에 보이지만 알림은 다시 보내지 않는다', async () => {
    notify.mockClear();
    await send('me', 'rejecter');
    const received = await http()
      .get('/api/v1/friend-requests/received')
      .set(as('rejecter'))
      .expect(200);
    expect(
      (received.body.data as { requester: { userId: string } }[]).map((r) => r.requester.userId),
    ).toEqual([people.me.toHexString()]);
    expect(notify).not.toHaveBeenCalled();
    const sent = await http().get('/api/v1/friend-requests/sent').set(as('me')).expect(200);
    expect([...sent.body.data].sort()).toEqual(
      [people.pending, people.rejecter].map((id) => id.toHexString()).sort(),
    );
  });

  it('거절당한 뒤 하루가 지나 다시 요청하면 알림이 한 번 간다(하루 안의 되풀이는 묶는다)', async () => {
    const [again] = (
      await http().get('/api/v1/friend-requests/received').set(as('rejecter')).expect(200)
    ).body.data as { _id: string }[];
    await http()
      .post(`/api/v1/friend-requests/${again!._id}/reject`)
      .set(as('rejecter'))
      .expect(204);
    await conn
      .collection('friendships')
      .updateOne(
        { _id: new Types.ObjectId(again!._id) },
        { $set: { requestedAt: new Date(Date.now() - 25 * 60 * 60 * 1000) } },
      );
    notify.mockClear();
    await send('me', 'rejecter');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'friend-request', userIds: [people.rejecter] }),
    );
    // 바로 또 거절 → 다시 요청: 하루 안이라 알림은 늘지 않는다
    await http()
      .post(`/api/v1/friend-requests/${again!._id}/reject`)
      .set(as('rejecter'))
      .expect(204);
    await send('me', 'rejecter');
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('받은 쪽에서 보면 비어 있다', async () => {
    const res = await http().get('/api/v1/friend-requests/sent').set(as('pending')).expect(200);
    expect(res.body.data).toEqual([]);
  });
});
