import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES, FolderCreateBody } from '@notelink/shared';
import { type Connection, Model, Types } from 'mongoose';

import { Subject } from '../../session/schemas/subject.schema.js';
import { Folder } from '../schemas/folder.schema.js';
import { Material } from '../schemas/material.schema.js';

/** 앱에 보내는 폴더 모양(packages/shared Folder) */
export interface AppFolder {
  _id: string;
  title: string;
  subjectId: string | null;
  subjectName?: string;
  createdAt: string;
  updatedAt: string;
}

interface FolderRow {
  _id: Types.ObjectId;
  title: string;
  subjectId?: Types.ObjectId | null;
  subjectName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const toAppFolder = (f: FolderRow): AppFolder => ({
  _id: String(f._id),
  title: f.title,
  subjectId: f.subjectId ? String(f.subjectId) : null,
  ...(f.subjectName ? { subjectName: f.subjectName } : {}),
  createdAt: f.createdAt.toISOString(),
  updatedAt: f.updatedAt.toISOString(),
});

@Injectable()
export class FoldersService {
  constructor(
    @InjectModel(Folder.name) private readonly folders: Model<Folder>,
    @InjectModel(Material.name) private readonly materials: Model<Material>,
    @InjectModel(Subject.name) private readonly subjects: Model<Subject>,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** 내 폴더(지우지 않은 것, 최근에 바뀐 순)와 폴더마다 지우지 않은 자료 수 */
  async list(userId: string): Promise<(AppFolder & { materialCount: number })[]> {
    const ownerId = new Types.ObjectId(userId);
    const rows = await this.folders
      .find({ ownerId, deletedAt: null })
      .sort({ updatedAt: -1 })
      .lean<FolderRow[]>();
    if (rows.length === 0) return [];
    const counted = await this.materials.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { ownerId, folderId: { $in: rows.map((f) => f._id) }, deletedAt: null } },
      { $group: { _id: '$folderId', count: { $sum: 1 } } },
    ]);
    const counts = new Map(counted.map((c) => [String(c._id), c.count]));
    return rows.map((f) => ({ ...toAppFolder(f), materialCount: counts.get(String(f._id)) ?? 0 }));
  }

  /** 폴더를 만든다. 과목은 이름을 그대로 두고, 과목 목록에 같은 이름이 있으면 그 ID도 붙인다 */
  async create(userId: string, raw: unknown): Promise<AppFolder> {
    const body = FolderCreateBody.safeParse(raw);
    if (!body.success)
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '폴더 이름과 과목을 확인해 주세요',
      });
    const { title, subjectName } = body.data;
    const subject = await this.subjects
      .findOne({ name: subjectName, isActive: true })
      .lean<{ _id: Types.ObjectId }>();
    const created = await this.folders.create({
      ownerId: new Types.ObjectId(userId),
      title,
      subjectId: subject?._id ?? null,
      subjectName,
    });
    return toAppFolder(created.toObject() as unknown as FolderRow);
  }

  /**
   * 폴더와 그 안의 지우지 않은 노트를 한 트랜잭션으로 지운 것으로 표시한다(소프트 삭제): 둘 다 지워지거나 둘 다 그대로다.
   * 이미 지운 노트의 지운 시각은 바꾸지 않는다. 노트의 진행 중인 작업 · 퀴즈 세트 · 원본 파일은 건드리지 않는다.
   * 남의 폴더 · 지운 폴더 · 없는 폴더 · 잘못된 id 는 404
   */
  async remove(userId: string, id: string): Promise<void> {
    const notFound = () =>
      new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: '폴더 정보를 찾을 수 없어요' });
    if (!/^[0-9a-f]{24}$/i.test(id)) throw notFound();
    const _id = new Types.ObjectId(id);
    const ownerId = new Types.ObjectId(userId);
    await this.connection.transaction(async (session) => {
      const now = new Date();
      const folder = await this.folders.findOneAndUpdate(
        { _id, ownerId, deletedAt: null },
        { $set: { deletedAt: now } },
        { session },
      );
      if (!folder) throw notFound();
      await this.materials.updateMany(
        { ownerId, folderId: _id, deletedAt: null },
        { $set: { deletedAt: now } },
        { session },
      );
    });
  }
}
