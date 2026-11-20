import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES, type RoomSharedItem as AppRoomSharedItem } from '@notelink/shared';
import { isValidObjectId, Model, Types } from 'mongoose';

import { User } from '../../auth/schemas/user.schema.js';
import { NotificationService } from '../../notification/notification.service.js';
import { RoomSharedItem } from '../../studyroom/schemas/room-shared-item.schema.js';
import { StudyRoom } from '../../studyroom/schemas/study-room.schema.js';
import { StudyChatGateway } from '../../studyroom/study-chat.gateway.js';
import { Material } from '../schemas/material.schema.js';
import type { ShareMaterialsDto } from './dto/share-materials.dto.js';

const DUPLICATE_KEY = 11000;
/** 공유 자료 목록에 한 번에 담는 항목 수(최근 것부터) */
export const SHARED_ITEMS_MAX = 100;
/** 탈퇴 등으로 닉네임을 찾을 수 없을 때(스터디룸 멤버 목록과 같은 문구) */
const UNKNOWN_NICKNAME = '알 수 없는 사용자';

const notFound = (what: string) =>
  new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: `${what} 정보를 찾을 수 없어요` });

/** bulkWrite 가 던진 오류가 모두 중복 키(같은 노트가 동시에 이미 공유됨)인지 */
function onlyDuplicateKeys(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const { code, writeErrors } = e as { code?: unknown; writeErrors?: { code?: unknown }[] };
  if (Array.isArray(writeErrors) && writeErrors.length > 0)
    return writeErrors.every((w) => w.code === DUPLICATE_KEY);
  return code === DUPLICATE_KEY;
}

/**
 * 노트를 스터디룸에 공유하고(room_shared_items), 공유받은 방 멤버의 읽기를 판단한다.
 * 스터디룸 서비스 · 컨트롤러는 쓰지 않고 스키마만 읽는다. "현재 멤버"는 스터디룸과 같은 기준이다:
 * 닫히지 않은 방에서 status 가 joined (나감 · 강퇴 · 초대만 받음은 아님)
 */
@Injectable()
export class MaterialSharingService {
  constructor(
    @InjectModel(Material.name) private readonly materials: Model<Material>,
    @InjectModel(StudyRoom.name) private readonly rooms: Model<StudyRoom>,
    @InjectModel(RoomSharedItem.name) private readonly shared: Model<RoomSharedItem>,
    @InjectModel(User.name) private readonly users: Model<User>,
    private readonly notifications: NotificationService,
    // 공유한 노트를 방 채팅에 자료 카드로 올린다. 없으면(시험) 카드 없이 공유만 한다
    @Optional() private readonly roomChat?: StudyChatGateway,
  ) {}

  /** 닫히지 않은 방에서 내가 현재 멤버(status: joined)인지. 방 id 형식이 틀려도 false */
  private isCurrentMember(me: Types.ObjectId, roomId: string): Promise<boolean> {
    if (!isValidObjectId(roomId)) return Promise.resolve(false);
    return this.rooms
      .exists({
        _id: new Types.ObjectId(roomId),
        closedAt: null,
        members: { $elemMatch: { userId: me, status: 'joined' } },
      })
      .then((found) => found !== null);
  }

  /**
   * 이 노트가 내가 현재 멤버인 방에 공유돼 있으면 노트 주인의 id, 아니면 null. 공유받은 사람의 읽기(상세 · 원본 주소)에서
   * 주인으로 읽기 위해 쓴다: 읽는 쪽은 이 id 를 노트 서비스에 그대로 넘겨 주인 기준으로 동작한다(작업 · 결과 옮기기가 주인 것).
   * 지운 노트 · 지운 공유 · 닫힌 방 · 나감 · 강퇴 · 초대만 받음 · 잘못된 id · 주인이 탈퇴(탈퇴 유예 포함)한 노트는 모두 null
   */
  async ownerOfShared(userId: string, materialId: string): Promise<string | null> {
    if (!isValidObjectId(materialId)) return null;
    const me = new Types.ObjectId(userId);
    const noteId = new Types.ObjectId(materialId);
    const note = await this.materials
      .findOne({ _id: noteId, deletedAt: null }, { ownerId: 1 })
      .lean<{ ownerId: Types.ObjectId }>();
    if (!note) return null;
    const sharedIn = await this.shared
      .find({ materialId: noteId, itemType: 'material', deletedAt: null }, { roomId: 1 })
      .lean<{ roomId: Types.ObjectId }[]>();
    if (sharedIn.length === 0) return null;
    const member = await this.rooms.exists({
      _id: { $in: sharedIn.map((item) => item.roomId) },
      closedAt: null,
      members: { $elemMatch: { userId: me, status: 'joined' } },
    });
    if (!member) return null;
    // 주인이 탈퇴했거나(탈퇴 유예 포함) 계정이 없으면 공유도 없는 것과 같다(FR-03-08). 캘린더 공유와 같은 조건
    const ownerActive = await this.users.exists({
      _id: note.ownerId,
      deletedAt: null,
      withdrawingAt: null,
    });
    return ownerActive ? note.ownerId.toHexString() : null;
  }

  /**
   * 방에 공유된 자료(최근 것부터 SHARED_ITEMS_MAX 개). 현재 멤버만 볼 수 있고, 방이 없거나 멤버가 아니면
   * (나감 · 강퇴 · 초대만 받음 · 잘못된 id 포함) 404. 지운 공유 · 지운 노트 · 탈퇴(탈퇴 유예 포함)한 사람이 공유한 것은 뺀다
   * (뺀 뒤에 개수를 자른다).
   * 제목은 노트의 현재 제목, 닉네임은 공유한 사람의 지금 닉네임이다.
   *
   * 지금은 노트(material) 항목만 담는다. 퀴즈 · 플래시카드 항목은 제목을 가져올 곳(퀴즈 세트 · 카드 묶음)과 그 공유를
   * 만드는 쪽이 아직 없어서 빈 제목으로 내보내는 대신 뺀다 — 그 공유가 생기면 여기서 함께 내려준다.
   * 같은 이유로 flashcards 는 항상 빈 배열이다
   */
  async listRoomItems(
    userId: string,
    roomId: string,
  ): Promise<{ items: AppRoomSharedItem[]; flashcards: never[] }> {
    const me = new Types.ObjectId(userId);
    if (!(await this.isCurrentMember(me, roomId))) throw notFound('스터디룸');
    const rows = await this.shared.aggregate<{
      _id: Types.ObjectId;
      roomId: Types.ObjectId;
      sharedBy: Types.ObjectId;
      materialId: Types.ObjectId;
      folderId?: Types.ObjectId;
      createdAt: Date;
      note: { title: string }[];
    }>([
      { $match: { roomId: new Types.ObjectId(roomId), itemType: 'material', deletedAt: null } },
      { $sort: { createdAt: -1, _id: -1 } },
      {
        $lookup: {
          from: this.materials.collection.name,
          let: { noteId: '$materialId' },
          pipeline: [
            { $match: { $expr: { $eq: ['$_id', '$$noteId'] }, deletedAt: null } },
            { $project: { title: 1 } },
          ],
          as: 'note',
        },
      },
      { $match: { 'note.0': { $exists: true } } },
      // 탈퇴했거나(탈퇴 유예 포함) 계정이 없는 사람이 공유한 항목은 $limit 앞에서 뺀다(뒤에서 빼면 개수가 줄어든다)
      {
        $lookup: {
          from: this.users.collection.name,
          let: { sharerId: '$sharedBy' },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ['$_id', '$$sharerId'] },
                deletedAt: null,
                withdrawingAt: null,
              },
            },
            { $project: { _id: 1 } },
          ],
          as: 'sharer',
        },
      },
      { $match: { 'sharer.0': { $exists: true } } },
      { $limit: SHARED_ITEMS_MAX },
    ]);
    const sharers = [...new Set(rows.map((r) => r.sharedBy.toHexString()))];
    const people = sharers.length
      ? await this.users
          .find(
            { _id: { $in: sharers.map((id) => new Types.ObjectId(id)) }, deletedAt: null },
            { nickname: 1 },
          )
          .lean<{ _id: Types.ObjectId; nickname: string }[]>()
      : [];
    const nicknames = new Map(people.map((u) => [u._id.toHexString(), u.nickname]));
    return {
      items: rows.map((r) => ({
        _id: r._id.toHexString(),
        roomId: r.roomId.toHexString(),
        sharedBy: r.sharedBy.toHexString(),
        sharedByNickname: nicknames.get(r.sharedBy.toHexString()) ?? UNKNOWN_NICKNAME,
        itemType: 'material',
        quizSetId: null,
        folderId: r.folderId ? r.folderId.toHexString() : null,
        materialId: r.materialId.toHexString(),
        questionIds: [],
        flashcardIds: [],
        title: r.note[0]!.title,
        createdAt: r.createdAt.toISOString(),
      })),
      flashcards: [],
    };
  }

  /**
   * 내 노트를 방에 공유한다. 노트가 하나라도 내 것이 아니거나 지웠으면, 방이 없거나 내가 현재 멤버가 아니면 404 이고
   * 아무것도 저장하지 않는다(확인을 모두 마친 뒤에만 쓴다). 이미 공유된 노트는 건너뛴다.
   * 트랜잭션 없이 노트마다 upsert 라, 쓰는 도중 실패해도 같은 요청을 다시 보내면 빠진 것만 채워진다.
   * 동시에 같은 요청이 와도 부분 unique 인덱스(room_material_unique)가 하나만 남긴다
   */
  async share(userId: string, dto: ShareMaterialsDto): Promise<void> {
    if (dto.target.type === 'friend')
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '친구에게 공유는 아직 지원하지 않아요',
      });
    const me = new Types.ObjectId(userId);
    const ids = [...new Set(dto.materialIds.map((id) => id.toLowerCase()))].map(
      (id) => new Types.ObjectId(id),
    );
    const notes = await this.materials
      .find({ _id: { $in: ids }, ownerId: me, deletedAt: null }, { folderId: 1, title: 1 })
      .lean<{ _id: Types.ObjectId; folderId: Types.ObjectId; title: string }[]>();
    if (notes.length !== ids.length) throw notFound('노트');
    if (!(await this.isCurrentMember(me, dto.target.id))) throw notFound('스터디룸');
    const roomId = new Types.ObjectId(dto.target.id);
    let added: number;
    try {
      const result = await this.shared.bulkWrite(
        notes.map((note) => ({
          updateOne: {
            filter: { roomId, itemType: 'material', materialId: note._id, deletedAt: null },
            update: {
              $setOnInsert: {
                sharedBy: me,
                folderId: note.folderId,
                questionIds: [],
                flashcardIds: [],
              },
            },
            upsert: true,
          },
        })),
        { ordered: false },
      );
      added = result.upsertedCount;
    } catch (e) {
      // 같은 노트를 동시에 공유한 다른 요청이 먼저 넣었다 — 그 노트는 이미 공유된 것과 같다.
      // ordered: false 라 나머지는 들어갔을 수 있으니 오류에 담긴 결과에서 새로 넣은 수를 센다
      if (!onlyDuplicateKeys(e)) throw e;
      added = (e as { result?: { upsertedCount?: number } }).result?.upsertedCount ?? 0;
    }
    // 알림은 기다리지 않는다(Expo가 느려도 공유 응답을 늦추지 않게). notifyShared는 던지지 않는다
    if (added > 0) void this.notifyShared(me, roomId, added);
    await this.postCards(userId, roomId, notes);
  }

  /**
   * 방 채팅에 공유한 노트마다 자료 카드를 올린다(이미 있는 카드는 그대로). 이미 공유돼 있던 노트도 카드가 없으면 채운다
   * (전에 카드 없이 공유했거나 지난 요청이 카드 전에 끊긴 경우). 카드는 덤이라 실패해도 공유는 성공이다
   */
  private async postCards(
    userId: string,
    roomId: Types.ObjectId,
    notes: { _id: Types.ObjectId; title: string }[],
  ) {
    if (!this.roomChat) return;
    try {
      const rows = await this.shared
        .find(
          {
            roomId,
            itemType: 'material',
            materialId: { $in: notes.map((n) => n._id) },
            deletedAt: null,
          },
          { materialId: 1 },
        )
        .lean<{ _id: Types.ObjectId; materialId: Types.ObjectId }[]>();
      const titles = new Map(notes.map((n) => [n._id.toHexString(), n.title]));
      await this.roomChat.postSharedNotes(
        roomId.toHexString(),
        userId,
        notes
          .map((n) => rows.find((r) => r.materialId.equals(n._id)))
          .filter((r) => r !== undefined)
          .map((r) => ({ sharedItemId: r._id, title: titles.get(r.materialId.toHexString())! })),
      );
    } catch {
      // 카드는 덤이다
    }
  }

  /** 방의 다른 멤버에게 「○○님이 「방」에 노트 n개를 공유했어요」. 실패해도 공유는 성공이다 */
  private async notifyShared(me: Types.ObjectId, roomId: Types.ObjectId, count: number) {
    try {
      const [room, sharer] = await Promise.all([
        this.rooms.findById(roomId, { title: 1, members: 1 }).lean(),
        this.users.findById(me, { nickname: 1 }).lean<{ nickname: string }>(),
      ]);
      if (!room) return;
      await this.notifications.notify({
        userIds: room.members
          .filter((m) => m.status === 'joined' && !m.userId.equals(me))
          .map((m) => m.userId),
        category: 'room',
        type: 'room-shared',
        title: room.title,
        body: `${sharer?.nickname ?? UNKNOWN_NICKNAME}님이 「${room.title}」에 노트 ${count}개를 공유했어요`,
        data: { roomId: roomId.toHexString(), userId: me.toHexString() },
        // 같은 사람이 같은 방에 여러 번 공유하면 알림함 · 기기에서 마지막 것 하나로 바뀐다
        collapseId: `room-share:${roomId.toHexString()}:${me.toHexString()}`,
      });
    } catch {
      // 알림은 덤이다
    }
  }
}
