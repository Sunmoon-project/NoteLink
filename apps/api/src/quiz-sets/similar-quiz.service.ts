import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, mongo, Types } from 'mongoose';

import { AiJobsService } from '../ai-jobs/ai-jobs.service.js';
import { Material, type MaterialDocument } from '../modules/content/schemas/material.schema.js';
import {
  QuizAttempt,
  type QuizAttemptDocument,
} from '../modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet, type QuizSetDocument } from '../modules/quiz/schemas/quiz-set.schema.js';
import { RecordingNotePagesService } from './recording-note-pages.service.js';
import {
  type AppQuizSet,
  INPUT_ATTEMPT_LIMIT,
  INPUT_BYTE_LIMIT,
  INPUT_SET_LIMIT,
  isDuplicateKey,
  notFound,
  objectId,
  type PageRow,
  type QuizSetRow,
  QuizSetsService,
  SIMILAR_TYPE,
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
  answers?: { questionId: Types.ObjectId; correct: boolean; void?: boolean | string }[];
  reviewPending?: boolean;
}

const conflict = (message: string) => new ConflictException({ code: VALIDATION_FAILED, message });

/** 같은 노트로 만드는 중인 세트가 있어 지금은 오답 복습을 넣지 못함(응답은 409 그대로). 자동 시작은 기다리게 둔다 */
class ReviewBlocked extends ConflictException {}

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
    /** 노트 글 만들기(녹음 노트는 대본에서). 맞춤 퀴즈와 같은 한 곳을 쓴다 */
    private readonly notePages: RecordingNotePagesService,
  ) {
    quizSets.afterReview = (row) => this.catchUp(row);
  }

  /**
   * needWrong = false(퀴즈를 끝낸 뒤 자동): 모두 맞혀도 작업을 넣는다. 처리기가 복습 상태만 옮기고 세트는 문제 없이 failed.
   * attemptId: 그 풀이로 만든다(자동 · 이어 받기). 없으면 이 세트를 마지막으로 푼 풀이(유사 퀴즈 버튼)
   */
  async create(
    userId: string,
    setId: string,
    needWrong = true,
    attemptId?: string,
  ): Promise<AppQuizSet> {
    const owner = objectId(userId, '퀴즈');
    const source = await this.sets
      .findOne({ _id: objectId(setId, '퀴즈'), ownerId: owner, deletedAt: null, status: 'ready' })
      .lean<QuizSetRow>();
    if (!source) throw notFound('퀴즈');
    if (!source.materialId)
      throw conflict('이 퀴즈는 노트가 정해지지 않아 유사 퀴즈를 만들 수 없어요');

    const finished = { userId: owner, quizSetId: source._id, finishedAt: { $ne: null } };
    const [attempt] = attemptId
      ? [
          await this.attempts
            .findOne({ ...finished, _id: objectId(attemptId, '퀴즈') })
            .lean<AttemptRow>(),
        ]
      : await this.attempts.find(finished).sort({ finishedAt: -1 }).limit(1).lean<AttemptRow[]>();
    if (!attempt) throw conflict('먼저 이 퀴즈를 끝까지 풀어 주세요');
    if (needWrong && !(attempt.answers ?? []).some((a) => !a.correct))
      throw conflict('틀린 문제가 없어요');
    // 자동 시작(attemptId)만 「기다림」을 쓴다. 이미 이 풀이로 만든 세트가 있으면 결과를 맞추기(findMine) 전에
    // 표시부터 지운다: 맞추다 이어 받기(catchUp)가 돌아도 이 풀이를 다시 고르지 않게
    const auto = attemptId !== undefined;
    if (
      attempt.reviewPending &&
      (await this.sets
        .findOne({ ownerId: owner, sourceAttemptId: attempt._id, deletedAt: null })
        .lean<QuizSetRow>())
    )
      await this.markPending(attempt._id, false);

    // 같은 세트로 이미 만드는 중이면 그 세트(두 번 눌러도 작업을 하나만). 앞 풀이의 세트가 아직 만드는 중이면
    // 이번 풀이는 그 결과를 옮길 때 이어 받는다(catchUp). 방금 끝났으면 이어 받은 세트(madeFor)로 넘어간다
    const pending = await this.sets
      .findOne({ ownerId: owner, sourceSetId: source._id, status: 'generating', deletedAt: null })
      .lean<QuizSetRow>();
    if (pending) {
      const mine = String(pending.sourceAttemptId) === String(attempt._id);
      // 앞 풀이의 세트가 만드는 중: 결과를 맞추기(findMine) 전에 「기다림」부터 적는다. 맞추는 사이 이 요청이나
      // 다른 요청이 그 세트를 끝내도 그때 도는 이어 받기(catchUp)가 이 풀이를 고른다. 이미 끝나 있었으면 아래에서
      // 바로 넣거나(작업을 넣으면 지움) 이어 받은 세트(madeFor)로 넘어간다
      if (mine) await this.markPending(attempt._id, false);
      else if (auto) await this.markPending(attempt._id, true);
      const synced = await this.quizSets.findMine(userId, pending._id.toString());
      if (synced.status === 'generating' || mine) return synced;
    }
    const already = await this.madeFor(userId, owner, source, attempt);
    if (already) {
      await this.markPending(attempt._id, false);
      return already;
    }

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
        sourceAttemptId: attempt._id,
        title: `${source.title} · 다시 보기`,
        status: 'generating',
        progress: 0,
        questionCount: 0,
        questions: [],
        jobId: new Types.ObjectId(job._id),
        deletedAt: null,
      });
      await this.markPending(attempt._id, false);
      return toAppSet(created.toObject<QuizSetRow>(), job.progress);
    } catch (e) {
      if (!isDuplicateKey(e)) {
        // 저장됐는지 알 수 없는 오류(쓰기는 반영됐는데 응답만 실패했을 수 있다): 세트를 읽어 확인한다
        const saved = await this.savedSet(newId, owner);
        if (saved === 'unknown') throw e; // 확인하지 못하면 작업을 거두지 않는다(저장된 세트의 작업일 수 있다)
        if (saved?.jobId?.toString() === job._id) return toAppSet(saved, job.progress);
        await this.cancelQuietly(userId, job._id);
        throw e;
      }
      // 고유 색인에 막혔으면 저장되지 않은 것이 확실하다: 넣은 작업은 거두고, 만드는 중인 세트를 기다리게 한다
      await this.jobs.cancel(userId, job._id);
      // 같은 세트로 동시에 온 다른 요청이 먼저 만들었으면 그 세트를 돌려준다
      const first = await this.sets
        .findOne({ ownerId: owner, sourceSetId: source._id, status: 'generating', deletedAt: null })
        .lean<QuizSetRow>();
      if (first) {
        if (String(first.sourceAttemptId) === String(attempt._id))
          await this.markPending(attempt._id, false);
        else if (auto) await this.markPending(attempt._id, true);
        return this.quizSets.findMine(userId, first._id.toString());
      }
      // 같은 노트의 다른 세트(일반 퀴즈 등)가 만드는 중: 기다린다. 적은 뒤 그 세트가 아직 만드는 중인지 다시 본다:
      // 작업을 거두는 사이 끝나(이어 받기까지 돌아) 버렸으면 기다려도 아무도 이어 받지 않으므로 다시 만든다
      if (auto) {
        await this.markPending(attempt._id, true);
        const blocker = await this.sets
          .findOne({
            ownerId: owner,
            materialId: source.materialId,
            status: 'generating',
            deletedAt: null,
          })
          .lean<QuizSetRow>();
        // ponytail: 겹칠 때마다 다시 부른다. 새 만드는 중 세트가 그때마다 끼어들어야만 이어지므로 끝이 있다
        if (!blocker) return this.create(userId, setId, needWrong, attemptId);
      }
      throw new ReviewBlocked({
        code: VALIDATION_FAILED,
        message: '이 노트로 퀴즈를 만드는 중이에요. 끝나면 다시 시도해 주세요',
      });
    }
  }

  /**
   * 퀴즈를 끝내면 바로 오답 복습을 시작한다(풀이 끝내기 뒤에 부름). 모두 맞혀도 시작한다: 복습 상태(연속 정답 ·
   * 다음 복습 날짜)는 이 처리기만 옮기므로, 안 하면 오늘의 복습을 다 맞혀도 다음 날 같은 문제가 나온다.
   * 무효 풀이만 있거나 노트가 없는 세트 ·
   * 이미 만든 풀이 등 만들 수 없는 경우는 조용히 넘어간다: 풀이 끝내기 응답과 포인트에는 영향이 없다.
   * 결과 화면의 유사 퀴즈는 같은 세트를 이어받아(만드는 중 · 다 만든 세트) 기다리지 않고 바로 연다
   */
  async startAfterFinish(userId: string, attemptId: string): Promise<AppQuizSet | null> {
    const owner = objectId(userId, '퀴즈');
    const attempt = await this.attempts
      .findOne({ _id: objectId(attemptId, '퀴즈'), userId: owner, finishedAt: { $ne: null } })
      .lean<AttemptRow>();
    if (!attempt) return null;
    // 답이 모두 무효면(기다리는 사이 결함 문제로 무효가 됐어도) 넣을 것이 없다: 기다림도 지운다
    if (!(attempt.answers ?? []).some((a) => !a.void)) {
      if (attempt.reviewPending) await this.markPending(attempt._id, false);
      return null;
    }
    // 같은 노트의 만드는 중 세트에 막히면 create가 「기다림」을 적고(그 세트가 끝날 때 catchUp이 이어 받음),
    // 작업을 넣으면 지운다. 다시 해도 안 되는 실패(지운 퀴즈 · 이미 만듦 등)는 지운다
    try {
      return await this.create(userId, attempt.quizSetId.toString(), false, attemptId);
    } catch (e) {
      if (e instanceof ReviewBlocked) return null;
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 409 || status === 400) {
        await this.markPending(attempt._id, false);
        return null;
      }
      throw e;
    }
  }

  private async markPending(attemptId: Types.ObjectId, on: boolean): Promise<void> {
    await this.attempts
      .findOneAndUpdate({ _id: attemptId }, { $set: { reviewPending: on } })
      .lean();
  }

  /**
   * 같은 노트의 만드는 중 세트(일반 퀴즈 · 오답 복습)에 결과를 옮긴 뒤(QuizSetsService.afterReview): 그 세트에 막혀
   * 기다리던 풀이(reviewPending)를 끝낸 순서대로 하나씩 넣는다(같은 노트로 만드는 중인 세트는 하나). 하나를 넣으면
   * 그 세트의 결과를 옮길 때 다음 것. 다시 막히면 멈추고 다음에 이어 간다. 넣다 오류가 나면 던져
   * 세트에 「이어 받을 풀이 남음」이 남는다(다음 조회가 다시). 완료 시각 경계가 아니라 표시로 찾아 같은 시각의 풀이도 빠지지 않는다
   */
  private async catchUp(row: QuizSetRow): Promise<void> {
    if (!row.materialId) return;
    const sameNote = await this.sets
      .find({ ownerId: row.ownerId, materialId: row.materialId }, { _id: 1 })
      .lean<{ _id: Types.ObjectId }[]>();
    // 50개씩 읽는다. 처리한 풀이는 표시가 지워지므로 다시 읽으면 다음 것들: 작업을 넣거나 다시 막히거나 남은 게 없을 때까지
    for (;;) {
      const waiting = await this.attempts
        .find({
          userId: row.ownerId,
          quizSetId: { $in: sameNote.map((x) => x._id) },
          reviewPending: true,
        })
        .sort({ finishedAt: 1, _id: 1 })
        .limit(50)
        .lean<AttemptRow[]>();
      if (waiting.length === 0) return;
      for (const a of waiting) {
        await this.startAfterFinish(row.ownerId.toString(), a._id.toString());
        const now = await this.attempts.findOne({ _id: a._id }).lean<AttemptRow>();
        if (now?.reviewPending) return; // 다시 막힘: 막은 세트가 끝날 때 이어 간다
        const started = await this.sets
          .findOne({ sourceAttemptId: a._id, status: 'generating', deletedAt: null })
          .lean<QuizSetRow>();
        if (started) return; // 이 풀이의 작업이 돈다: 그 결과를 옮길 때 다음 것
      }
    }
  }

  /** 방금 만들려던 세트가 저장돼 있는지. 있으면 그 세트, 없으면 null, 읽지 못했으면 'unknown' */
  private async savedSet(
    id: Types.ObjectId,
    owner: Types.ObjectId,
  ): Promise<QuizSetRow | null | 'unknown'> {
    try {
      return await this.sets.findOne({ _id: id, ownerId: owner }).lean<QuizSetRow>();
    } catch {
      return 'unknown';
    }
  }

  /** 세트 저장 오류를 먼저 알리려고, 작업을 거두다 난 오류는 삼킨다(남은 작업은 세트가 없어 결과를 옮기지 않는다) */
  private async cancelQuietly(userId: string, jobId: string): Promise<void> {
    await this.jobs.cancel(userId, jobId).catch(() => undefined);
  }

  /**
   * 오답 복습은 만들 때마다 틀린 문제들의 복습 상태(srsUpdates)를 옮기므로 한 풀이에 한 번만 만든다.
   * 이 풀이로 만든 세트가 남아 있고 만드는 중이거나 다 만들었으면 그 세트를 돌려준다(다시 만들지 않음).
   * 처리기가 끝냈는데(복습 상태를 옮김) 세트를 지웠거나 새 문제를 못 만들었으면 409.
   * 처리기가 실패 · 취소로 끝냈으면(옮긴 것 없음) 그 세트를 닫고 null: 새로 만들게 둔다.
   * 작업을 읽지 못하면(일시적인 DB 오류) 세트를 닫지 않고 오류를 그대로 알린다: 다 만든 세트를 지우지 않게
   */
  private async madeFor(
    userId: string,
    owner: Types.ObjectId,
    source: QuizSetRow,
    attempt: AttemptRow,
  ): Promise<AppQuizSet | null> {
    const made = await this.sets
      .find({ ownerId: owner, sourceSetId: source._id, sourceAttemptId: attempt._id })
      .sort({ createdAt: -1 })
      .lean<QuizSetRow[]>();
    const superseded: QuizSetRow[] = [];
    for (const prev of made) {
      const job = prev.jobId ? await this.jobOf(userId, prev.jobId.toString()) : null;
      if (!job || job.status === 'failed' || job.status === 'canceled') {
        if (!prev.deletedAt) superseded.push(prev);
        continue;
      }
      if (!prev.deletedAt && prev.status !== 'failed')
        return this.quizSets.findMine(userId, prev._id.toString());
      throw conflict('이번 풀이로는 이미 유사 퀴즈를 만들었어요. 퀴즈를 다시 풀고 시도해 주세요');
    }
    // 새로 만들기 전에 실패로 끝난 세트를 닫는다(지움): 그 작업을 나중에 다시 시도(ai-jobs retry)해 성공해도
    // 지운 세트는 조회되지 않아 결과(문제 · 복습 상태)를 옮기지 않으므로, 한 풀이의 복습 상태가 두 번 옮겨지지 않는다
    for (const prev of superseded) {
      await this.sets
        .findOneAndUpdate(
          { _id: prev._id, ownerId: owner, deletedAt: null },
          { $set: { deletedAt: new Date() } },
        )
        .lean();
    }
    return null;
  }

  /** 내 작업. 없는 작업(404)만 null이고, 그 밖의 조회 오류는 그대로 던진다 */
  private async jobOf(userId: string, jobId: string) {
    try {
      return await this.jobs.findMine(userId, jobId);
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
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
    // 무효 풀이(결함 문제, 오늘의 복습이 정함)는 처리기가 없는 풀이로 본다
    const answers = (a: AttemptRow) =>
      (a.answers ?? []).map((x) => ({
        questionId: x.questionId.toString(),
        correct: x.correct,
        ...(x.void ? { void: x.void } : {}),
      }));
    return fitReviewInput({
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

/** 오답 복습 처리기 입력(apps/ai services/quiz/review.py 「input」) */
export interface ReviewInput extends Record<string, unknown> {
  attemptId: string;
  quizSetId: string;
  finishedAt: string;
  answers: { questionId: string; correct: boolean }[];
  sets: { id: string; materialId: string; questions: Record<string, unknown>[] }[];
  history: { id: string; quizSetId: string; finishedAt: string; answers: unknown[] }[];
  notes: Record<string, { pageNo: number; ocrText: string }[]>;
}

const bsonBytes = (key: string, value: unknown) => mongo.BSON.calculateObjectSize({ [key]: value });

/**
 * 입력을 limit 바이트(BSON) 안으로 줄인다(ai_jobs 문서가 MongoDB 한도를 넘지 않게, 맞춤 퀴즈 fitInput과 같은 방식).
 * 이번 세트(sets[0]) · 그 노트 · 이번 풀이는 꼭 넣고, 넘으면 400. 나머지 세트는 최근 것부터 그 세트의 풀이 ·
 * 노트 글과 함께 들어갈 만큼만 넣는다
 */
export function fitReviewInput(input: ReviewInput, limit = INPUT_BYTE_LIMIT): ReviewInput {
  const [first, ...rest] = input.sets;
  const historyOf = (id: string) => input.history.filter((h) => h.quizSetId === id);
  const noteIds = new Set<string>(first ? [first.materialId] : []);
  const base = {
    ...input,
    sets: first ? [first] : [],
    history: first ? historyOf(first.id) : [],
    notes:
      first && input.notes[first.materialId]
        ? { [first.materialId]: input.notes[first.materialId]! }
        : {},
  };
  let total = mongo.BSON.calculateObjectSize(base);
  if (total > limit) {
    throw new BadRequestException({
      code: VALIDATION_FAILED,
      message: '노트가 너무 길어 유사 퀴즈를 만들 수 없어요. 노트를 나눠 올려 주세요',
    });
  }
  const kept = new Set<string>(first ? [first.id] : []);
  for (const set of rest) {
    const note = input.notes[set.materialId];
    const noteSize = note && !noteIds.has(set.materialId) ? bsonBytes(set.materialId, note) : 0;
    const size =
      bsonBytes('000', set) +
      historyOf(set.id).reduce((n, h) => n + bsonBytes('000', h), 0) +
      noteSize;
    if (total + size > limit) continue;
    total += size;
    kept.add(set.id);
    if (note) noteIds.add(set.materialId);
  }
  return {
    ...input,
    sets: input.sets.filter((x) => kept.has(x.id)),
    history: input.history.filter((x) => kept.has(x.quizSetId)),
    notes: Object.fromEntries(Object.entries(input.notes).filter(([id]) => noteIds.has(id))),
  };
}
