import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES } from '@notelink/shared';
import { Model, Types } from 'mongoose';

import { RoomSharedItem } from '../../studyroom/schemas/room-shared-item.schema.js';
import { StudyRoom } from '../../studyroom/schemas/study-room.schema.js';
import { Material } from '../schemas/material.schema.js';
import type { ShareMaterialsDto } from './dto/share-materials.dto.js';

const DUPLICATE_KEY = 11000;

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
  ) {}

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
      .find({ _id: { $in: ids }, ownerId: me, deletedAt: null }, { folderId: 1 })
      .lean<{ _id: Types.ObjectId; folderId: Types.ObjectId }[]>();
    if (notes.length !== ids.length) throw notFound('노트');
    const roomId = new Types.ObjectId(dto.target.id);
    const room = await this.rooms.exists({
      _id: roomId,
      closedAt: null,
      members: { $elemMatch: { userId: me, status: 'joined' } },
    });
    if (!room) throw notFound('스터디룸');
    try {
      await this.shared.bulkWrite(
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
    } catch (e) {
      // 같은 노트를 동시에 공유한 다른 요청이 먼저 넣었다 — 이미 공유된 것과 같다
      if (!onlyDuplicateKeys(e)) throw e;
    }
  }
}
