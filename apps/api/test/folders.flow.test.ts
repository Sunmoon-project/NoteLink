import type { INestApplication } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { ERROR_CODES, Folder as SharedFolder, PATHS } from '@notelink/shared';
import { Types } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { RefreshToken } from '../src/modules/auth/schemas/refresh-token.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { Folder } from '../src/modules/content/schemas/folder.schema.js';
import { Material } from '../src/modules/content/schemas/material.schema.js';
import { Subject } from '../src/modules/session/schemas/subject.schema.js';
import { createAppModuleBuilder, stubAppEnv } from './support/app-module.js';
import { createFakeCollection, matches, type Row } from './support/fake-collection.js';
import { createFakeRefreshTokens } from './support/fake-refresh-tokens.js';

const api = (path: string) => `/api/v1${path}`;

/** 서비스가 쓰는 꼴만: [{ $match }, { $group: { _id: '$필드', count: { $sum: 1 } } }] */
function withCount(rows: Row[]) {
  type Stage = { $match?: Record<string, unknown>; $group?: { _id: string } };
  return (pipeline: Stage[]) => {
    const [match, group] = pipeline;
    const key = group!.$group!._id.slice(1);
    const counts = new Map<string, { _id: unknown; count: number }>();
    for (const r of rows.filter((x) => matches(x, match!.$match!))) {
      const entry = counts.get(String(r[key])) ?? { _id: r[key], count: 0 };
      entry.count += 1;
      counts.set(String(r[key]), entry);
    }
    return Promise.resolve([...counts.values()]);
  };
}

describe('학습 폴더 (GET · POST /api/v1/folders)', () => {
  let app: INestApplication;
  const folders = createFakeCollection<Folder>();
  const materials = createFakeCollection<Material>();
  const subjects = createFakeCollection<Subject>();
  const me = new Types.ObjectId();
  const other = new Types.ObjectId();
  let token: string;

  beforeAll(async () => {
    stubAppEnv();
    const ref = await createAppModuleBuilder()
      .overrideProvider(getModelToken(RefreshToken.name))
      .useValue(createFakeRefreshTokens().model)
      .overrideProvider(getModelToken(Folder.name))
      .useValue(folders.model)
      .overrideProvider(getModelToken(Material.name))
      .useValue({ ...materials.model, aggregate: withCount(materials.rows) })
      .overrideProvider(getModelToken(Subject.name))
      .useValue(subjects.model)
      .compile();
    app = ref.createNestApplication();
    configureApp(app);
    await app.init();
    token = (await ref.get(TokenService).issue(me.toHexString())).accessToken;
  });

  afterAll(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    folders.rows.length = 0;
    materials.rows.length = 0;
    subjects.rows.length = 0;
  });

  const list = () =>
    request(app.getHttpServer()).get(api(PATHS.folders)).set('Authorization', `Bearer ${token}`);
  const create = (body: unknown) =>
    request(app.getHttpServer())
      .post(api(PATHS.folders))
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);
  const folder = (over: Record<string, unknown> = {}) => {
    const row: Row = {
      _id: new Types.ObjectId(),
      ownerId: me,
      title: '운영체제',
      subjectId: null,
      subjectName: '기타',
      deletedAt: null,
      createdAt: new Date('2026-11-10T00:00:00.000Z'),
      updatedAt: new Date('2026-11-10T00:00:00.000Z'),
      ...over,
    };
    folders.rows.push(row);
    return row;
  };
  const material = (folderId: unknown, over: Record<string, unknown> = {}) =>
    materials.rows.push({
      _id: new Types.ObjectId(),
      ownerId: me,
      folderId,
      deletedAt: null,
      ...over,
    } as Row);

  it('로그인하지 않으면 401', async () => {
    await request(app.getHttpServer()).get(api(PATHS.folders)).expect(401);
    await request(app.getHttpServer())
      .post(api(PATHS.folders))
      .send({ title: 'a', subjectName: '수학' })
      .expect(401);
  });

  describe('목록', () => {
    it('폴더가 없으면 빈 목록', async () => {
      const res = await list().expect(200);
      expect(res.body.data).toEqual([]);
    });

    it('공용 Folder 모양에 자료 수를 붙여, 최근에 바뀐 순으로 돌려준다', async () => {
      const old = folder({ title: '옛 폴더', updatedAt: new Date('2026-11-01T00:00:00.000Z') });
      const recent = folder({ title: '새 폴더', updatedAt: new Date('2026-11-12T00:00:00.000Z') });
      material(old._id);
      material(old._id);

      const res = await list().expect(200);

      expect(res.body.data.map((f: { title: string }) => f.title)).toEqual(['새 폴더', '옛 폴더']);
      for (const f of res.body.data) SharedFolder.parse(f);
      expect(res.body.data[0]).toMatchObject({ _id: String(recent._id), materialCount: 0 });
      expect(res.body.data[1]).toMatchObject({
        _id: String(old._id),
        subjectId: null,
        subjectName: '기타',
        materialCount: 2,
      });
    });

    it('남의 폴더 · 지운 폴더는 보이지 않는다', async () => {
      folder({ title: '내 것' });
      folder({ title: '남의 것', ownerId: other });
      folder({ title: '지운 것', deletedAt: new Date() });

      const res = await list().expect(200);

      expect(res.body.data.map((f: { title: string }) => f.title)).toEqual(['내 것']);
    });

    it('자료 수는 지우지 않은 내 자료만 센다', async () => {
      const f = folder();
      material(f._id);
      material(f._id, { deletedAt: new Date() });
      material(f._id, { ownerId: other });
      material(new Types.ObjectId());

      const res = await list().expect(200);

      expect(res.body.data[0].materialCount).toBe(1);
    });

    it('과목 이름이 없는 옛 폴더도 돌려준다', async () => {
      const subjectId = new Types.ObjectId();
      folder({ subjectId, subjectName: undefined });

      const res = await list().expect(200);

      SharedFolder.parse(res.body.data[0]);
      expect(res.body.data[0].subjectId).toBe(String(subjectId));
      expect(res.body.data[0]).not.toHaveProperty('subjectName');
    });
  });

  describe('만들기', () => {
    it('내 폴더로 만들고 공용 Folder 모양으로 돌려준다(앞뒤 공백은 자름)', async () => {
      const res = await create({ title: '  자료구조  ', subjectName: ' 수학 ' }).expect(201);

      const made = SharedFolder.parse(res.body.data);
      expect(made).toMatchObject({ title: '자료구조', subjectId: null, subjectName: '수학' });
      expect(folders.rows).toHaveLength(1);
      expect(String(folders.rows[0]!['ownerId'])).toBe(String(me));
      expect(folders.rows[0]).toMatchObject({ title: '자료구조', subjectName: '수학' });
    });

    it('만든 폴더가 목록에 보인다', async () => {
      const made = (await create({ title: '자료구조', subjectName: '수학' }).expect(201)).body.data;
      const res = await list().expect(200);
      expect(res.body.data).toEqual([{ ...made, materialCount: 0 }]);
    });

    it('과목 목록에 같은 이름의 쓰는 과목이 있으면 그 ID를 붙인다', async () => {
      const math = new Types.ObjectId();
      subjects.rows.push({ _id: math, name: '수학', isActive: true });
      subjects.rows.push({ _id: new Types.ObjectId(), name: '영어', isActive: false });

      const a = await create({ title: 'a', subjectName: '수학' }).expect(201);
      const b = await create({ title: 'b', subjectName: '영어' }).expect(201);

      expect(a.body.data.subjectId).toBe(String(math));
      expect(b.body.data).toMatchObject({ subjectId: null, subjectName: '영어' });
    });

    it('같은 제목의 폴더를 또 만들 수 있다', async () => {
      await create({ title: '자료구조', subjectName: '수학' }).expect(201);
      await create({ title: '자료구조', subjectName: '수학' }).expect(201);
      expect(folders.rows).toHaveLength(2);
    });

    it('제목 50자 · 과목 이름 30자까지 받는다', async () => {
      await create({ title: '가'.repeat(50), subjectName: '나'.repeat(30) }).expect(201);
    });

    it.each([
      ['본문 없음', undefined],
      ['제목 없음', { subjectName: '수학' }],
      ['제목이 공백뿐', { title: '   ', subjectName: '수학' }],
      ['제목 51자', { title: '가'.repeat(51), subjectName: '수학' }],
      ['제목이 글자가 아님', { title: 1, subjectName: '수학' }],
      ['과목 없음', { title: '자료구조' }],
      ['과목이 공백뿐', { title: '자료구조', subjectName: ' ' }],
      ['과목 31자', { title: '자료구조', subjectName: '나'.repeat(31) }],
    ])('%s 이면 VALIDATION_FAILED이고 만들지 않는다', async (_name, body) => {
      const res = await create(body).expect(400);
      expect(res.body.code).toBe(ERROR_CODES.VALIDATION);
      expect(folders.rows).toHaveLength(0);
    });
  });
});
