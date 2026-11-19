import { createHash } from 'node:crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, mongo, Types } from 'mongoose';

import { Material, type MaterialDocument } from '../content/schemas/material.schema.js';
import { FLASHCARD_BACK_MAX, FLASHCARD_FRONT_MAX } from './dto/flashcard.dto.js';
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

/**
 * 맞춤 퀴즈 결과로 한 세트에 저장하는 개념 카드 수의 상한(#558). 처리기는 5장을 만든다
 * (apps/ai services/quiz/flashcards.py COUNT). 결과가 이상해도 카드가 쏟아지지 않게 넉넉히 막는다
 */
export const AUTO_CARD_MAX = 10;
const DUPLICATE_KEY = 11000;

/** 자동 카드가 저장할 세트(quiz_sets 한 줄 중 쓰는 필드) */
export interface CardSet {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  materialId?: Types.ObjectId | null;
  folderId?: Types.ObjectId | null;
}

/**
 * 세트의 index번째 자동 카드 id(#558). 세트 id와 순번에서 늘 같은 값이 나와, 같은 결과를 여러 번(동시에) 옮겨도
 * 카드가 한 번만 생기고, 지운 카드(deletedAt)는 문서가 남아 다시 생기지 않는다(upsert $setOnInsert).
 * 앞 4바이트는 세트의 만든 때, 다음 5바이트는 세트 id의 해시(같은 초 · 같은 프로세스의 세트도 갈라짐),
 * 끝 3바이트는 순번이라 한 세트의 카드는 순번 차례로 정렬된다(목록은 createdAt, _id 차례)
 */
export function autoCardId(setId: Types.ObjectId, index: number): Types.ObjectId {
  const hex = setId.toHexString();
  const digest = createHash('sha256').update(`flashcard-of:${hex}`).digest('hex');
  return new Types.ObjectId(hex.slice(0, 8) + digest.slice(0, 10) + index.toString(16).padStart(6, '0'));
}

/** 처리기 result.flashcards 한 장 → 저장할 앞 · 뒤(앞뒤 공백 지움). 모양이 틀리면 null */
function autoCard(raw: unknown): { front: string; back: string } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const { front, back } = raw as Record<string, unknown>;
  if (typeof front !== 'string' || typeof back !== 'string') return null;
  const card = { front: front.trim(), back: back.trim() };
  if (!card.front || !card.back) return null;
  if (card.front.length > FLASHCARD_FRONT_MAX || card.back.length > FLASHCARD_BACK_MAX) return null;
  return card;
}

/** 앞면이 같은 카드인지 비교하는 값: 공백 · 대소문자는 보지 않는다 */
const frontKey = (front: string): string => front.replace(/\s+/g, '').toLowerCase();

/** 모든 쓰기 오류가 중복 키(같은 id를 다른 요청이 먼저 넣음)인지 */
function onlyDuplicates(e: unknown): boolean {
  if (!(e instanceof mongo.MongoBulkWriteError)) return false;
  const errors = Array.isArray(e.writeErrors) ? e.writeErrors : [e.writeErrors];
  return errors.length > 0 && errors.every((w) => w?.code === DUPLICATE_KEY);
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

  /**
   * 맞춤 퀴즈 결과의 개념 카드(처리기 result.flashcards, #558)를 그 세트 주인의 카드로 저장한다.
   * 세트를 ready로 옮길 때(quiz-sets.service.ts settle) 부른다. 출처는 세트 · 노트 · 폴더이고 문제는 없다
   * (sourceQuestionId null: 퀴즈 문제가 아니라 같은 범위의 따로 만든 카드).
   * id는 세트와 처리기 순번에서 정해(autoCardId) 없을 때만 넣는다: 여러 번 · 동시에 옮겨도 한 번만, 지운 카드는
   * 되살리지 않는다. 모양이 틀린 카드는 빼고(순번은 처리기 차례 그대로), AUTO_CARD_MAX장까지만.
   * 그 사이 지운 세트에는 쓰지 않는다. 동시에 넣다 생긴 중복 키 말고 쓰기 오류는 올린다(settle이 로그만 남김)
   */
  async saveFromQuizSet(set: CardSet, raw: unknown): Promise<void> {
    if (!Array.isArray(raw)) return;
    const cards = raw
      .slice(0, AUTO_CARD_MAX)
      .map((item, index) => ({ index, card: autoCard(item) }))
      .filter((c): c is { index: number; card: { front: string; back: string } } => c.card !== null);
    if (cards.length === 0) return;
    // 그 사이 사용자가 세트나 노트를 지웠으면 쓰지 않는다(지운 퀴즈 · 노트의 카드가 목록에 새로 생기지 않게,
    // /code-review). 노트 · 폴더 지우기는 세트를 건드리지 않아 세트만 보면 놓친다.
    // 확인과 쓰기 사이에 지우는 경우는 남는다(드묾: 지운 뒤 그 카드도 지울 수 있음)
    const alive = await this.sets.exists({ _id: set._id, ownerId: set.ownerId, deletedAt: null });
    if (!alive) return;
    const materialId = set.materialId ?? null;
    let materialFolder: Types.ObjectId | null = null;
    if (materialId) {
      const material = await this.materials
        .findOne({ _id: materialId, ownerId: set.ownerId, deletedAt: null })
        .select({ folderId: 1 })
        .lean<{ folderId?: Types.ObjectId | null } | null>();
      if (!material) return;
      materialFolder = material.folderId ?? null;
    }
    // 같은 노트로 퀴즈를 여러 번 만들면 같은 개념 카드가 세트마다 쌓인다: 그 노트의 카드(지운 카드 포함 —
    // 지운 카드를 다시 만들지 않게)와 앞면이 같으면 뺀다(/code-review). 같은 세트를 다시 옮길 때는 id로 막는다
    const known = new Set(
      materialId
        ? (
            await this.cards
              .find({ ownerId: set.ownerId, materialId, _id: { $nin: cards.map((c) => autoCardId(set._id, c.index)) } })
              .select({ front: 1 })
              .lean<{ front: string }[]>()
          ).map((c) => frontKey(c.front))
        : [],
    );
    const fresh = cards.filter((c) => !known.has(frontKey(c.card.front)));
    if (fresh.length === 0) return;
    const now = new Date();
    const folderId = set.folderId ?? materialFolder;
    const ops = fresh.map(({ index, card }) => ({
      updateOne: {
        filter: { _id: autoCardId(set._id, index) },
        update: {
          $setOnInsert: {
            ownerId: set.ownerId,
            ...card,
            materialId,
            folderId,
            sourceQuizSetId: set._id,
            sourceQuestionId: null,
            lastResult: null,
            deletedAt: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    }));
    try {
      // timestamps: false — 이미 있는 카드(지운 카드 포함)의 updatedAt을 다시 옮길 때마다 바꾸지 않는다
      await this.cards.bulkWrite(ops, { ordered: false, timestamps: false });
    } catch (e) {
      if (!onlyDuplicates(e)) throw e;
    }
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
