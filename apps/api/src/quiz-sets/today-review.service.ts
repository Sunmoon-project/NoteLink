import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, mongo, Types } from 'mongoose';

import { AiJobsService } from '../ai-jobs/ai-jobs.service.js';
import { Material, type MaterialDocument } from '../modules/content/schemas/material.schema.js';
import {
  QuizAttempt,
  type QuizAttemptDocument,
} from '../modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet, type QuizSetDocument } from '../modules/quiz/schemas/quiz-set.schema.js';
import {
  type AppQuizSet,
  INPUT_ATTEMPT_LIMIT,
  INPUT_BYTE_LIMIT,
  isDuplicateKey,
  objectId,
  type PageRow,
  type QuizSetRow,
  QuizSetsService,
  seoulDay,
  TODAY_TYPE,
  toAppSet,
  toWorkerQuestion,
  VALIDATION_FAILED,
} from './quiz-sets.service.js';
import { RecordingNotePagesService } from './recording-note-pages.service.js';

/** 오늘의 복습 세트 문제 수(apps/ai services/quiz/today.py REVIEW_SET_SIZE와 같은 5) */
export const TODAY_SIZE = 5;

interface AttemptRow {
  _id: Types.ObjectId;
  quizSetId: Types.ObjectId;
  finishedAt: Date;
  answers?: {
    questionId: Types.ObjectId;
    answer?: string | null;
    correct: boolean;
    void?: boolean | string;
  }[];
}

/** 오늘의 복습 처리기 입력(apps/ai services/quiz/today.py 「input」) */
export interface TodayInput extends Record<string, unknown> {
  day: string;
  size: number;
  sets: { id: string; materialId: string; deletedAt?: string; questions: unknown[] }[];
  attempts: { id: string; quizSetId: string; finishedAt: string; answers: unknown[] }[];
  notes: Record<string, { pageNo: number; ocrText: string }[]>;
}

const bsonBytes = (key: string, value: unknown) => mongo.BSON.calculateObjectSize({ [key]: value });

/**
 * 입력을 limit 바이트(BSON) 안으로 줄인다. 최근 세트부터 그 세트의 풀이 · 노트 글과 함께 들어갈 만큼 넣고,
 * 처리기가 점수가 같은 문제를 고르는 순서(만든 순)는 그대로 둔다. 세트가 하나도 안 들어가면 400
 */
export function fitTodayInput(input: TodayInput, limit = INPUT_BYTE_LIMIT): TodayInput {
  let total = mongo.BSON.calculateObjectSize({ ...input, sets: [], attempts: [], notes: {} });
  const attemptsOf = (id: string) => input.attempts.filter((a) => a.quizSetId === id);
  const kept = new Set<string>();
  const noteIds = new Set<string>();
  for (const set of [...input.sets].reverse()) {
    const note = input.notes[set.materialId];
    const noteSize = note && !noteIds.has(set.materialId) ? bsonBytes(set.materialId, note) : 0;
    const size =
      bsonBytes('000', set) +
      attemptsOf(set.id).reduce((n, a) => n + bsonBytes('000', a), 0) +
      noteSize;
    if (total + size > limit) continue;
    total += size;
    kept.add(set.id);
    if (note) noteIds.add(set.materialId);
  }
  if (input.sets.length > 0 && kept.size === 0) {
    throw new BadRequestException({
      code: VALIDATION_FAILED,
      message: '노트가 너무 길어 오늘의 복습을 만들 수 없어요',
    });
  }
  return {
    ...input,
    sets: input.sets.filter((s) => kept.has(s.id)),
    attempts: input.attempts.filter((a) => kept.has(a.quizSetId)),
    notes: Object.fromEntries(Object.entries(input.notes).filter(([id]) => noteIds.has(id))),
  };
}

/**
 * 오늘의 복습(GET · POST /quiz-sets/today). 하루에 한 번, 복습 날짜가 된 문제를 모든 세트에서 모아
 * 한 세트로 만드는 작업(today_review)을 넣는다. 결과는 세트 조회가 옮긴다(QuizSetsService.sync:
 * questions · baseSetId · srsUpdates · voidAnswers). 복습할 문제가 없으면 세트는 문제 없이 failed로 끝난다
 */
@Injectable()
export class TodayReviewService {
  constructor(
    @InjectModel(QuizSet.name) private readonly sets: Model<QuizSetDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    @InjectModel(Material.name) private readonly materials: Model<MaterialDocument>,
    private readonly jobs: AiJobsService,
    private readonly quizSets: QuizSetsService,
    private readonly notePages: RecordingNotePagesService,
  ) {}

  /**
   * 오늘 만든 복습 세트(없으면 null). 만드는 중이면 결과를 먼저 옮긴다.
   * 처리기가 끝냈는데 문제가 없으면(복습할 문제 없음) null: failed는 처리기가 실패 · 취소했을 때만(앱이 다시 만들게 함)
   */
  async get(userId: string, now = new Date()): Promise<AppQuizSet | null> {
    const owner = objectId(userId, '퀴즈');
    const [row] = await this.sets
      .find({ ownerId: owner, reviewDay: seoulDay(now), deletedAt: null })
      .sort({ createdAt: -1 })
      .limit(1)
      .lean<QuizSetRow[]>();
    if (!row) return null;
    const set = await this.quizSets.findMine(userId, row._id.toString());
    if (set.status !== 'failed' || !row.jobId) return set;
    const job = await this.jobs.findMine(userId, row.jobId.toString()).catch(() => null);
    return job?.status === 'succeeded' ? null : set;
  }

  /**
   * 오늘의 복습을 만든다(하루 한 번). 오늘 세트가 있으면: 만드는 중 · 다 만듦 · 복습할 문제 없음(처리기가 끝냄)은
   * 그 세트를 돌려주고, 처리기가 실패 · 취소로 끝냈으면 그 세트를 닫고 다시 만든다(복습 상태를 옮긴 것이 없음)
   */
  async start(userId: string, now = new Date()): Promise<AppQuizSet> {
    const owner = objectId(userId, '퀴즈');
    const day = seoulDay(now);
    await this.settlePending(userId, owner, day);
    const today = await this.sets
      .find({ ownerId: owner, reviewDay: day, deletedAt: null })
      .sort({ createdAt: -1 })
      .lean<QuizSetRow[]>();
    for (const prev of today) {
      // 없는 작업(404)만 「옮긴 것 없음」으로 본다. 그 밖의 조회 오류는 던진다: 결과를 옮긴 세트를 닫으면
      // 문제(원본은 moved)가 복습에서 빠진다
      const job = prev.jobId
        ? await this.jobs.findMine(userId, prev.jobId.toString()).catch((e: unknown) => {
            if (e instanceof NotFoundException) return null;
            throw e;
          })
        : null;
      if (job && job.status !== 'failed' && job.status !== 'canceled')
        return this.quizSets.findMine(userId, prev._id.toString());
      await this.sets
        .findOneAndUpdate(
          { _id: prev._id, ownerId: owner, deletedAt: null },
          { $set: { deletedAt: new Date() } },
        )
        .lean();
    }

    const newId = new Types.ObjectId();
    const job = await this.jobs.enqueue({
      type: TODAY_TYPE,
      userId,
      targetType: 'quiz_set',
      targetId: newId.toString(),
      input: await this.input(owner, day),
    });
    try {
      const created = await this.sets.create({
        _id: newId,
        ownerId: owner,
        source: 'ai_generated',
        sourceSetId: null,
        reviewDay: day,
        title: `오늘의 복습 · ${day.slice(5)}`,
        status: 'generating',
        progress: 0,
        questionCount: 0,
        questions: [],
        jobId: new Types.ObjectId(job._id),
        deletedAt: null,
      });
      return toAppSet(created.toObject<QuizSetRow>(), job.progress);
    } catch (e) {
      await this.jobs.cancel(userId, job._id);
      if (!isDuplicateKey(e)) throw e;
      // 동시에 온 다른 요청이 먼저 만들었으면(노트 없는 만드는 중 세트는 하나: 고유 색인) 그 세트
      const first = await this.get(userId, now);
      if (first) return first;
      throw e;
    }
  }

  /**
   * 만드는 중인 세트의 결과를 먼저 옮긴다: 끝난 오답 복습 · 지난 오늘의 복습의 복습 상태가 이번 입력에 들어가게.
   * 그래도 만드는 중인 지난날의 오늘의 복습은 닫는다: 노트 없는 만드는 중 세트는 하나라(고유 색인) 오늘 세트를 막는다.
   * 닫은 세트는 조회되지 않아 그 작업이 나중에 끝나도 복습 상태를 옮기지 않는다(옮긴 것이 없음)
   */
  private async settlePending(userId: string, owner: Types.ObjectId, day: string): Promise<void> {
    const pending = await this.sets
      .find({ ownerId: owner, status: 'generating', deletedAt: null })
      .lean<QuizSetRow[]>();
    for (const row of pending) {
      const synced = await this.quizSets.findMine(userId, row._id.toString()).catch(() => null);
      if (synced?.status !== 'generating' || !row.reviewDay || row.reviewDay === day) continue;
      // 작업을 먼저 취소하고 다시 읽는다. 그 사이 처리기가 끝냈으면(성공은 취소되지 않음) 결과(원본 → 사본 넘김)가
      // 옮겨지는 중일 수 있어 지우지 않고 옮긴다. 취소 · 실패로 끝났을 때만 닫는다(옮긴 것이 없음)
      if (row.jobId) {
        const jobId = row.jobId.toString();
        await this.jobs.cancel(userId, jobId).catch((e: unknown) => {
          if (!(e instanceof NotFoundException)) throw e;
        });
        const job = await this.jobs.findMine(userId, jobId).catch((e: unknown) => {
          if (e instanceof NotFoundException) return null;
          throw e;
        });
        if (job?.status === 'succeeded') {
          await this.quizSets.findMine(userId, row._id.toString());
          continue;
        }
      }
      await this.sets
        .findOneAndUpdate(
          { _id: row._id, ownerId: owner, deletedAt: null },
          { $set: { deletedAt: new Date() } },
        )
        .lean();
    }
  }

  /**
   * 처리기 입력: 사용자의 세트 전부(지운 세트도 deletedAt과 함께: 그 풀이를 약한 개념 · 무효 풀이에 셈) ·
   * 끝낸 풀이 · 노트 글. 노트가 없는 세트(만드는 중인 오늘의 복습 등)는 처리기가 받지 않아 뺀다
   */
  private async input(owner: Types.ObjectId, day: string): Promise<TodayInput> {
    const sets = await this.sets
      .find({ ownerId: owner, status: 'ready', materialId: { $ne: null } })
      .sort({ createdAt: 1 })
      .lean<QuizSetRow[]>();
    const attempts = await this.attempts
      .find({
        userId: owner,
        quizSetId: { $in: sets.map((s) => s._id) },
        finishedAt: { $ne: null },
      })
      .sort({ finishedAt: -1 })
      .limit(INPUT_ATTEMPT_LIMIT)
      .lean<AttemptRow[]>();
    const materialIds = [...new Set(sets.map((s) => s.materialId!.toString()))];
    const notes = await this.materials
      .find(
        { _id: { $in: materialIds.map((id) => new Types.ObjectId(id)) }, ownerId: owner },
        { pages: 1, kind: 1, processing: 1 },
      )
      .lean<
        {
          _id: Types.ObjectId;
          kind?: string;
          pages?: PageRow[];
          processing?: { jobId?: Types.ObjectId | null };
        }[]
      >();
    return fitTodayInput({
      day,
      size: TODAY_SIZE,
      sets: sets.map((s) => ({
        id: s._id.toString(),
        materialId: s.materialId!.toString(),
        ...(s.deletedAt ? { deletedAt: s.deletedAt.toISOString() } : {}),
        questions: (s.questions ?? []).map(toWorkerQuestion),
      })),
      attempts: attempts.map((a) => ({
        id: a._id.toString(),
        quizSetId: a.quizSetId.toString(),
        finishedAt: a.finishedAt.toISOString(),
        answers: (a.answers ?? []).map((x) => ({
          questionId: x.questionId.toString(),
          answer: x.answer ?? null,
          correct: x.correct,
          ...(x.void ? { void: x.void } : {}),
        })),
      })),
      // 녹음 노트는 대본에서(유사 퀴즈 · 맞춤 퀴즈와 같은 한 곳)
      notes: Object.fromEntries(
        await Promise.all(
          notes.map(
            async (m) => [m._id.toString(), await this.notePages.notePages(owner, m)] as const,
          ),
        ),
      ),
    });
  }
}
