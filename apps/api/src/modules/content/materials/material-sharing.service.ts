import {
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES, type RoomSharedItem as AppRoomSharedItem } from '@notelink/shared';
import { isValidObjectId, Model, Types } from 'mongoose';

import { User } from '../../auth/schemas/user.schema.js';
import { NotificationService } from '../../notification/notification.service.js';
import {
  type AppQuizSet,
  type QuizSetRow,
  toAppSet,
} from '../../../quiz-sets/quiz-sets.service.js';
import { type AppFlashcard, toAppFlashcard } from '../../quiz/flashcards.service.js';
import { Flashcard } from '../../quiz/schemas/flashcard.schema.js';
import { QuizSet } from '../../quiz/schemas/quiz-set.schema.js';
import { RoomSharedItem } from '../../studyroom/schemas/room-shared-item.schema.js';
import { StudyRoom } from '../../studyroom/schemas/study-room.schema.js';
import { StudyChatGateway } from '../../studyroom/study-chat.gateway.js';
import { Material } from '../schemas/material.schema.js';
import type { ShareMaterialsDto } from './dto/share-materials.dto.js';
import { FriendShareService } from './friend-share.service.js';
import type { ShareStudyItemDto } from './dto/share-study-item.dto.js';

const DUPLICATE_KEY = 11000;
/** 공유 자료 목록에 한 번에 담는 항목 수(최근 것부터) */
export const SHARED_ITEMS_MAX = 100;
/** 탈퇴 등으로 닉네임을 찾을 수 없을 때(스터디룸 멤버 목록과 같은 문구) */
const UNKNOWN_NICKNAME = '알 수 없는 사용자';

/** 카드 묶음의 제목(채팅 카드 · 공유 자료 목록) */
const cardsTitle = (count: number) => `플래시카드 ${count}장`;

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
    // 방에 공유한 퀴즈 · 플래시카드(#481): 주인 확인 · 제목 · 받은 멤버가 여는 내용을 읽기만 한다
    @InjectModel(QuizSet.name) private readonly quizSets: Model<QuizSet>,
    @InjectModel(Flashcard.name) private readonly flashcards: Model<Flashcard>,
    private readonly notifications: NotificationService,
    // 공유한 노트를 방 채팅에 자료 카드로 올린다. 없으면(시험) 카드 없이 공유만 한다
    @Optional() private readonly roomChat?: StudyChatGateway,
    // 친구에게 보내기(#554). 없으면(옛 시험) 친구 공유는 없는 것과 같다
    @Optional() private readonly friendShares?: FriendShareService,
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
    const member =
      sharedIn.length > 0 &&
      (await this.rooms.exists({
        _id: { $in: sharedIn.map((item) => item.roomId) },
        closedAt: null,
        members: { $elemMatch: { userId: me, status: 'joined' } },
      }));
    // 방이 아니면 친구가 나에게 보낸 살아 있는 공유인지(#554)
    if (!member && !(await this.friendShares?.isSharedWith(userId, noteId, note.ownerId)))
      return null;
    // 주인이 탈퇴했거나(탈퇴 유예 포함) 계정이 없으면 공유도 없는 것과 같다(FR-03-08). 캘린더 공유와 같은 조건
    const ownerActive = await this.users.exists({
      _id: note.ownerId,
      deletedAt: null,
      withdrawingAt: null,
    });
    return ownerActive ? note.ownerId.toHexString() : null;
  }

  /**
   * 방에 공유된 자료(최근 것부터 SHARED_ITEMS_MAX 개): 노트 · 퀴즈 · 플래시카드 묶음. 현재 멤버만 볼 수 있고, 방이 없거나
   * 멤버가 아니면(나감 · 강퇴 · 초대만 받음 · 잘못된 id 포함) 404. 지운 공유 · 원본이 없어진 것(지운 노트 · 지운 퀴즈 ·
   * 카드를 다 지운 묶음) · 탈퇴(탈퇴 유예 포함)한 사람이 공유한 것은 뺀다(뺀 뒤에 개수를 자른다).
   * 제목은 노트 · 퀴즈의 현재 제목, 카드 묶음은 「플래시카드 N장」(남은 카드 수), 닉네임은 공유한 사람의 지금 닉네임이다.
   * flashcards 는 옛 앱 호환용으로 늘 빈 배열이다(카드 내용은 openRoomItem 으로 연다)
   */
  async listRoomItems(
    userId: string,
    roomId: string,
  ): Promise<{ items: AppRoomSharedItem[]; flashcards: never[] }> {
    if (!(await this.isCurrentMember(new Types.ObjectId(userId), roomId)))
      throw notFound('스터디룸');
    return { items: await this.visibleRoomItems(roomId, {}, SHARED_ITEMS_MAX), flashcards: [] };
  }

  /**
   * 방의 공유 항목 중 지금 보이는 것(지운 공유 · 원본이 없어진 것 · 탈퇴한 사람이 공유한 것은 뺀다)을 최근 것부터.
   * 목록(listRoomItems)과 단건 열기(openRoomItem)가 같은 판단을 쓴다. extra 로 항목을 좁히고, limit 은 뺀 뒤에 자른다
   */
  private async visibleRoomItems(
    roomId: string,
    extra: Record<string, unknown>,
    limit?: number,
  ): Promise<AppRoomSharedItem[]> {
    const live = (from: string, local: string, as: string) => ({
      $lookup: {
        from,
        let: { ids: { $cond: [{ $isArray: `$${local}` }, `$${local}`, [`$${local}`]] } },
        pipeline: [
          { $match: { $expr: { $in: ['$_id', '$$ids'] }, deletedAt: null } },
          { $project: { title: 1 } },
        ],
        as,
      },
    });
    const rows = await this.shared.aggregate<{
      _id: Types.ObjectId;
      roomId: Types.ObjectId;
      sharedBy: Types.ObjectId;
      itemType: 'material' | 'quiz' | 'flashcards';
      materialId?: Types.ObjectId;
      quizSetId?: Types.ObjectId;
      folderId?: Types.ObjectId;
      flashcardIds: Types.ObjectId[];
      createdAt: Date;
      note: { title: string }[];
      quiz: { title: string }[];
      cards: { _id: Types.ObjectId }[];
    }>([
      { $match: { roomId: new Types.ObjectId(roomId), deletedAt: null, ...extra } },
      { $sort: { createdAt: -1, _id: -1 } },
      live(this.materials.collection.name, 'materialId', 'note'),
      live(this.quizSets.collection.name, 'quizSetId', 'quiz'),
      live(this.flashcards.collection.name, 'flashcardIds', 'cards'),
      {
        $match: {
          $or: [
            { itemType: 'material', 'note.0': { $exists: true } },
            { itemType: 'quiz', 'quiz.0': { $exists: true } },
            { itemType: 'flashcards', 'cards.0': { $exists: true } },
          ],
        },
      },
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
      ...(limit ? [{ $limit: limit }] : []),
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
    return rows.map((r) => ({
      _id: r._id.toHexString(),
      roomId: r.roomId.toHexString(),
      sharedBy: r.sharedBy.toHexString(),
      sharedByNickname: nicknames.get(r.sharedBy.toHexString()) ?? UNKNOWN_NICKNAME,
      itemType: r.itemType,
      quizSetId: r.itemType === 'quiz' ? r.quizSetId!.toHexString() : null,
      folderId: r.folderId ? r.folderId.toHexString() : null,
      materialId: r.itemType === 'material' ? r.materialId!.toHexString() : null,
      questionIds: [],
      // 지운 카드는 빼고 고른 순서대로
      flashcardIds: r.flashcardIds
        .filter((id) => r.cards.some((c) => c._id.equals(id)))
        .map((id) => id.toHexString()),
      title:
        r.itemType === 'material'
          ? r.note[0]!.title
          : r.itemType === 'quiz'
            ? r.quiz[0]!.title
            : cardsTitle(r.cards.length),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /**
   * 방 멤버가 공유된 퀴즈(문제 · 정답 포함) · 플래시카드 묶음을 연다. 공유 자료 목록에 보이는 것만 열 수 있다:
   * 멤버가 아니거나 · 공유를 지웠거나 · 원본이 없어졌거나 · 공유자가 탈퇴했으면 404. 받은 사람의 풀이는 저장하지 않는다(앱이 기기에서 채점)
   */
  async openRoomItem(
    userId: string,
    roomId: string,
    itemId: string,
  ): Promise<{ item: AppRoomSharedItem; quiz: AppQuizSet | null; flashcards: AppFlashcard[] }> {
    if (!(await this.isCurrentMember(new Types.ObjectId(userId), roomId)))
      throw notFound('스터디룸');
    // 목록의 개수 한도와 상관없이 공유 항목 id 로 바로 찾는다(잘못된 id 는 404)
    const [item] = isValidObjectId(itemId)
      ? await this.visibleRoomItems(roomId, {
          _id: new Types.ObjectId(itemId),
          itemType: { $ne: 'material' },
        })
      : [];
    if (!item) throw notFound('공유 자료');
    if (item.itemType === 'quiz') {
      const row = await this.quizSets
        .findOne({ _id: new Types.ObjectId(item.quizSetId!), deletedAt: null })
        .lean<QuizSetRow>();
      if (!row) throw notFound('공유 자료');
      return { item, quiz: toAppSet(row), flashcards: [] };
    }
    const ids = item.flashcardIds.map((id) => new Types.ObjectId(id));
    const rows = await this.flashcards
      .find({ _id: { $in: ids }, deletedAt: null })
      .lean<Parameters<typeof toAppFlashcard>[0][]>();
    const byId = new Map(rows.map((c) => [c._id.toHexString(), c]));
    const cards = item.flashcardIds.flatMap((id) =>
      byId.has(id) ? [toAppFlashcard(byId.get(id)!)] : [],
    );
    if (!cards.length) throw notFound('공유 자료');
    return { item, quiz: null, flashcards: cards };
  }

  /**
   * 내 퀴즈(준비된 것) 하나 또는 고른 플래시카드들(한 묶음)을 방에 공유하고 방 채팅에 자료 카드를 올린다(#481).
   * 내 것이 아니거나 지웠거나 만드는 중인 퀴즈 · 남의 카드가 섞이면 404, 방 멤버가 아니면 404 이고 아무것도 저장하지 않는다.
   * 같은 퀴즈는 방에 한 번만(room_quiz_unique, 다시 보내면 카드만 채운다). 카드 묶음은 보낼 때마다 새로 남긴다
   */
  async shareStudyItem(userId: string, roomId: string, dto: ShareStudyItemDto): Promise<void> {
    const me = new Types.ObjectId(userId);
    let filter: Record<string, unknown>;
    let insert: Record<string, unknown>;
    let title: string;
    let what: string;
    if (dto.kind === 'quiz') {
      const set = isValidObjectId(dto.quizSetId)
        ? await this.quizSets
            .findOne(
              {
                _id: new Types.ObjectId(dto.quizSetId),
                ownerId: me,
                deletedAt: null,
                status: 'ready',
              },
              { title: 1, folderId: 1 },
            )
            .lean<{ _id: Types.ObjectId; title: string; folderId?: Types.ObjectId }>()
        : null;
      if (!set) throw notFound('퀴즈');
      filter = { itemType: 'quiz', quizSetId: set._id, deletedAt: null };
      insert = { folderId: set.folderId };
      title = set.title;
      what = `퀴즈 「${set.title}」를`;
    } else {
      const ids = [...new Set((dto.flashcardIds ?? []).map((id) => id.toLowerCase()))].map(
        (id) => new Types.ObjectId(id),
      );
      const found = await this.flashcards
        .find({ _id: { $in: ids }, ownerId: me, deletedAt: null }, { folderId: 1 })
        .lean<{ _id: Types.ObjectId; folderId?: Types.ObjectId | null }[]>();
      if (!ids.length || found.length !== ids.length) throw notFound('플래시카드');
      const folders = new Set(found.map((c) => String(c.folderId ?? '')));
      // 묶음마다 새로 남기려고 새 _id 로 찾는다(늘 새로 넣음)
      filter = { _id: new Types.ObjectId(), itemType: 'flashcards', deletedAt: null };
      insert = {
        flashcardIds: ids,
        folderId: folders.size === 1 ? (found[0]!.folderId ?? undefined) : undefined,
      };
      title = cardsTitle(ids.length);
      what = `플래시카드 ${ids.length}장을`;
    }
    if (!(await this.isCurrentMember(me, roomId))) throw notFound('스터디룸');
    const room = new Types.ObjectId(roomId);
    let added = false;
    try {
      const r = await this.shared.updateOne(
        { roomId: room, ...filter },
        { $setOnInsert: { sharedBy: me, questionIds: [], flashcardIds: [], ...insert } },
        { upsert: true },
      );
      added = r.upsertedCount > 0;
    } catch (e) {
      // 같은 퀴즈를 동시에 공유한 다른 요청이 먼저 넣었다 — 이미 공유된 것과 같다
      if (!onlyDuplicateKeys(e)) throw e;
    }
    if (added) void this.notifyShared(me, room, what);
    if (!this.roomChat) return;
    try {
      const row = await this.shared.findOne({ roomId: room, ...filter }, { _id: 1 }).lean();
      if (row)
        await this.roomChat.postSharedNotes(roomId, userId, [
          { sharedItemId: row._id, title, kind: dto.kind },
        ]);
    } catch {
      // 카드는 덤이다
    }
  }

  /**
   * 내 노트를 방에 공유한다(친구 대상은 FriendShareService.share). 노트가 하나라도 내 것이 아니거나 지웠으면, 방이 없거나 내가 현재 멤버가 아니면 404 이고
   * 아무것도 저장하지 않는다(확인을 모두 마친 뒤에만 쓴다). 이미 공유된 노트는 건너뛴다.
   * 트랜잭션 없이 노트마다 upsert 라, 쓰는 도중 실패해도 같은 요청을 다시 보내면 빠진 것만 채워진다.
   * 동시에 같은 요청이 와도 부분 unique 인덱스(room_material_unique)가 하나만 남긴다
   */
  async share(userId: string, dto: ShareMaterialsDto): Promise<void> {
    if (dto.target.type === 'friend') {
      if (!this.friendShares)
        throw new ServiceUnavailableException({
          code: ERROR_CODES.VALIDATION,
          message: '지금은 친구에게 보낼 수 없어요',
        });
      return this.friendShares.share(userId, dto.materialIds, dto.target.ids ?? []);
    }
    const roomTarget = dto.target.id ?? '';
    const me = new Types.ObjectId(userId);
    const ids = [...new Set(dto.materialIds.map((id) => id.toLowerCase()))].map(
      (id) => new Types.ObjectId(id),
    );
    const notes = await this.materials
      .find({ _id: { $in: ids }, ownerId: me, deletedAt: null }, { folderId: 1, title: 1 })
      .lean<{ _id: Types.ObjectId; folderId: Types.ObjectId; title: string }[]>();
    if (notes.length !== ids.length) throw notFound('노트');
    if (!(await this.isCurrentMember(me, roomTarget))) throw notFound('스터디룸');
    const roomId = new Types.ObjectId(roomTarget);
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
    if (added > 0) void this.notifyShared(me, roomId, `노트 ${added}개를`);
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

  /** 방의 다른 멤버에게 「○○님이 「방」에 노트 n개(퀴즈 「제목」 · 플래시카드 n장)를 공유했어요」. 실패해도 공유는 성공이다 */
  private async notifyShared(me: Types.ObjectId, roomId: Types.ObjectId, what: string) {
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
        body: `${sharer?.nickname ?? UNKNOWN_NICKNAME}님이 「${room.title}」에 ${what} 공유했어요`,
        data: { roomId: roomId.toHexString(), userId: me.toHexString() },
        // 같은 사람이 같은 방에 여러 번 공유하면 알림함 · 기기에서 마지막 것 하나로 바뀐다
        collapseId: `room-share:${roomId.toHexString()}:${me.toHexString()}`,
      });
    } catch {
      // 알림은 덤이다
    }
  }
}
