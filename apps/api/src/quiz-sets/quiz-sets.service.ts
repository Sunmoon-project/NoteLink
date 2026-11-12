import { createHash } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, mongo, Types } from 'mongoose';

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
/**
 * 세트 하나의 문제 수. 처리기 입력 size로 보낸다(보내지 않으면 처리기 기본 10문제).
 * 처리기는 size개를 다 만들지 못하면 모자란 자리를 다시 돌리고, 그래도 모자라면 작업을 실패로
 * 끝낸다(generate.py _make_all · run, #247). 모자란 결과를 실패로 끝내는 일은 처리기 몫이다: 앱은
 * 작업 상태로 성공 · 다시 시도를 고르므로 여기서 세트만 failed로 두면 빈 성공 화면이 된다
 * (/code-review). 그래서 여기서는 받은 만큼 ready로 둔다
 */
export const QUIZ_SET_SIZE = 5;
const DUPLICATE_KEY = 11000;
/**
 * 처리기 입력에 넣는 지난 세트 수(최근 것부터). 세트 · 풀이가 쌓여도 ai_jobs 문서가 커지지 않게 한다
 * (MongoDB 문서 16MB 한도). 처리기는 이 세트들의 풀이로 아직 틀리는 쪽을 고른다
 */
export const INPUT_SET_LIMIT = 50;
/** 처리기 입력에 넣는 끝낸 풀이 수(최근 것부터). 세트 수와 함께 읽는 양을 묶는다(Codex 리뷰 #236) */
export const INPUT_ATTEMPT_LIMIT = 500;
/**
 * 처리기 입력 전체의 크기 한도(BSON 바이트). ai_jobs 문서는 MongoDB 16MB 한도 안이어야 하고, 처리기가
 * 같은 문서에 중간 결과(checkpoint) · 결과(result)도 쓰므로 절반만 입력에 쓴다(Codex 재리뷰 #236).
 * 넘으면 fitInput이 들어가지 않는 세트를 그 풀이 · 노트 글과 함께 뺀다
 */
export const INPUT_BYTE_LIMIT = 8 * 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
/** 문제 난이도(packages/shared QuestionDifficulty, #268) */
export type Difficulty = '하' | '중' | '상';
const DIFFICULTIES: readonly string[] = ['하', '중', '상'];
// apps/ai/app/services/quiz/similar.py의 유형만 집계해 작업 입력 크기를 제한한다.
const QUESTION_CATEGORIES = [
  '정의',
  '분류',
  '빈칸',
  '어휘',
  '특징',
  '부정설명',
  '묘사',
  '규칙',
  '조합',
];
const TYPE_STATS_TTL_MS = 60_000;
const difficultyOf = (v: unknown): Difficulty | null =>
  typeof v === 'string' && DIFFICULTIES.includes(v) ? (v as Difficulty) : null;

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
  difficulty: Difficulty | null;
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
  difficulty?: Difficulty | null;
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
  deletedAt?: Date | null;
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
  concepts?: string[];
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
    difficulty: q.difficulty ?? null,
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
    // 하 · 중 · 상이 아니면 null(난이도 하나 때문에 문제를 빼지 않음)
    difficulty: difficultyOf(q['difficulty']),
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

/**
 * 미리 만들기로 만든 세트를 지웠을 때 이어받는 새 세트의 id(setIdFor). 지운 세트의 id에서 늘 같은 값이
 * 나와 동시에 이어받는 요청들이 같은 id를 쓴다
 */
export function nextSetId(id: Types.ObjectId): Types.ObjectId {
  const digest = createHash('sha256').update(`quiz-set-after:${id.toHexString()}`).digest();
  return new Types.ObjectId(digest.subarray(0, 12).toString('hex'));
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
  private typeStatsCache?: { expiresAt: number; value: TypeStats };
  private typeStatsPending?: Promise<TypeStats>;
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
   * - 미리 만들기가 이미 끝났고 아직 세트로 쓰지 않았으면 새 작업 없이 그 결과로 바로 ready 세트를
   *   만든다(#274). 응답의 작업은 그 미리 만들기(succeeded)라 앱은 첫 조회에서 바로 퀴즈로 간다
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
    if (!pages.some(askable)) {
      throw new BadRequestException({
        code: VALIDATION_FAILED,
        message: `문제를 낼 만큼 읽은 글이 없어요. 읽은 글이 ${QUIZ_MIN_LINES}줄 이상인 쪽이 있어야 해요`,
      });
    }

    const takenOver = await this.jobs.takeOverPregen(userId, 'material', material._id.toString());
    const reused = takenOver ? null : await this.unusedPregen(userId, owner, material, pages);
    const setId = await this.setIdFor(takenOver ?? reused);
    const job =
      takenOver ??
      reused ??
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
        // 고유 색인(quiz-set.schema.ts)이 deletedAt이 null인 세트만 센다
        deletedAt: null,
      });
      const row = created.toObject<QuizSetRow>();
      if (!reused) return { quizSet: toAppSet(row, job.progress), job };
      // 끝난 작업이라 결과를 바로 옮겨 ready로(만드는 중으로 넣어 같은 노트의 고유 색인도 거친다)
      const synced = await this.sync(row);
      return { quizSet: synced.quizSet, job: synced.job ?? job };
    } catch (e) {
      // 세트를 저장하지 못했으면 넣은 작업은 거둔다(이어받은 미리 만들기는 이어받기만 풀린다).
      // 같은 노트의 세트를 다른 요청이 먼저 만들었으면 그 세트를 돌려준다. 이때 이어받은 미리 만들기는
      // 먼저 만든 세트도 같은 작업을 이어받았으니 그대로 둔다. 끝난 미리 만들기는 거둘 것이 없다
      const duplicate = isDuplicateKey(e);
      if (!reused && !(duplicate && job.type === PREGEN_TYPE)) {
        await this.jobs.cancel(userId, job._id);
      }
      if (!duplicate) throw e;
      if (job.type === PREGEN_TYPE) {
        // 같은 미리 만들기로 다른 요청이 먼저 세트를 만들었으면(이어받기 · 끝난 결과 쓰기 어느 쪽이든 같은
        // id) 그 세트를 돌려준다. 그 사이 작업이 끝났으면 결과를 옮긴 ready 세트다(Codex 리뷰 #276)
        const first = await this.sets
          .findOne({ _id: setId, ownerId: owner, deletedAt: null })
          .lean<QuizSetRow>();
        if (first) {
          const synced = await this.sync(first);
          return { quizSet: synced.quizSet, job: synced.job ?? job };
        }
      }
      return this.generatingSet(owner, material._id);
    }
  }

  /**
   * 새 세트의 id. 미리 만들기로 만드는 세트는(이어받기든 끝난 결과 쓰기든) 그 작업 id를 쓴다: 한 미리
   * 만들기로 세트가 둘 생기지 않게 _id 고유 색인이 막는다. 이어받은 요청이 세트를 넣기 전에 작업이 끝나
   * 다른 요청이 그 결과로 세트를 먼저 만들어도, 늦은 쪽은 같은 id에 막혀 먼저 만든 세트를 돌려준다
   * (Codex 리뷰 #276). 그 id의 세트를 지웠으면 그 id에서 정해지는 다음 id(nextSetId): 지운 세트는
   * 되살리지 않고, 다시 도는 미리 만들기를 새 세트가 이어받는다. 다음 id도 요청마다 같아서, 지운 뒤
   * 이어받는 요청들도 같은 id에 막혀 세트 하나를 같이 쓴다(Codex 재리뷰 #276). 지우지 않은 세트가
   * 있으면 그 id로 넣어 막히게 둔다(먼저 만든 세트를 돌려줌)
   */
  private async setIdFor(pregen: AppAiJob | null): Promise<Types.ObjectId> {
    if (!pregen) return new Types.ObjectId();
    let id = new Types.ObjectId(pregen._id);
    // 지운 세트마다 한 칸씩 간다. 칸마다 세트가 있어야 넘어가므로 지운 세트 수만큼만 돈다
    while ((await this.sets.findOne({ _id: id }).lean<QuizSetRow>())?.deletedAt) {
      id = nextSetId(id);
    }
    return id;
  }

  /**
   * 아직 세트로 쓰지 않은 끝난 미리 만들기(#274). 넣었던 노트 글이 지금과 같고, 쓸 문제가 있고,
   * 그 작업을 가리키는 세트가 없을 때만(지운 세트 포함: 지운 퀴즈를 되살리지 않는다).
   * 이어받아 만든 세트도 jobId로 그 작업을 가리키므로 같은 결과를 두 번 쓰지 않는다
   */
  private async unusedPregen(
    userId: string,
    owner: Types.ObjectId,
    material: MaterialRow,
    pages: WorkerPage[],
  ): Promise<AppAiJob | null> {
    const found = await this.jobs.finishedPregen(userId, 'material', material._id.toString());
    if (!found || !samePages(found.pages, pages) || !readyUpdate(found.job)) return null;
    const jobId = new Types.ObjectId(found.job._id);
    const used = await this.sets
      .findOne({ ownerId: owner, $or: [{ _id: jobId }, { jobId }] })
      .lean<QuizSetRow>();
    return used ? null : found.job;
  }

  /**
   * 노트의 첫 맞춤 퀴즈를 미리 만드는 작업(quiz_pregen)을 넣는다(#134 · #274). 노트 정리가 끝나면
   * 노트 API가 부른다(아직 NestJS에 노트 API가 없어 부르는 곳은 그때 붙인다).
   * 처리기는 사용자 작업에 LLM 차례를 양보하며 안정적으로 만들고, 사용자가 그 사이 퀴즈를 요청하면
   * create가 이어받거나(도는 중) 결과를 바로 쓴다(끝남).
   * 넣지 않을 때: 물을 수 있는 쪽이 없음(null) · 도는 미리 만들기나 아직 쓰지 않은 결과가 있음(그 작업) ·
   * 이 노트에 세트가 이미 있음(null, 첫 세트만 미리 만든다).
   * 알려진 한계: 확인과 넣기가 따로라 같은 노트에 거의 동시에 두 번 부르면 둘 다 넣을 수 있다
   * (노트 API는 정리가 끝날 때 한 번 부른다)
   */
  async pregenerate(userId: string, materialId: string): Promise<AppAiJob | null> {
    const owner = objectId(userId, '노트');
    const material = await this.materials
      .findOne({ _id: objectId(materialId, '노트'), ownerId: owner, deletedAt: null })
      .lean<MaterialRow>();
    if (!material) throw notFound('노트');
    const pages = textPages(material.pages);
    if (!pages.some(askable)) return null;
    const pending =
      (await this.jobs.activePregen(userId, 'material', materialId)) ??
      (await this.unusedPregen(userId, owner, material, pages));
    if (pending) return pending;
    const hasSet = await this.sets
      .findOne({ ownerId: owner, materialId: material._id, deletedAt: null })
      .lean<QuizSetRow>();
    if (hasSet) return null;
    return this.jobs.enqueue({
      type: PREGEN_TYPE,
      userId,
      targetType: 'material',
      targetId: materialId,
      // 첫 세트는 노트 내용만으로 만든다(지난 세트 · 풀이가 없는 새 노트, #134)
      input: fitInput({
        day: seoulDay(new Date()),
        size: QUIZ_SET_SIZE,
        material: materialInput(material, pages),
        sets: [],
        attempts: [],
        notes: {},
        typeStats: await this.typeStats(),
      }),
    });
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
    // 처리기가 뽑은 개념 이름은 세트를 ready로 바꾸기 전에 노트에 남긴다: 저장이 실패하면 세트도 그대로라
    // 다음 조회가 다시 옮기며 다시 저장한다(Codex 리뷰 #276). 같이 옮기는 요청이 모두 저장해도 같은 값
    if (update['status'] === 'ready' && job) await this.saveConcepts(row, job);
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

  /**
   * 처리기가 이번에 뽑은 개념 이름(result.concepts)을 노트에 저장한다(#134 · #274). 다음 퀴즈 입력에
   * 넣으면 처리기가 개념 뽑기(쪽마다 LLM 호출, 70~90초)를 건너뛴다. 처리기는 입력에 개념이 있으면
   * 새로 뽑지 않고 concepts를 null로 돌려주므로(generate.py run의 new_names), 그때는 노트 값을 그대로 둔다
   */
  private async saveConcepts(row: QuizSetRow, job: AppAiJob): Promise<void> {
    const names = job.result?.['concepts'];
    if (!row.materialId || !Array.isArray(names) || names.length === 0) return;
    if (!names.every((n): n is string => typeof n === 'string' && n.trim() !== '')) return;
    await this.materials
      .findOneAndUpdate(
        { _id: row.materialId, ownerId: row.ownerId, deletedAt: null },
        { $set: { concepts: names } },
      )
      .lean();
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
   * 노트의 개념 이름(concepts)은 지난 퀴즈 · 미리 만들기가 저장했으면 넣는다(처리기가 다시 뽑지 않음).
   * 노트 조각(chunks)은 아직 저장하는 곳이 없어 넣지 않는다.
   */
  private async generateInput(
    owner: Types.ObjectId,
    material: MaterialRow,
    pages: { pageNo: number; ocrText: string }[],
  ): Promise<WorkerInput> {
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
          .sort({ finishedAt: -1 })
          .limit(INPUT_ATTEMPT_LIMIT)
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
    // 개념 이름은 다시 읽는다: create가 노트를 읽은 뒤 같은 노트의 직전 세트를 옮기며(generatingSet)
    // 개념을 저장했을 수 있다(Codex 리뷰 #276)
    const fresh = await this.materials
      .findOne({ _id: material._id, ownerId: owner }, { concepts: 1 })
      .lean<Pick<MaterialRow, 'concepts'>>();
    return fitInput({
      day: seoulDay(new Date()),
      size: QUIZ_SET_SIZE,
      material: materialInput(
        { ...material, concepts: fresh?.concepts ?? material.concepts },
        pages,
      ),
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
      typeStats: await this.typeStats(),
    });
  }

  /** 모든 사용자의 완료된 풀이에서 문제 유형별 수치만 집계한다. 개인의 풀이 내용은 반환하지 않는다. */
  private async typeStats(): Promise<TypeStats> {
    if (this.typeStatsCache && this.typeStatsCache.expiresAt > Date.now())
      return this.typeStatsCache.value;
    if (this.typeStatsPending) return this.typeStatsPending;
    const pending = this.readTypeStats();
    this.typeStatsPending = pending;
    try {
      const value = await pending;
      this.typeStatsCache = { value, expiresAt: Date.now() + TYPE_STATS_TTL_MS };
      return value;
    } finally {
      if (this.typeStatsPending === pending) this.typeStatsPending = undefined;
    }
  }

  private async readTypeStats(): Promise<TypeStats> {
    const rows = await this.attempts.aggregate<{ _id: string; answered: number; correct: number }>([
      { $match: { finishedAt: { $type: 'date' } } },
      { $unwind: '$answers' },
      {
        $match: {
          'answers.correct': { $type: 'bool' },
          $nor: [{ 'answers.void': true }, { 'answers.void': { $type: 'string', $ne: '' } }],
        },
      },
      // 같은 풀이에 같은 문제가 중복 기록돼도 한 번만 센다.
      {
        $group: {
          _id: { attempt: '$_id', questionId: '$answers.questionId' },
          quizSetId: { $first: '$quizSetId' },
          correct: { $first: '$answers.correct' },
        },
      },
      {
        $lookup: {
          from: 'quiz_sets',
          let: { setId: '$quizSetId', questionId: '$_id.questionId' },
          pipeline: [
            { $match: { status: 'ready', deletedAt: null, $expr: { $eq: ['$_id', '$$setId'] } } },
            { $unwind: '$questions' },
            {
              $match: {
                $expr: { $eq: ['$questions._id', '$$questionId'] },
                'questions.category': { $in: QUESTION_CATEGORIES },
              },
            },
            { $project: { _id: 0, category: '$questions.category' } },
          ],
          as: 'question',
        },
      },
      { $unwind: '$question' },
      {
        $group: {
          _id: '$question.category',
          answered: { $sum: 1 },
          correct: { $sum: { $cond: ['$correct', 1, 0] } },
        },
      },
    ]);
    return Object.fromEntries(
      rows.map((row) => [row._id, { answered: row.answered, correct: row.correct }]),
    );
  }
}

type WorkerPage = { pageNo: number; ocrText: string };
type WorkerMaterial = { id: string; title: string; pages: WorkerPage[]; concepts?: string[] };
type TypeStats = Record<string, { answered: number; correct: number }>;

/** 처리기 입력의 노트(generate.py _material). 개념 이름은 저장된 것이 있을 때만 */
function materialInput(material: MaterialRow, pages: WorkerPage[]): WorkerMaterial {
  const concepts = (material.concepts ?? []).filter((c) => typeof c === 'string' && c.trim());
  return {
    id: material._id.toString(),
    title: material.title,
    pages,
    ...(concepts.length > 0 ? { concepts } : {}),
  };
}

/** 미리 만들기에 넣었던 노트 글이 지금과 같은지(쪽 번호 · 글이 모두 같음) */
function samePages(a: WorkerPage[], b: WorkerPage[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.pageNo === b[i]!.pageNo && p.ocrText === b[i]!.ocrText)
  );
}

/** 처리기 입력(apps/ai services/quiz/generate.py 「input」) */
export interface WorkerInput extends Record<string, unknown> {
  day: string;
  size: number;
  material: WorkerMaterial;
  /** 최근 것부터 */
  sets: { id: string; materialId: string; questions: Record<string, unknown>[] }[];
  attempts: { quizSetId: string }[];
  notes: Record<string, WorkerPage[]>;
  typeStats?: TypeStats;
}

/** 키 하나 아래에 둔 값의 BSON 크기. 키는 노트 id(24자)나 배열 번호(3자리까지)라 실제보다 조금 크게 잰다 */
const bsonBytes = (key: string, value: unknown) => mongo.BSON.calculateObjectSize({ [key]: value });
const ITEM_KEY = '999';

/**
 * 처리기 입력을 limit 바이트(BSON) 안으로 줄인다. 최근 세트부터 넣고, 그 세트의 풀이와 가리키는 노트 글이
 * 함께 들어가지 않으면 그 세트만 건너뛴다(처리기는 세트의 문제를 노트 글에서 찾고, 풀이는 세트의 문제를
 * 가리켜 셋을 같이 넣거나 같이 뺀다). 크기는 조금 크게 재므로 결과는 늘 limit 안이다.
 * 이번 노트만으로 넘으면 퀴즈를 만들 수 없어 400
 */
export function fitInput(input: WorkerInput, limit = INPUT_BYTE_LIMIT): WorkerInput {
  let total = mongo.BSON.calculateObjectSize({ ...input, sets: [], attempts: [], notes: {} });
  if (total > limit) {
    throw new BadRequestException({
      code: VALIDATION_FAILED,
      message: '노트가 너무 길어 퀴즈를 만들 수 없어요. 노트를 나눠 올려 주세요',
    });
  }
  const attemptBytes = new Map<string, number>();
  for (const a of input.attempts) {
    attemptBytes.set(a.quizSetId, (attemptBytes.get(a.quizSetId) ?? 0) + bsonBytes(ITEM_KEY, a));
  }
  const setIds = new Set<string>();
  const noteIds = new Set<string>();
  for (const set of input.sets) {
    const note = input.notes[set.materialId];
    const noteSize = note && !noteIds.has(set.materialId) ? bsonBytes(set.materialId, note) : 0;
    const size = bsonBytes(ITEM_KEY, set) + (attemptBytes.get(set.id) ?? 0) + noteSize;
    if (total + size > limit) continue;
    total += size;
    setIds.add(set.id);
    if (note) noteIds.add(set.materialId);
  }
  if (setIds.size === input.sets.length) return input;
  return {
    ...input,
    sets: input.sets.filter((x) => setIds.has(x.id)),
    attempts: input.attempts.filter((x) => setIds.has(x.quizSetId)),
    notes: Object.fromEntries(Object.entries(input.notes).filter(([id]) => noteIds.has(id))),
  };
}

/** 처리기가 문제를 내는 쪽의 최소 줄 수(apps/ai services/quiz/generate.py MIN_LINES) */
export const QUIZ_MIN_LINES = 5;

/**
 * 처리기가 문제를 낼 수 있는 쪽인지. 처리기는 빈 줄 · 확실하지 않은 [?] 낱말이 있는 줄을 빼고
 * (apps/ai services/quiz/text.py clean_pages) QUIZ_MIN_LINES줄 이상 남은 쪽에서만 묻는다(allocate).
 * 그런 쪽이 없으면 처리기는 작업을 실패로 끝내므로(generate.py NO_TEXT), 작업을 넣기 전에 400으로 알린다.
 * 노트 조각(chunks)은 아직 보내지 않아 처리기도 쪽 글만 쓴다. 조각을 보내면 처리기 note_pages와 맞춘다.
 * 그 밖의 0문제(초안이 모두 탈락 · 시간 상한)도 처리기가 다시 시도하지 않고 작업을 실패로 끝낸다
 * (NO_QUESTIONS). LLM 장애로 한 문제도 못 만들 때만 처리기가 작업을 다시 시도한다
 */
function askable(page: WorkerPage): boolean {
  const lines = page.ocrText
    .split('\n')
    .filter((ln) => !PY_SPACE_ONLY.test(ln) && !ln.includes('[?]'));
  return lines.length >= QUIZ_MIN_LINES;
}

/** Python str.strip()이 지우는 글자(str.isspace)만으로 된 줄. JS trim()과는 몇 글자가 달라 따로 둔다 */
const PY_SPACE_ONLY =
  // eslint-disable-next-line no-control-regex -- Python isspace가 공백으로 보는 제어 글자 0x1C~0x1F
  /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/;

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
    ...(q.difficulty ? { difficulty: q.difficulty } : {}),
    srs: q.srs ?? null,
  };
}

/** 처리기 결과의 문제들. 모양이 틀린 문제는 빼고 쓴다 */
function workerQuestions(raw: unknown): QuestionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(fromWorkerQuestion).filter((q): q is QuestionRow => q !== null);
}

/**
 * 성공한 작업의 결과로 세트를 ready로 바꾸는 값. 쓸 문제가 없으면 null(세트를 failed로).
 * 모양이 틀린 문제를 빼면 번호가 비므로 처리기의 order 차례대로 1부터 다시 매긴다(/code-review)
 */
function readyUpdate(job: AppAiJob): Record<string, unknown> | null {
  const sorted = workerQuestions(job.result?.['questions']).sort((a, b) => a.order - b.order);
  const questions = sorted.map((q, i) => ({
    ...q,
    order: i + 1,
  }));
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
