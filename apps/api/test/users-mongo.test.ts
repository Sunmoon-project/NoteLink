import mongoose, { Types, type Connection } from 'mongoose';
import { ConflictException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** 이 시험이 쓰지 않는 기기 · 토큰 · 친구 · 시간표 공유 모델 자리 */
const UNUSED_MODELS = [{}, {}, {}, {}] as [never, never, never, never];
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { UsersService } from '../src/modules/users/users.service.js';

const uri = process.env.TYPE_STATS_TEST_URI;
const suite = uri ? describe : describe.skip;
suite('MongoDB 프로필 닉네임 동시성', () => {
  let connection: Connection;
  let service: UsersService;
  const ids = [new Types.ObjectId(), new Types.ObjectId()];
  const target = `n${new Types.ObjectId().toHexString().slice(0, 8)}`;
  beforeAll(async () => {
    connection = await mongoose.createConnection(uri!).asPromise();
    const model = connection.model(User.name, UserSchema);
    await model.init();
    await model.create(
      ids.map((_id, index) => ({ _id, nickname: `n${index}${target.slice(1)}`, email: null })),
    );
    service = new UsersService(
      model as never,
      { streakDays: async () => 0 } as never,
      ...UNUSED_MODELS,
    );
  });
  afterAll(async () => {
    if (!connection) return;
    await connection.collection('users').deleteMany({ _id: { $in: ids } });
    await connection.close();
  });
  it('서로 다른 두 사용자가 동시에 같은 닉네임을 저장하면 한 명만 성공한다', async () => {
    const results = await Promise.allSettled(
      ids.map((id) => service.updateProfile(String(id), { nickname: target })),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(ConflictException);
    expect(
      await connection.collection('users').countDocuments({ _id: { $in: ids }, nickname: target }),
    ).toBe(1);
  });
});
