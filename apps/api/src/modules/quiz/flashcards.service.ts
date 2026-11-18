import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { Material, type MaterialDocument } from '../content/schemas/material.schema.js';
import { Flashcard, type FlashcardDocument } from './schemas/flashcard.schema.js';
import { QuizSet, type QuizSetDocument } from './schemas/quiz-set.schema.js';

/** 문제가 없거나 남의 세트의 것일 때 (packages/shared ERROR_CODES.NOT_FOUND) */
const NOT_FOUND = 'NOT_FOUND';
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** 앱에 보내는 플래시카드 한 장 (packages/shared Flashcard). id 필드 이름은 공용 계약대로 _id */
export interface AppFlashcard {
  _id: string;
  materialId: string | null;
  folderId: string | null;
  front: string;
  back: string;
  sourceQuizSetId: string | null;
  sourceQuestionId: string | null;
  lastResult: string | null;
  createdAt: string;
}

interface FlashcardRow {
  _id: Types.ObjectId;
  materialId?: Types.ObjectId | null;
  folderId?: Types.ObjectId | null;
  front: string;
  back: string;
  sourceQuizSetId?: Types.ObjectId | null;
  sourceQuestionId?: Types.ObjectId | null;
  lastResult?: string | null;
  createdAt: Date;
}

interface SetRow {
  _id: Types.ObjectId;
  materialId?: Types.ObjectId | null;
  folderId?: Types.ObjectId | null;
}

const idOrNull = (id: Types.ObjectId | null | undefined): string | null => (id ? id.toString() : null);

function toApp(row: FlashcardRow): AppFlashcard {
  return {
    _id: row._id.toString(),
    materialId: idOrNull(row.materialId),
    folderId: idOrNull(row.folderId),
    front: row.front,
    back: row.back,
    sourceQuizSetId: idOrNull(row.sourceQuizSetId),
    sourceQuestionId: idOrNull(row.sourceQuestionId),
    lastResult: row.lastResult ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class FlashcardsService {
  constructor(
    @InjectModel(Flashcard.name) private readonly cards: Model<FlashcardDocument>,
    @InjectModel(QuizSet.name) private readonly sets: Model<QuizSetDocument>, // 내 세트의 문제인지 읽기만 한다
    @InjectModel(Material.name) private readonly materials: Model<MaterialDocument>, // 폴더를 알아내려고 읽기만 한다
  ) {}

  /** 내 플래시카드. 지운 카드는 빼고, 앱처럼 저장한 순서(오래된 것부터)로 준다 */
  async list(userId: string): Promise<AppFlashcard[]> {
    const rows = await this.cards
      .find({ ownerId: new Types.ObjectId(userId), deletedAt: null })
      .sort({ createdAt: 1, _id: 1 })
      .lean<FlashcardRow[]>();
    return rows.map(toApp);
  }

  /**
   * 카드를 저장한다. 같은 문제로 여러 번 저장해도 막지 않는다(앱도 막지 않는다).
   * sourceQuestionId가 있으면 그 문제가 내 퀴즈 세트에 있어야 하고(아니면 404), 세트 · 자료 · 폴더를 채운다.
   * 없으면 세트 · 자료 · 폴더를 모두 null로 둔다.
   */
  async save(
    userId: string,
    input: { front: string; back: string; sourceQuestionId?: string | null },
  ): Promise<AppFlashcard> {
    const ownerId = new Types.ObjectId(userId);
    let source: {
      sourceQuestionId: Types.ObjectId;
      sourceQuizSetId: Types.ObjectId;
      materialId: Types.ObjectId | null;
      folderId: Types.ObjectId | null;
    } | null = null;

    if (input.sourceQuestionId) {
      const questionId = new Types.ObjectId(input.sourceQuestionId);
      const set = await this.sets
        .findOne({ ownerId, deletedAt: null, 'questions._id': questionId })
        .lean<SetRow | null>();
      if (!set) throw new NotFoundException({ code: NOT_FOUND, message: '문제를 찾을 수 없어요' });
      const materialId = set.materialId ?? null;
      source = {
        sourceQuestionId: questionId,
        sourceQuizSetId: set._id,
        materialId,
        folderId: set.folderId ?? (await this.folderOfMaterial(ownerId, materialId)),
      };
    }

    const created = await this.cards.create({
      ownerId,
      front: input.front,
      back: input.back,
      materialId: source?.materialId ?? null,
      folderId: source?.folderId ?? null,
      sourceQuizSetId: source?.sourceQuizSetId ?? null,
      sourceQuestionId: source?.sourceQuestionId ?? null,
      lastResult: null,
      deletedAt: null,
    });
    return toApp(created.toObject() as unknown as FlashcardRow);
  }

  /** 내 카드만 지운다(deletedAt). 없거나 남의 카드 id, 형식이 틀린 id는 조용히 넘어간다 */
  async remove(userId: string, ids: string[]): Promise<void> {
    const valid = [...new Set(ids.filter((id) => OBJECT_ID.test(id)))].map((id) => new Types.ObjectId(id));
    if (valid.length === 0) return;
    await this.cards.updateMany(
      { _id: { $in: valid }, ownerId: new Types.ObjectId(userId), deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
  }

  /** 세트에 폴더가 없으면 세트의 자료가 있는 폴더를 쓴다. 자료를 못 찾으면 null */
  private async folderOfMaterial(
    ownerId: Types.ObjectId,
    materialId: Types.ObjectId | null,
  ): Promise<Types.ObjectId | null> {
    if (!materialId) return null;
    const material = await this.materials
      .findOne({ _id: materialId, ownerId })
      .select({ folderId: 1 })
      .lean<{ folderId?: Types.ObjectId | null } | null>();
    return material?.folderId ?? null;
  }
}
