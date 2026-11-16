import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { AiJobsService } from '../ai-jobs/ai-jobs.service.js';
import { Material, type MaterialDocument } from '../modules/content/schemas/material.schema.js';
import {
  QuizAttempt,
  type QuizAttemptDocument,
} from '../modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet, type QuizSetDocument } from '../modules/quiz/schemas/quiz-set.schema.js';
import {
  type AppQuizSet,
  INPUT_SET_LIMIT,
  isDuplicateKey,
  notFound,
  objectId,
  type PageRow,
  type QuizSetRow,
  QuizSetsService,
  SIMILAR_TYPE,
  textPages,
  toAppSet,
  toWorkerQuestion,
  VALIDATION_FAILED,
} from './quiz-sets.service.js';

/** 오답 복습이 약한 개념을 셀 때 보는 기간(apps/ai services/quiz/review.py WEAK_DAYS) */
const HISTORY_DAYS = 30;

interface AttemptRow {
  _id: Types.ObjectId;
  quizSetId: Types.ObjectId;
  finishedAt: Date;
  answers?: { questionId: Types.ObjectId; correct: boolean }[];
}

const conflict = (message: string) => new ConflictException({ code: VALIDATION_FAILED, message });

/**
 * 유사 퀴즈(POST /quiz-sets/:id/similar). 이 세트를 마지막으로 푼 풀이에서 틀린 문제마다 비슷한 문제를
 * 만드는 오답 복습 작업(similar_quiz)을 넣고, 결과를 담을 「다시 보기」 세트를 만드는 중으로 만든다.
 * 결과는 세트 조회(GET /quiz-sets/:id)가 옮긴다(QuizSetsService.sync: reviewQuestions · srsUpdates).
 */
@Injectable()
export class SimilarQuizService {
  constructor(
    @InjectModel(QuizSet.name) private readonly sets: Model<QuizSetDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    @InjectModel(Material.name) private readonly materials: Model<MaterialDocument>,
    private readonly jobs: AiJobsService,
    private readonly quizSets: QuizSetsService,
  ) {}

  async create(userId: string, setId: string): Promise<AppQuizSet> {
    const owner = objectId(userId, '퀴즈');
    const source = await this.sets
      .findOne({ _id: objectId(setId, '퀴즈'), ownerId: owner, deletedAt: null, status: 'ready' })
      .lean<QuizSetRow>();
    if (!source) throw notFound('퀴즈');
    if (!source.materialId)
      throw conflict('이 퀴즈는 노트가 정해지지 않아 유사 퀴즈를 만들 수 없어요');

    // 같은 세트로 이미 만드는 중이면 그 세트(두 번 눌러도 작업을 하나만)
    const pending = await this.sets
      .findOne({ ownerId: owner, sourceSetId: source._id, status: 'generating', deletedAt: null })
      .lean<QuizSetRow>();
    if (pending) return this.quizSets.findMine(userId, pending._id.toString());

    const [attempt] = await this.attempts
      .find({ userId: owner, quizSetId: source._id, finishedAt: { $ne: null } })
      .sort({ finishedAt: -1 })
      .limit(1)
      .lean<AttemptRow[]>();
    if (!attempt) throw conflict('먼저 이 퀴즈를 끝까지 풀어 주세요');
    if (!(attempt.answers ?? []).some((a) => !a.correct)) throw conflict('틀린 문제가 없어요');

    const newId = new Types.ObjectId();
    const job = await this.jobs.enqueue({
      type: SIMILAR_TYPE,
      userId,
      targetType: 'quiz_set',
      targetId: newId.toString(),
      input: await this.input(owner, source, attempt),
    });
    try {
      const created = await this.sets.create({
        _id: newId,
        ownerId: owner,
        materialId: source.materialId,
        folderId: source.folderId,
        source: 'ai_generated',
        sourceSetId: source._id,
        title: `${source.title} · 다시 보기`,
        status: 'generating',
        progress: 0,
        questionCount: 0,
        questions: [],
        jobId: new Types.ObjectId(job._id),
        deletedAt: null,
      });
      return toAppSet(created.toObject<QuizSetRow>(), job.progress);
    } catch (e) {
      // 세트를 저장하지 못했으면 넣은 작업은 거둔다. 같은 노트로 만드는 중인 세트가 있으면(고유 색인) 기다리게 한다
      await this.jobs.cancel(userId, job._id);
      if (!isDuplicateKey(e)) throw e;
      // 같은 세트로 동시에 온 다른 요청이 먼저 만들었으면 그 세트를 돌려준다
      const first = await this.sets
        .findOne({ ownerId: owner, sourceSetId: source._id, status: 'generating', deletedAt: null })
        .lean<QuizSetRow>();
      if (first) return this.quizSets.findMine(userId, first._id.toString());
      throw conflict('이 노트로 퀴즈를 만드는 중이에요. 끝나면 다시 시도해 주세요');
    }
  }

  /**
   * 오답 복습 처리기 입력(apps/ai services/quiz/review.py 「input」). 처리기는 다른 컬렉션을 읽지 않으므로
   * 이번 풀이 · 사용자의 세트(이번 세트 포함) · 최근 30일 다른 풀이 · 세트가 가리키는 노트 글을 담는다
   */
  private async input(
    owner: Types.ObjectId,
    source: QuizSetRow,
    attempt: AttemptRow,
  ): Promise<Record<string, unknown>> {
    const recent = await this.sets
      // 처리기는 세트마다 노트(materialId)가 있어야 한다: 노트를 섞은 오늘의 복습 세트 등은 뺀다
      .find({
        ownerId: owner,
        deletedAt: null,
        status: 'ready',
        _id: { $ne: source._id },
        materialId: { $ne: null },
      })
      .sort({ createdAt: -1 })
      .limit(INPUT_SET_LIMIT - 1)
      .lean<QuizSetRow[]>();
    const sets = [source, ...recent];
    const since = new Date(attempt.finishedAt.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000);
    const history = await this.attempts
      .find({
        userId: owner,
        quizSetId: { $in: sets.map((s) => s._id) },
        finishedAt: { $gte: since, $lte: attempt.finishedAt },
        _id: { $ne: attempt._id },
      })
      .lean<AttemptRow[]>();
    const materialIds = [...new Set(sets.map((s) => s.materialId!.toString()))];
    const notes = await this.materials
      .find(
        { _id: { $in: materialIds.map((id) => new Types.ObjectId(id)) }, ownerId: owner },
        { pages: 1 },
      )
      .lean<{ _id: Types.ObjectId; pages?: PageRow[] }[]>();
    const answers = (a: AttemptRow) =>
      (a.answers ?? []).map((x) => ({ questionId: x.questionId.toString(), correct: x.correct }));
    return {
      attemptId: attempt._id.toString(),
      quizSetId: source._id.toString(),
      finishedAt: attempt.finishedAt.toISOString(),
      answers: answers(attempt),
      sets: sets.map((s) => ({
        id: s._id.toString(),
        materialId: s.materialId!.toString(),
        questions: (s.questions ?? []).map(toWorkerQuestion),
      })),
      history: history.map((h) => ({
        id: h._id.toString(),
        quizSetId: h.quizSetId.toString(),
        finishedAt: h.finishedAt.toISOString(),
        answers: answers(h),
      })),
      notes: Object.fromEntries(notes.map((m) => [m._id.toString(), textPages(m.pages)])),
    };
  }
}
