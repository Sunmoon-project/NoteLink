// 진짜 MongoDB에서 접속 신호(PUT · DELETE /users/me/presence)가 친구 목록의 상태로 이어지는지 확인한다.
// 실기기 피드백: 앱을 나가도 친구에게 '활동 중'으로 보였다(사용자가 고른 상태만 보여 줬다).
// MONGODB_VERIFY_URI가 localhost일 때만 돌고, 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: MONGODB_VERIFY_URI="mongodb://localhost:27017/?directConnection=true" npm run test -w @notelink/api -- test/presence-real-db.test.ts
import { type INestApplication, UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { type Connection, Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { EmailCodeService } from '../src/modules/auth/app-login/email-code.service.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import {
  TimetableShare,
  TimetableShareSchema,
} from '../src/modules/calendar/schemas/timetable-share.schema.js';
import { MAIL_SENDER } from '../src/modules/mail/mail-sender.js';
import { ProgressService } from '../src/modules/progress/progress.service.js';
import { FriendsController } from '../src/modules/social/friends/friends.controller.js';
import { FriendsService } from '../src/modules/social/friends/friends.service.js';
import { Friendship, FriendshipSchema } from '../src/modules/social/schemas/friendship.schema.js';
import { StudyRoomMembershipService } from '../src/modules/studyroom/study-room-membership.service.js';
import { Device, DeviceSchema } from '../src/modules/users/schemas/device.schema.js';
import { UsersController } from '../src/modules/users/users.controller.js';
import { UsersService } from '../src/modules/users/users.service.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
const dbName = `notelink_verify_presence_${process.pid}_${Date.now()}`;

describe.skipIf(!isLocal)('진짜 DB 접속 신호 → 친구 목록 상태', () => {
  const me = new Types.ObjectId();
  const friend = new Types.ObjectId();
  const tokens: Record<string, Types.ObjectId> = { 'token-me': me, 'token-friend': friend };
  let app: INestApplication;
  let conn: Connection;
  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });
  /** 내 친구 목록에 보이는 친구의 상태 */
  const friendStatus = async () =>
    ((await http().get('/api/v1/friends').set(as('token-me'))).body.data as { status: string }[])[0]
      ?.status;

  beforeAll(async () => {
    if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
    const moduleRef = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
        MongooseModule.forFeature([
          { name: User.name, schema: UserSchema },
          { name: Device.name, schema: DeviceSchema },
          { name: Friendship.name, schema: FriendshipSchema },
          { name: TimetableShare.name, schema: TimetableShareSchema },
        ]),
      ],
      controllers: [UsersController, FriendsController],
      providers: [
        UsersService,
        FriendsService,
        // 이 시험이 쓰지 않는 의존성
        { provide: ProgressService, useValue: { streakDays: async () => 0 } },
        { provide: StudyRoomMembershipService, useValue: {} },
        { provide: EmailCodeService, useValue: {} },
        { provide: MAIL_SENDER, useValue: {} },
        {
          provide: TokenService,
          useValue: {
            verifyAccess: (t: string) =>
              tokens[t]
                ? Promise.resolve({ userId: tokens[t].toString() })
                : Promise.reject(new UnauthorizedException()),
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    conn = moduleRef.get<Connection>(getConnectionToken());
    await conn.collection('users').insertMany([
      { _id: me, nickname: `me_${process.pid}`, email: null, status: 'active', deletedAt: null },
      { _id: friend, nickname: `fr_${process.pid}`, email: null, status: 'busy', deletedAt: null },
    ]);
    const [userA, userB] = me.toHexString() < friend.toHexString() ? [me, friend] : [friend, me];
    await conn.collection('friendships').insertOne({
      userA,
      userB,
      requesterId: me,
      status: 'accepted',
      requestedAt: new Date(),
    });
  }, 30_000);

  afterAll(async () => {
    if (conn) await conn.dropDatabase();
    await app?.close();
  });

  it('신호가 없던 친구는 고른 상태(바쁨)와 상관없이 오프라인', async () => {
    expect(await friendStatus()).toBe('offline');
  });

  it('친구 앱이 신호를 보내면 고른 상태가 보이고, 앱을 나가며 신호를 거두면 오프라인', async () => {
    await http().put('/api/v1/users/me/presence').set(as('token-friend')).expect(204);
    expect(await friendStatus()).toBe('busy');
    await http().delete('/api/v1/users/me/presence').set(as('token-friend')).expect(204);
    expect(await friendStatus()).toBe('offline');
  });

  it('같은 계정의 두 기기 중 하나만 나가면 다른 기기의 접속 상태가 남는다', async () => {
    const put = (d: string) =>
      http().put(`/api/v1/users/me/presence?device=${d}`).set(as('token-friend')).expect(204);
    const del = (d: string) =>
      http().delete(`/api/v1/users/me/presence?device=${d}`).set(as('token-friend')).expect(204);
    await put('phone');
    await put('tablet');
    await del('phone');
    expect(await friendStatus()).toBe('busy');
    await del('tablet');
    expect(await friendStatus()).toBe('offline');
  });

  it('앱이 꺼져 거두지 못해도 마지막 신호가 2분 넘으면 오프라인', async () => {
    await http().put('/api/v1/users/me/presence').set(as('token-friend')).expect(204);
    await conn
      .collection('users')
      .updateOne({ _id: friend }, { $set: { lastActiveAt: new Date(Date.now() - 3 * 60_000) } });
    expect(await friendStatus()).toBe('offline');
  });

  it('로그인 없이는 신호를 보낼 수 없다', async () => {
    await http().put('/api/v1/users/me/presence').expect(401);
  });
});
