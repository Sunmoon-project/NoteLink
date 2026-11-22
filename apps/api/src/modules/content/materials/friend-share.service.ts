import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES, type FriendShare } from '@notelink/shared';
import { isValidObjectId, Types, type Model } from 'mongoose';

import { User } from '../../auth/schemas/user.schema.js';
import { AiJob } from '../../quiz/schemas/ai-job.schema.js';
import { FriendSharedItem } from '../../social/schemas/friend-shared-item.schema.js';
import { Friendship } from '../../social/schemas/friendship.schema.js';
import { StudyChatGateway } from '../../studyroom/study-chat.gateway.js';
import { BlobStorageService, uploadFolder } from '../../upload/blob-storage.service.js';
import { Folder } from '../schemas/folder.schema.js';
import { Material } from '../schemas/material.schema.js';
import type { MaterialRow } from './material-view.js';
import { MaterialsService, UPLOAD_KIND } from './materials.service.js';
import { UploadQuotaService } from '../../upload/upload-quota.service.js';

const UNKNOWN_NICKNAME = '알 수 없는 사용자';

const notFound = (what: string) =>
  new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: `${what} 정보를 찾을 수 없어요` });

type ShareRow = {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  friendId: Types.ObjectId;
  materialId: Types.ObjectId;
  friendshipId: Types.ObjectId;
  revokedAt?: Date | null;
  createdAt: Date;
};

/**
 * 친구에게 노트 보내기(#554, FR-26). 저장은 friend_shared_items(노트 · 친구마다 한 줄), 도착은 1:1 채팅 공유 카드 + 친구 알림.
 * 받은 사람은 원본을 읽기만 하고(MaterialSharingService.ownerOfShared 가 ownerOf 로 묻는다) 「내 노트로 복사」로 사본을 만든다.
 * 공유가 살아 있다 = 철회 안 함 · 만든 친구 관계가 아직 수락 상태 · 노트가 있음 · 보낸 사람이 탈퇴(유예 포함)하지 않음
 */
@Injectable()
export class FriendShareService {
  private readonly logger = new Logger(FriendShareService.name);

  constructor(
    @InjectModel(Material.name) private readonly materials: Model<Material>,
    @InjectModel(Folder.name) private readonly folders: Model<Folder>,
    @InjectModel(AiJob.name) private readonly jobs: Model<AiJob>,
    @InjectModel(User.name) private readonly users: Model<User>,
    @InjectModel(Friendship.name) private readonly friendships: Model<Friendship>,
    @InjectModel(FriendSharedItem.name) private readonly shares: Model<FriendSharedItem>,
    // 복사 전에 끝난 정리 결과를 노트에 옮긴다(주인이 아직 노트를 안 열었어도 복사되게)
    private readonly notes: MaterialsService,
    // 파일 사본 하나 = 올리기 한 번(같은 한도). 받은 사람이 복사를 되풀이해 저장소를 채우지 못하게
    private readonly quota: UploadQuotaService,
    // 사본의 파일 복사. 없으면(저장소 미설정) 파일이 있는 노트는 복사하지 못한다(503)
    @Optional() private readonly blobs?: BlobStorageService,
    // 1:1 채팅 공유 카드. 없으면(시험) 카드 없이 공유만 한다
    @Optional() private readonly chat?: StudyChatGateway,
  ) {}

  /**
   * 내 노트들을 친구들에게 보낸다. 노트가 하나라도 내 것이 아니거나 지웠으면 404, 친구가 아닌 사람이 섞이면 400 NOT_FRIEND 이고
   * 아무것도 저장하지 않는다(시간표 공유와 같다). 이미 보낸(살아 있는) 노트는 그대로 두고 카드도 다시 만들지 않는다.
   * 확인과 쓰기 사이에 친구를 끊으면 그 관계로 쓴 줄이 남을 수 있지만, 읽기가 관계를 다시 보므로 열리지 않는다
   */
  async share(userId: string, materialIds: string[], friendIds: string[]): Promise<void> {
    const me = new Types.ObjectId(userId);
    const ids = [...new Set(materialIds.map((id) => id.toLowerCase()))].map(
      (id) => new Types.ObjectId(id),
    );
    const notes = await this.materials
      .find({ _id: { $in: ids }, ownerId: me, deletedAt: null }, { title: 1 })
      .lean<{ _id: Types.ObjectId; title: string }[]>();
    if (notes.length !== ids.length) throw notFound('노트');
    // 나도 친구가 아니다(섞이면 전부 거절)
    const requested = [...new Set(friendIds.map((id) => id.toLowerCase()))];
    const links = await this.friendLinks(me, requested);
    if (!requested.length || links.size !== requested.length)
      throw new BadRequestException({
        code: 'NOT_FRIEND',
        message: '친구가 아닌 사용자에게는 노트를 보낼 수 없어요',
      });
    const rows = requested.flatMap((friend) =>
      notes.map((note) => ({
        ownerId: me,
        friendId: new Types.ObjectId(friend),
        materialId: note._id,
        friendshipId: links.get(friend)!,
        revokedAt: null,
      })),
    );
    try {
      await this.shares.bulkWrite(
        rows.map((row) => ({
          updateOne: { filter: row, update: { $setOnInsert: row }, upsert: true },
        })),
        { ordered: false },
      );
    } catch (e) {
      // 같은 공유를 동시에 보낸 다른 요청이 먼저 넣었다 — 그 줄은 이미 있다
      const errors = (e as { writeErrors?: { code?: unknown }[] } | null)?.writeErrors;
      if (!Array.isArray(errors) || !errors.every((w) => w.code === 11000)) throw e;
    }
    if (!this.chat) return;
    const chat = this.chat;
    const titles = new Map(notes.map((n) => [n._id.toHexString(), n.title]));
    // 친구마다 따로(채팅이 다르다). 한 채팅 안에서는 노트 순서대로
    const post = async (friend: string) => {
      try {
        const saved = await this.shares
          .find(
            {
              ownerId: me,
              friendId: new Types.ObjectId(friend),
              friendshipId: links.get(friend),
              materialId: { $in: ids },
              revokedAt: null,
            },
            { materialId: 1 },
          )
          .sort({ _id: 1 })
          .lean<{ _id: Types.ObjectId; materialId: Types.ObjectId }[]>();
        await chat.postFriendShares(
          userId,
          friend,
          saved.map((s) => ({ shareId: s._id, title: titles.get(s.materialId.toHexString())! })),
        );
      } catch (error) {
        // 카드는 덤이다(상대가 탈퇴 중이면 채팅을 열 수 없다). 공유는 이미 저장됐다
        this.logger.warn(`친구 공유 카드를 올리지 못했어요: ${String(error)}`);
      }
    };
    await Promise.all(requested.map(post));
  }

  /** 보낸 사람이 공유를 끝낸다. 내가 보낸 공유가 아니면 404. 이미 끝낸 공유는 그대로(204) */
  async revoke(userId: string, shareId: string, now = new Date()): Promise<void> {
    const row = await this.mineToSend(userId, shareId);
    if (!row.revokedAt)
      await this.shares.updateOne({ _id: row._id, revokedAt: null }, { revokedAt: now });
  }

  /** 공유 카드를 열 때. 보낸 사람 · 받은 사람만(아니면 404). 받은 사람에게 끝난 공유는 active: false */
  async open(userId: string, shareId: string): Promise<FriendShare> {
    const row = await this.row(shareId);
    const me = new Types.ObjectId(userId);
    if (!row || (!row.ownerId.equals(me) && !row.friendId.equals(me))) throw notFound('공유');
    const [note, owner] = await Promise.all([
      this.materials
        .findOne({ _id: row.materialId, deletedAt: null }, { title: 1, kind: 1 })
        .lean<{ title: string; kind: FriendShare['kind'] }>(),
      this.users.findById(row.ownerId, { nickname: 1, deletedAt: 1 }).lean<{
        nickname: string;
        deletedAt?: Date | null;
      }>(),
    ]);
    const mine = row.ownerId.equals(me);
    const active = !!note && (await this.isLive(row));
    // 끝난 공유는 받은 사람에게 노트의 지금 제목 · 종류를 알려 주지 않는다(보낸 사람이 바꿨을 수 있다)
    const shown = active || mine;
    return {
      _id: row._id.toHexString(),
      materialId: row.materialId.toHexString(),
      ownerId: row.ownerId.toHexString(),
      ownerNickname: owner && !owner.deletedAt ? owner.nickname : UNKNOWN_NICKNAME,
      friendId: row.friendId.toHexString(),
      title: shown ? (note?.title ?? '') : '',
      kind: shown ? (note?.kind ?? null) : null,
      active,
      mine,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /**
   * 주인(ownerId)의 이 노트가 나에게 살아 있는 친구 공유로 와 있는지(ownerOfShared 의 친구 쪽).
   * 노트가 있는지 · 주인이 탈퇴했는지는 부르는 쪽(ownerOfShared)이 본다
   */
  async isSharedWith(
    userId: string,
    materialId: Types.ObjectId,
    ownerId: Types.ObjectId,
  ): Promise<boolean> {
    const rows = await this.shares
      .find(
        { materialId, ownerId, friendId: new Types.ObjectId(userId), revokedAt: null },
        { friendshipId: 1 },
      )
      .lean<{ friendshipId: Types.ObjectId }[]>();
    if (!rows.length) return false;
    return !!(await this.friendships.exists({
      _id: { $in: rows.map((r) => r.friendshipId) },
      status: 'accepted',
    }));
  }

  /**
   * 받은 노트를 내 노트로 복사한다. 살아 있는 공유의 받은 사람만(아니면 404), 정리가 끝난(done) 노트만(아니면 409).
   * 노트 문서와 정리 결과(AI 작업 결과)를 내 것으로 새로 만들고, 원본 파일(쪽 사진 · 문서 · 녹음)은 Azure 서버 간 복사로
   * 내 업로드 경로에 사본을 둔다(받은 사람 저장 용량이 원본만큼 는다). 폴더는 고른 내 폴더, 없으면 최근에 쓴 내 폴더.
   * 퀴즈 · 플래시카드 · 북마크 같은 보낸 사람의 학습 기록은 옮기지 않는다. 중간에 실패하면 만든 사본 노트 · 파일 · 작업을 지운다.
   * ponytail: 두 번 누르면 사본이 둘 생긴다(앱이 누르는 동안 버튼을 막는다). 문제가 되면 공유마다 사본 id 를 남겨 돌려준다
   */
  async copy(userId: string, shareId: string, folderId?: string) {
    const me = new Types.ObjectId(userId);
    const row = await this.row(shareId);
    if (!row || !row.friendId.equals(me) || !(await this.isLive(row))) throw notFound('공유');
    const found = await this.materials
      .findOne({ _id: row.materialId, ownerId: row.ownerId, deletedAt: null })
      .lean<MaterialRow>();
    const note = found && (await this.notes.sync(row.ownerId.toHexString(), found));
    if (!note) throw notFound('공유');
    if (note.processing.status !== 'done')
      throw new ConflictException({
        code: ERROR_CODES.NOTE_NOT_READY,
        message: '노트 정리가 끝난 뒤에 복사할 수 있어요',
      });
    const folder = await this.folders
      .findOne(
        {
          ownerId: me,
          deletedAt: null,
          ...(folderId ? { _id: new Types.ObjectId(folderId) } : {}),
        },
        { _id: 1 },
      )
      .sort({ updatedAt: -1 })
      .lean<{ _id: Types.ObjectId }>();
    if (!folder)
      throw folderId
        ? notFound('폴더')
        : new BadRequestException({
            code: ERROR_CODES.VALIDATION,
            message: '노트를 넣을 폴더를 먼저 만들어 주세요',
          });

    // 원본 파일과 쪽 이미지(보통 같은 주소). 사본이 보낸 사람 파일을 가리키지 않게 모두 복사한다
    const sources = [
      ...new Set([...(note.blobUrls ?? []), ...(note.pages ?? []).map((p) => p.imageUrl)]),
    ];
    const copied = new Map<string, string>();
    let jobId: Types.ObjectId | null = null;
    let inserted: Types.ObjectId | null = null;
    try {
      if (sources.length) {
        if (!this.blobs) this.blobsMissing();
        const kind = UPLOAD_KIND[note.kind as keyof typeof UPLOAD_KIND] ?? 'document';
        const from = uploadFolder(kind, row.ownerId.toHexString());
        const prefix = uploadFolder(kind, userId);
        for (const url of sources) {
          const reserved = await this.quota.reserve(userId);
          if (!reserved.ok)
            throw new HttpException(
              {
                code: ERROR_CODES.RATE_LIMITED,
                message: '파일을 너무 많이 복사하고 있어요. 잠시 뒤에 다시 해 주세요',
                retryAfterSeconds: Math.ceil(reserved.retryAfterMs / 1000),
              },
              HttpStatus.TOO_MANY_REQUESTS,
            );
          copied.set(url, await this.blobs!.copyUpload(url, from, prefix));
        }
      }
      const job = note.processing.jobId
        ? await this.jobs.findOne({ _id: note.processing.jobId, userId: row.ownerId }).lean()
        : null;
      const materialId = new Types.ObjectId();
      if (job) {
        jobId = new Types.ObjectId();
        const size = job.input?.['sizeBytes'];
        // 결과만 옮긴다. 입력의 파일 읽기 주소(보낸 사람 SAS)는 넣지 않는다 — 다 끝난 작업이라 다시 읽지 않는다
        await this.jobs.collection.insertOne({
          _id: jobId,
          type: job.type,
          status: job.status,
          userId: me,
          targetType: job.targetType,
          targetId: materialId,
          input: typeof size === 'number' ? { sizeBytes: size } : {},
          result: job.result ?? null,
          progress: job.progress,
          attempts: 0,
          // 사본이라 완료 알림을 보내지 않는다
          notice: { state: 'skipped', attempts: 0, retryAt: null },
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      const now = new Date();
      await this.materials.collection.insertOne({
        _id: materialId,
        ownerId: me,
        folderId: folder._id,
        kind: note.kind,
        source: note.source,
        title: note.title,
        description: note.description ?? null,
        avatarItemId: null,
        processing: { status: 'done', progress: 100, jobId, regenJobId: null },
        summary: note.summary ?? null,
        keywords: note.keywords ?? [],
        concepts: note.concepts ?? [],
        // 북마크는 보낸 사람의 메모라 옮기지 않는다
        bookmarks: [],
        pages: (note.pages ?? []).map((p) => ({
          ...p,
          imageUrl: copied.get(p.imageUrl) ?? p.imageUrl,
        })),
        blobUrls: (note.blobUrls ?? []).map((u) => copied.get(u)!),
        savedAt: now,
        deletedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      inserted = materialId;
      await this.folders.updateOne({ _id: folder._id }, { $set: { updatedAt: now } });
      return { _id: materialId.toHexString(), folderId: folder._id.toHexString() };
    } catch (error) {
      // 반쯤 만든 사본(노트 · 파일 · 작업)을 지운다. 노트를 넣은 뒤 폴더 갱신이 실패해도 노트까지 지운다
      if (inserted)
        await this.materials.collection.deleteOne({ _id: inserted }).catch(() => undefined);
      if (jobId) await this.jobs.deleteOne({ _id: jobId }).catch(() => undefined);
      if (this.blobs) await Promise.all([...copied.values()].map((u) => this.blobs!.deleteCopy(u)));
      throw error;
    }
  }

  private blobsMissing(): never {
    throw new ServiceUnavailableException({
      code: ERROR_CODES.UPLOAD_UNAVAILABLE,
      message: '지금은 파일을 복사할 수 없어요',
    });
  }

  private async row(shareId: string): Promise<ShareRow | null> {
    if (!isValidObjectId(shareId)) return null;
    return this.shares.findById(shareId).lean<ShareRow>();
  }

  private async mineToSend(userId: string, shareId: string): Promise<ShareRow> {
    const row = await this.row(shareId);
    if (!row || !row.ownerId.equals(userId)) throw notFound('공유');
    return row;
  }

  /** 철회 안 함 · 그 친구 관계가 아직 수락 상태 · 보낸 사람이 탈퇴(유예 포함)하지 않음 */
  private async isLive(row: ShareRow): Promise<boolean> {
    if (row.revokedAt) return false;
    const [link, owner] = await Promise.all([
      this.friendships.exists({ _id: row.friendshipId, status: 'accepted' }),
      this.users.exists({ _id: row.ownerId, deletedAt: null, withdrawingAt: null }),
    ]);
    return !!link && !!owner;
  }

  /** 주어진 사용자 중 나와 수락된 친구인 사람 → 그 친구 관계 id (시간표 공유와 같다) */
  private async friendLinks(me: Types.ObjectId, ids: string[]) {
    const others = ids.map((id) => new Types.ObjectId(id));
    const docs = await this.friendships
      .find({
        status: 'accepted',
        $or: [
          { userA: me, userB: { $in: others } },
          { userB: me, userA: { $in: others } },
        ],
      })
      .lean<{ _id: Types.ObjectId; userA: Types.ObjectId; userB: Types.ObjectId }[]>();
    return new Map(
      docs.map((d) => [(d.userA.equals(me) ? d.userB : d.userA).toHexString(), d._id]),
    );
  }
}
