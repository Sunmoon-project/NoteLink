import { createHash } from 'node:crypto';

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, mongo, Types } from 'mongoose';

import { Material, type MaterialDocument } from '../content/schemas/material.schema.js';
import { FLASHCARD_BACK_MAX, FLASHCARD_FRONT_MAX } from './dto/flashcard.dto.js';
import { AiJob, type AiJobDocument } from './schemas/ai-job.schema.js';
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
/** 개념 카드 작업(apps/ai services/quiz/flashcards.py TYPE, quiz-sets.service.ts CARDS_TYPE와 같음) */
const CARDS_TYPE = 'quiz_flashcards';
/** 목록을 열 때 한 번에 옮기는 끝난 카드 작업 수(오래된 것부터, 남은 작업은 다음 조회에) */
export const CARD_JOB_PULL_LIMIT = 50;
const DUPLICATE_KEY = 11000;

/** 자동 카드가 저장할 세트(quiz_sets 한 줄 중 쓰는 필드) */
export interface CardSet {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  materialId?: Types.ObjectId | null;
  folderId?: Types.ObjectId | null;
}

/**
 * 자동 카드 id(#558): 사용자 · 노트 · 앞면(frontKey)에서 늘 같은 값이 나온다. 그래서
 * - 같은 결과를 여러 번(동시에) 옮겨도, 같은 노트의 다른 세트가 같은 앞면 카드를 동시에 옮겨도 _id 고유 색인이 한 장만
 *   남긴다(Codex 재리뷰 3차: 앞면을 읽고 넣는 사이에 다른 세트가 넣으면 겹쳤음). 새 색인은 두지 않는다
 * - 지운 카드(deletedAt)는 문서가 남아 같은 앞면으로 다시 생기지 않는다(upsert $setOnInsert)
 * 노트가 없는 세트는 사용자 안에서 같은 앞면이면 같은 카드다
 */
export function autoCardId(
  ownerId: Types.ObjectId,
  materialId: Types.ObjectId | null,
  front: string,
): Types.ObjectId {
  const key = `flashcard:${ownerId.toHexString()}:${materialId?.toHexString() ?? '-'}:${frontKey(front)}`;
  return new Types.ObjectId(createHash('sha256').update(key).digest('hex').slice(0, 24));
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

/** 로그에 남기는 오류: 이름 · 코드만(카드 · 노트 글이 섞이지 않게) */
function errorName(e: unknown): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return `${e instanceof Error ? e.name : typeof e}${code === undefined ? '' : ` ${String(code)}`}`;
}

/**
 * 앞면이 같은 카드인지 비교하는 값: 공백만 보지 않는다. 대소문자는 살린다(CO 일산화탄소 · Co 코발트처럼
 * 대소문자로 다른 용어가 있음, Codex 리뷰 #559)
 */
const frontKey = (front: string): string => front.normalize('NFC').replace(/\s+/g, '');

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
    @InjectModel(AiJob.name) private readonly jobs: Model<AiJobDocument>, // 끝난 개념 카드 작업을 읽기만 한다
  ) {}

  private readonly logger = new Logger(FlashcardsService.name);

  /**
   * 내 플래시카드. 지운 카드는 빼고, 앱처럼 저장한 순서(오래된 것부터)로 준다.
   * 먼저 끝난 개념 카드 작업의 카드를 옮긴다(pullCards). 옮기다 실패해도 목록은 그대로 준다
   */
  async list(userId: string): Promise<AppFlashcard[]> {
    const ownerId = new Types.ObjectId(userId);
    await this.pullCards(ownerId);
    const rows = await this.cards
      .find({ ownerId, deletedAt: null })
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
    // 확인한 뒤 저장하기 전에 세트가 지워졌으면(학습 폴더 삭제, #602) 방금 만든 카드도 지우고 확인 때와 같은 404.
    // 폴더 삭제의 정리가 끝난 뒤에 저장됐을 수 있어 저장한 쪽이 다시 본다
    const row = created.toObject() as unknown as FlashcardRow;
    if (source && !(await this.sets.exists({ _id: source.sourceQuizSetId, ownerId, deletedAt: null }))) {
      await this.cards.updateOne({ _id: row._id }, { $set: { deletedAt: new Date() } });
      throw new NotFoundException({ code: NOT_FOUND, message: '문제를 찾을 수 없어요' });
    }
    return toApp(row);
  }

  /**
   * 끝난 개념 카드 작업(quiz_flashcards, #558)의 카드를 옮긴다. 작업은 세트가 ready가 될 때 NestJS가 넣고
   * (quiz-sets.service.ts settle), 처리기는 ai_jobs에만 쓰므로 카드는 여기서 flashcards로 옮긴다.
   * 플래시카드 목록(GET /flashcards)이 카드를 보는 곳이라 열 때 옮긴다.
   * 옮긴 작업은 result.flashcardsSavedAt을 남겨 다시 읽지 않는다(result는 자유 객체라 스키마는 그대로, 처리기는
   * 끝난 작업을 다시 쓰지 않음). 카드를 하나도 쓰지 않은 작업(지운 세트 · 앞면이 모두 겹침)도 남긴다. 쓰다 실패하면
   * 남기지 않아 다음 조회가 다시 옮긴다(이미 넣은 카드는 id로 건너뛰고 남은 카드만 들어감).
   * 오래된 것부터 CARD_JOB_PULL_LIMIT개씩. 작업마다 따로: 하나가 실패해도 나머지는 옮긴다
   */
  private async pullCards(ownerId: Types.ObjectId): Promise<void> {
    let jobs: { _id: Types.ObjectId; targetId: Types.ObjectId; result?: Record<string, unknown> | null }[];
    try {
      jobs = await this.jobs
        .find({ userId: ownerId, type: CARDS_TYPE, status: 'succeeded', 'result.flashcardsSavedAt': null })
        .sort({ createdAt: 1 })
        .limit(CARD_JOB_PULL_LIMIT)
        .select({ targetId: 1, 'result.flashcards': 1 })
        .lean<{ _id: Types.ObjectId; targetId: Types.ObjectId; result?: Record<string, unknown> | null }[]>();
    } catch (e) {
      this.logger.warn(`끝난 개념 카드 작업을 읽지 못했습니다(목록은 그대로): ${errorName(e)}`);
      return;
    }
    for (const job of jobs) {
      try {
        const set = await this.sets
          .findOne({ _id: job.targetId, ownerId, deletedAt: null })
          .select({ ownerId: 1, materialId: 1, folderId: 1 })
          .lean<CardSet | null>();
        if (set) await this.saveFromQuizSet(set, job.result?.['flashcards']);
        await this.jobs.updateOne(
          { _id: job._id, status: 'succeeded' },
          { $set: { 'result.flashcardsSavedAt': new Date() } },
        );
      } catch (e) {
        this.logger.warn(
          `개념 카드를 옮기지 못했습니다(다음 조회에 다시, 세트 ${job.targetId.toHexString()}): ${errorName(e)}`,
        );
      }
    }
  }

  /**
   * 개념 카드 작업 결과(처리기 result.flashcards, #558)를 그 세트 주인의 카드로 저장한다(pullCards). 출처는 세트 · 노트 · 폴더이고 문제는 없다
   * (sourceQuestionId null: 퀴즈 문제가 아니라 같은 범위의 따로 만든 카드).
   * id는 사용자 · 노트 · 앞면에서 정해(autoCardId) 없을 때만 넣는다: 여러 번 · 동시에 옮겨도 한 번만, 지운 카드는
   * 되살리지 않는다. 모양이 틀린 카드는 빼고(순번은 처리기 차례 그대로), AUTO_CARD_MAX장까지만.
   * 그 사이 지운 세트 · 노트에는 쓰지 않는다. 동시에 넣다 생긴 중복 키 말고 쓰기 오류는 올린다(pullCards가 로그만 남김)
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
    // 같은 노트로 퀴즈를 여러 번 만들면 같은 개념 카드가 세트마다 쌓인다: 그 노트의 카드(지운 카드 · 앱에서 저장한
    // 카드 포함)와 앞면이 같으면 뺀다(/code-review). 자동 카드끼리는 id(사용자 · 노트 · 앞면)로도 막혀, 다른 세트가 같이
    // 옮겨도 한 장만 남는다
    const known = new Set(
      materialId
        ? (
            await this.cards
              .find({ ownerId: set.ownerId, materialId })
              .select({ front: 1 })
              .lean<{ front: string }[]>()
          ).map((c) => frontKey(c.front))
        : [],
    );
    const fresh = cards.filter((c) => !known.has(frontKey(c.card.front)));
    if (fresh.length === 0) return;
    const now = Date.now();
    const folderId = set.folderId ?? materialFolder;
    // id가 해시라 순서가 섞이므로, 만든 때를 1ms씩 달리 해 목록(createdAt 차례)이 처리기 차례를 지킨다
    const ops = fresh.map(({ index, card }) => ({
      updateOne: {
        filter: { _id: autoCardId(set.ownerId, materialId, card.front) },
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
            createdAt: new Date(now + index),
            updatedAt: new Date(now + index),
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
    // 확인한 뒤 쓰기 전에 세트가 지워졌으면(학습 폴더 삭제, #602) 이 세트로 넣은 카드를 지운다. 폴더 삭제의 정리가 끝난
    // 뒤에 들어갔을 수 있어 쓴 쪽이 다시 본다
    if (!(await this.sets.exists({ _id: set._id, ownerId: set.ownerId, deletedAt: null }))) {
      await this.cards.updateMany(
        { _id: { $in: ops.map((o) => o.updateOne.filter._id) }, ownerId: set.ownerId, sourceQuizSetId: set._id, deletedAt: null },
        { $set: { deletedAt: new Date() } },
      );
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
