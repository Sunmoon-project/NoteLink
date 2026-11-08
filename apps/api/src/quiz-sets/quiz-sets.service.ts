import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { type AppAiJob, AiJobsService, PREGEN_TYPE } from '../ai-jobs/ai-jobs.service.js';
import { Material, type MaterialDocument } from '../modules/content/schemas/material.schema.js';
import {
  QuizAttempt,
  type QuizAttemptDocument,
} from '../modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet, type QuizSetDocument } from '../modules/quiz/schemas/quiz-set.schema.js';

/** 노트 · 세트가 없거나 남의 것일 때(packages/shared ERROR_CODES.NOT_FOUND) */
export const NOT_FOUND = 'NOT_FOUND';
/** 요청 형식 오류(packages/shared ERROR_CODES.VALIDATION) */
export const VALIDATION_FAILED = 'VALIDATION_FAILED';

/** 맞춤 퀴즈 작업(apps/ai services/quiz/generate.py TYPE) */
export const GENERATE_TYPE = 'quiz_generate';
const DUPLICATE_KEY = 11000;
/**
 * 처리기 입력에 넣는 지난 세트 수(최근 것부터). 세트 · 풀이가 쌓여도 ai_jobs 문서가 커지지 않게 한다
 * (MongoDB 문서 16MB 한도). 처리기는 이 세트들의 풀이로 아직 틀리는 쪽을 고른다
 */
export const INPUT_SET_LIMIT = 50;
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** 앱에 보내는 문제(packages/shared Question) */
export interface AppQuestion {
  _id: string;
  order: number;
  type: 'multiple_choice' | 'short_answer';
  prompt: string;
  choices: string[] | null;
  answer: string;
  explanation: string | null;
  conceptTags: string[];
}

/** 앱에 보내는 퀴즈 세트(packages/shared QuizSet) */
export interface AppQuizSet {
  _id: string;
  materialId: string;
  folderId: string;
  sourceSetId: string | null;
  title: string;
  status: 'generating' | 'ready' | 'failed';
  progress: number;
  questionCount: number;
  questions: AppQuestion[];
  createdAt: string;
}

/** DB에 저장한 문제 한 개(lean) */
export interface QuestionRow {
  _id: Types.ObjectId;
  order: number;
  type: string;
  prompt: string;
  passage?: string | null;
  category?: string | null;
  choices?: string[] | null;
  answer: string;
  explanation?: string | null;
  conceptTags?: string[];
  srs?: Record<string, unknown> | null;
}

/** DB에서 읽은 세트 한 줄(lean) */
export interface QuizSetRow {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  materialId?: Types.ObjectId;
  folderId?: Types.ObjectId;
  sourceSetId?: Types.ObjectId | null;
  title: string;
  status: 'generating' | 'ready' | 'failed';
  progress?: number;
  questionCount?: number;
  questions?: QuestionRow[];
  jobId?: Types.ObjectId | null;
  createdAt: Date;
}

interface PageRow {
  pageNo: number;
  ocrText?: string | null;
}

interface MaterialRow {
  _id: Types.ObjectId;
  folderId: Types.ObjectId;
  title: string;
  pages?: PageRow[];
}

interface AttemptRow {
  _id: Types.ObjectId;
  quizSetId: Types.ObjectId;
  finishedAt: Date;
  answers?: { questionId: Types.ObjectId; correct: boolean }[];
}

export function toAppQuestion(q: QuestionRow): AppQuestion {
  const choices = q.choices && q.choices.length > 0 ? q.choices : null;
  return {
    _id: q._id.toString(),
    order: q.order,
    // 처리기는 보기가 있으면 객관식, 없으면 단답으로 만든다(문제 갈래는 category에 따로 둔다)
    type: choices ? 'multiple_choice' : 'short_answer',
    // 공용 스키마에 지문 칸이 없어, 지문이 있으면 질문 아래에 붙인다(빈칸 문제는 지문이 있어야 풀 수 있다)
    prompt: q.passage ? `${q.prompt}\n\n${q.passage}` : q.prompt,
    choices,
    answer: q.answer,
    explanation: q.explanation ?? null,
    conceptTags: q.conceptTags ?? [],
  };
}

export function toAppSet(row: QuizSetRow, progress?: number): AppQuizSet {
  return {
    _id: row._id.toString(),
    materialId: String(row.materialId ?? ''),
    folderId: String(row.folderId ?? ''),
    sourceSetId: row.sourceSetId ? row.sourceSetId.toString() : null,
    title: row.title,
    status: row.status,
    progress: progress ?? row.progress ?? 0,
    questionCount: row.questionCount ?? row.questions?.length ?? 0,
    questions: (row.questions ?? []).map(toAppQuestion),
    createdAt: row.createdAt.toISOString(),
  };
}

/** 오늘(서울 날짜, DAY_RESET_HOUR=0이라 자정에 바뀜) YYYY-MM-DD. 처리기가 세트 제목에 쓴다 */
export function seoulDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 처리기 result.questions의 한 문제(apps/ai generate.py run) → 저장할 문제. 모양이 다르면 null */
export function fromWorkerQuestion(raw: unknown): QuestionRow | null {
  if (raw === null || typeof raw !== 'object') return null;
  const q = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const id = str(q['id']);
  const prompt = str(q['prompt']);
  const answer = str(q['answer']);
  const order = q['order'];
  if (
    !id ||
    !OBJECT_ID.test(id) ||
    !prompt ||
    answer === null ||
    typeof order !== 'number' ||
    !Number.isInteger(order)
  ) {
    return null;
  }
  const choices = q['choices'];
  if (choices !== null && choices !== undefined) {
    if (!Array.isArray(choices) || !choices.every((c) => typeof c === 'string')) return null;
  }
  const tags = q['conceptTags'];
  const conceptTags = Array.isArray(tags)
    ? tags.filter((t): t is string => typeof t === 'string')
    : [];
  const choiceList = (choices as string[] | null | undefined) ?? null;
  return {
    _id: new Types.ObjectId(id),
    order,
    type: choiceList && choiceList.length > 0 ? 'multiple_choice' : 'short_answer',
    prompt,
    passage: str(q['passage']),
    category: str(q['type']),
    choices: choiceList,
    answer,
    explanation: str(q['explanation']),
    conceptTags,
    srs: null,
  };
}

const notFound = (what: string) =>
  new NotFoundException({ code: NOT_FOUND, message: `${what}을 찾을 수 없어요` });

/** 앱이 보낸 id. 형식이 틀리면 없는 것과 같게 404 */
function objectId(id: string, what: string): Types.ObjectId {
  if (!OBJECT_ID.test(id)) throw notFound(what);
  return new Types.ObjectId(id);
}

const isDuplicateKey = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === DUPLICATE_KEY;

/**
 * 맞춤 퀴즈 세트 만들기 · 조회(#175). 세트를 만들면 FastAPI 처리기가 문제를 만드는 AI 작업(quiz_generate)을
 * 넣고, 앱이 세트나 작업을 조회할 때 끝난 작업의 결과를 세트에 옮긴다(따로 도는 반복 없이).
 * 남의 노트 · 세트는 없는 것과 같게 404로 답한다.
 */
@Injectable()
export class QuizSetsService {
  constructor(
    @InjectModel(QuizSet.name) private readonly sets: Model<QuizSetDocument>,
    @InjectModel(Material.name) private readonly materials: Model<MaterialDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    private readonly jobs: AiJobsService,
  ) {}

  /**
   * 노트로 맞춤 퀴즈 세트를 만든다. 응답 모양은 앱의 로컬 모의 API(quiz.createSet)와 같은 { quizSet, job }.
   * - 같은 노트에 만드는 중인 세트가 있으면 새로 만들지 않고 그 세트를 돌려준다(두 번 눌러도 한 번만 만듦).
   *   거의 동시에 두 번 와도 「노트마다 만드는 중인 세트 하나」 색인이 둘째를 막는다
   * - 노트의 미리 만들기(quiz_pregen)가 아직 끝나지 않았으면 새 작업 대신 이어받는다(#134 · #138)
   */
  async create(
    userId: string,
    materialId: string,
  ): Promise<{ quizSet: AppQuizSet; job: AppAiJob }> {
    const owner = objectId(userId, '노트');
    const material = await this.materials
      .findOne({ _id: objectId(materialId, '노트'), ownerId: owner, deletedAt: null })
      .lean<MaterialRow>();
    if (!material) throw notFound('노트');
    const pages = textPages(material.pages);
    // 같은 노트의 세트를 다른 요청이 먼저 만들었는데 그 세트가 이미 끝났으면(드묾) 한 번 더 만든다
    const made =
      (await this.createOnce(userId, owner, material, pages)) ??
      (await this.createOnce(userId, owner, material, pages));
    if (!made) throw new Error('quiz_sets: 같은 노트의 세트 만들기가 계속 겹침');
    return made;
  }

  /** 세트를 하나 만든다. 다른 요청과 겹쳐 돌려줄 세트가 없으면 null */
  private async createOnce(
    userId: string,
    owner: Types.ObjectId,
    material: MaterialRow,
    pages: { pageNo: number; ocrText: string }[],
  ): Promise<{ quizSet: AppQuizSet; job: AppAiJob } | null> {
    const existing = await this.generatingSet(owner, material._id);
    if (existing) {
      // 앱이 한 번 떠나 이어받기가 풀린 미리 만들기면 다시 이어받는다(사용자가 다시 기다린다)
      if (existing.job.type !== PREGEN_TYPE) return existing;
      const resumed = await this.jobs.takeOverPregen(userId, 'material', material._id.toString());
      return resumed?._id === existing.job._id ? { ...existing, job: resumed } : existing;
    }
    if (pages.length === 0) {
      throw new BadRequestException({
        code: VALIDATION_FAILED,
        message: '노트 글이 아직 없어요. 노트 정리가 끝난 뒤 다시 시도해 주세요',
      });
    }

    const setId = new Types.ObjectId();
    const job =
      (await this.jobs.takeOverPregen(userId, 'material', material._id.toString())) ??
      (await this.jobs.enqueue({
        type: GENERATE_TYPE,
        userId,
        targetType: 'quiz_set',
        targetId: setId.toString(),
        input: await this.generateInput(owner, material, pages),
      }));
    try {
      const created = await this.sets.create({
        _id: setId,
        ownerId: owner,
        materialId: material._id,
        folderId: material.folderId,
        source: 'ai_generated',
        sourceSetId: null,
        title: material.title,
        status: 'generating',
        progress: 0,
        questionCount: 0,
        questions: [],
        jobId: new Types.ObjectId(job._id),
      });
      return { quizSet: toAppSet(created.toObject<QuizSetRow>(), job.progress), job };
    } catch (e) {
      // 세트를 저장하지 못했으면 넣은 작업은 거둔다(이어받은 미리 만들기는 이어받기만 풀린다).
      // 같은 노트의 세트를 다른 요청이 먼저 만들었으면 그 세트를 돌려준다. 이때 이어받은 미리 만들기는
      // 먼저 만든 세트도 같은 작업을 이어받았으니 그대로 둔다
      const duplicate = isDuplicateKey(e);
      if (!(duplicate && job.type === PREGEN_TYPE)) await this.jobs.cancel(userId, job._id);
      if (!duplicate) throw e;
      return this.generatingSet(owner, material._id);
    }
  }

  /** 내 퀴즈 세트(최근 것부터). 만드는 중인 세트는 작업 결과를 먼저 옮긴다 */
  async list(userId: string): Promise<AppQuizSet[]> {
    const rows = await this.sets
      .find({ ownerId: objectId(userId, '퀴즈'), deletedAt: null })
      .sort({ createdAt: -1 })
      .lean<QuizSetRow[]>();
    return Promise.all(rows.map(async (row) => (await this.sync(row)).quizSet));
  }

  /** 세트 하나. 만드는 중이면 작업 결과를 먼저 옮긴다 */
  async findMine(userId: string, setId: string): Promise<AppQuizSet> {
    const row = await this.sets
      .findOne({ _id: objectId(setId, '퀴즈'), ownerId: objectId(userId, '퀴즈'), deletedAt: null })
      .lean<QuizSetRow>();
    if (!row) throw notFound('퀴즈');
    return (await this.sync(row)).quizSet;
  }

  /** 같은 노트의 만드는 중인 세트. 작업이 이미 끝났으면 결과를 옮기고, 그래도 만드는 중일 때만 돌려준다 */
  private async generatingSet(
    owner: Types.ObjectId,
    materialId: Types.ObjectId,
  ): Promise<{ quizSet: AppQuizSet; job: AppAiJob } | null> {
    const row = await this.sets
      .findOne({ ownerId: owner, materialId, status: 'generating', deletedAt: null })
      .lean<QuizSetRow>();
    if (!row) return null;
    const synced = await this.sync(row);
    return synced.quizSet.status === 'generating' && synced.job
      ? { quizSet: synced.quizSet, job: synced.job }
      : null;
  }

  /**
   * 만드는 중인 세트에 작업 결과를 옮긴다. 성공했으면 문제를 넣어 ready, 실패 · 취소면 failed.
   * 아직 처리 중이면 작업의 진행률만 응답에 담는다. 바꿀 때는 지금 상태일 때만 바꿔, 여러 요청이
   * 같이 옮겨도 한 번만 반영된다.
   * failed 세트도 작업이 나중에 성공했으면(ai-jobs의 다시 시도, 뒤에서 마저 만든 미리 만들기) ready로
   * 되살린다. 다시 만드는 중으로는 되돌리지 않는다(그 사이 같은 노트에 새 세트가 있을 수 있다).
   */
  private async sync(row: QuizSetRow): Promise<{ quizSet: AppQuizSet; job: AppAiJob | null }> {
    if (row.status === 'ready') return { quizSet: toAppSet(row), job: null };
    const job = row.jobId ? await this.findJob(row) : null;
    if (row.status === 'failed') {
      const ready = job?.status === 'succeeded' ? readyUpdate(job) : null;
      return ready ? this.settle(row, ready, job) : { quizSet: toAppSet(row), job };
    }
    if (job && (job.status === 'queued' || job.status === 'running')) {
      return { quizSet: toAppSet(row, job.progress), job };
    }
    // 작업이 없어졌거나 실패 · 취소, 또는 쓸 문제가 없음(처리기 result.questions가 [])
    const update = (job?.status === 'succeeded' ? readyUpdate(job) : null) ?? { status: 'failed' };
    return this.settle(row, update, job);
  }

  /** 세트가 아직 row.status일 때만 바꾼다(여러 요청이 같이 옮겨도 한 번만) */
  private async settle(
    row: QuizSetRow,
    update: Record<string, unknown>,
    job: AppAiJob | null,
  ): Promise<{ quizSet: AppQuizSet; job: AppAiJob | null }> {
    const updated = await this.sets
      .findOneAndUpdate(
        { _id: row._id, status: row.status },
        { $set: update },
        { returnDocument: 'after' },
      )
      .lean<QuizSetRow>();
    const current =
      updated ?? (await this.sets.findOne({ _id: row._id }).lean<QuizSetRow>()) ?? row;
    return { quizSet: toAppSet(current), job };
  }

  private async findJob(row: QuizSetRow): Promise<AppAiJob | null> {
    try {
      return await this.jobs.findMine(row.ownerId.toString(), row.jobId!.toString());
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }

  /**
   * 처리기 입력(apps/ai services/quiz/generate.py 「input」). 처리기는 다른 컬렉션을 읽지 않으므로
   * 이 노트 글 · 사용자의 다른 세트와 풀이 · 그 세트가 가리키는 노트 글을 모두 담는다.
   * 노트의 개념 이름(concepts) · 노트 조각(chunks)은 아직 저장하는 곳이 없어 넣지 않는다
   * (처리기가 개념을 새로 뽑는다).
   */
  private async generateInput(
    owner: Types.ObjectId,
    material: MaterialRow,
    pages: { pageNo: number; ocrText: string }[],
  ): Promise<Record<string, unknown>> {
    const sets = await this.sets
      .find({ ownerId: owner, deletedAt: null, status: 'ready' })
      .sort({ createdAt: -1 })
      .limit(INPUT_SET_LIMIT)
      .lean<QuizSetRow[]>();
    const withNote = sets.filter((s) => s.materialId);
    // 보내는 세트의 풀이만(지운 세트 · 보내지 않는 세트의 풀이는 처리기가 문제를 찾을 수 없다)
    const attempts = withNote.length
      ? await this.attempts
          .find({
            userId: owner,
            quizSetId: { $in: withNote.map((s) => s._id) },
            finishedAt: { $ne: null },
          })
          .lean<AttemptRow[]>()
      : [];
    const otherIds = [...new Set(withNote.map((s) => s.materialId!.toString()))].filter(
      (id) => id !== material._id.toString(),
    );
    const others = otherIds.length
      ? await this.materials
          .find({
            _id: { $in: otherIds.map((id) => new Types.ObjectId(id)) },
            ownerId: owner,
            deletedAt: null,
          })
          .lean<MaterialRow[]>()
      : [];
    return {
      day: seoulDay(new Date()),
      material: { id: material._id.toString(), title: material.title, pages },
      sets: withNote.map((s) => ({
        id: s._id.toString(),
        materialId: s.materialId!.toString(),
        questions: (s.questions ?? []).map(toWorkerQuestion),
      })),
      attempts: attempts.map((a) => ({
        id: a._id.toString(),
        quizSetId: a.quizSetId.toString(),
        finishedAt: a.finishedAt.toISOString(),
        answers: (a.answers ?? []).map((x) => ({
          questionId: x.questionId.toString(),
          correct: x.correct,
        })),
      })),
      notes: Object.fromEntries(others.map((m) => [m._id.toString(), textPages(m.pages)])),
    };
  }
}

/** 글이 있는 쪽만(정리 전 · 빈 쪽은 처리기가 문제를 낼 수 없다) */
function textPages(pages: PageRow[] | undefined): { pageNo: number; ocrText: string }[] {
  return (pages ?? [])
    .filter((p): p is PageRow & { ocrText: string } => !!p.ocrText?.trim())
    .map((p) => ({ pageNo: p.pageNo, ocrText: p.ocrText }));
}

/** 저장한 문제 → 처리기 입력의 문제(apps/ai services/quiz/review.py parse_question) */
function toWorkerQuestion(q: QuestionRow): Record<string, unknown> {
  return {
    id: q._id.toString(),
    order: q.order,
    prompt: q.prompt,
    choices: q.choices ?? null,
    answer: q.answer,
    ...(q.category ? { type: q.category } : {}),
    ...(q.passage ? { passage: q.passage } : {}),
    ...(q.explanation ? { explanation: q.explanation } : {}),
    conceptTags: q.conceptTags ?? [],
    srs: q.srs ?? null,
  };
}

/** 처리기 결과의 문제들. 모양이 틀린 문제는 빼고 쓴다 */
function workerQuestions(raw: unknown): QuestionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(fromWorkerQuestion).filter((q): q is QuestionRow => q !== null);
}

/** 성공한 작업의 결과로 세트를 ready로 바꾸는 값. 쓸 문제가 없으면 null(세트를 failed로) */
function readyUpdate(job: AppAiJob): Record<string, unknown> | null {
  const questions = workerQuestions(job.result?.['questions']);
  if (questions.length === 0) return null;
  const title = job.result?.['title'];
  return {
    status: 'ready',
    progress: 100,
    questions,
    questionCount: questions.length,
    ...(typeof title === 'string' && title ? { title } : {}),
  };
}
