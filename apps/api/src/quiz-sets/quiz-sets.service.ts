import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES } from '@notelink/shared';
import { Model, mongo, Types } from 'mongoose';

import { type AppAiJob, AiJobsService, PREGEN_TYPE } from '../ai-jobs/ai-jobs.service.js';
import { Folder, type FolderDocument } from '../modules/content/schemas/folder.schema.js';
import { Material, type MaterialDocument } from '../modules/content/schemas/material.schema.js';
import {
  QuizAttempt,
  type QuizAttemptDocument,
} from '../modules/quiz/schemas/quiz-attempt.schema.js';
import { QuizSet, type QuizSetDocument } from '../modules/quiz/schemas/quiz-set.schema.js';
import { RecordingNotePagesService } from './recording-note-pages.service.js';

/** 노트 · 세트가 없거나 남의 것일 때(packages/shared ERROR_CODES.NOT_FOUND) */
export const NOT_FOUND = 'NOT_FOUND';
/** 요청 형식 오류(packages/shared ERROR_CODES.VALIDATION) */
export const VALIDATION_FAILED = 'VALIDATION_FAILED';

/** 맞춤 퀴즈 작업(apps/ai services/quiz/generate.py TYPE) */
export const GENERATE_TYPE = 'quiz_generate';
/** 틀린 문제와 비슷한 문제 만들기 = 오답 복습 작업(apps/ai services/quiz/review.py TYPE). 결과는 reviewQuestions */
export const SIMILAR_TYPE = 'similar_quiz';
/** 오늘의 복습(apps/ai services/quiz/today.py TYPE). 결과는 questions(복습 상태를 가진 사본) · baseSetId */
export const TODAY_TYPE = 'today_review';
/** 결과로 복습 상태(srsUpdates) · 무효 풀이(voidAnswers)를 옮기는 작업 */
const REVIEW_TYPES: readonly string[] = [SIMILAR_TYPE, TODAY_TYPE];
/** 개념 카드 작업(apps/ai services/quiz/flashcards.py TYPE, #558). 결과는 플래시카드 목록을 열 때 옮긴다 */
export const CARDS_TYPE = 'quiz_flashcards';
/** 퀴즈 세트를 대상(targetType 'quiz_set')으로 넣는 작업. 세트를 지우면 같이 취소한다(#602) */
export const SET_JOB_TYPES: readonly string[] = [
  GENERATE_TYPE,
  SIMILAR_TYPE,
  TODAY_TYPE,
  CARDS_TYPE,
];
/**
 * 세트가 ready가 되면 개념 카드 작업을 넣는 작업: 맞춤 퀴즈 · 미리 만들기(#558). 오답 복습 · 오늘의 복습은
 * 기존 범위를 다시 묻는 것이라 만들지 않는다
 */
const CARD_TYPES: readonly string[] = [GENERATE_TYPE, PREGEN_TYPE];
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
  /**
   * 세트를 끝까지 푼 풀이(finishedAt)가 있으면 true, 없으면 넣지 않는다(withCompleted). 세트 목록 · 오늘의 복습
   * 응답만 채운다(세트 하나 조회 등은 넣지 않음). 오늘의 복습 카드는 다시 풀게 하지 않고 마쳤다고 보여 주고,
   * 퀴즈 탭 맨 위 카드는 이 세트를 건너뛴다(#561)
   */
  completed?: boolean;
  /**
   * 세트를 시작한 풀이가 있으면(끝내지 않았어도) true, 없으면 넣지 않는다(withCompleted). 풀기 화면에 들어가면
   * 풀이가 생기므로 「들어간 적 있음」 뜻이다. 퀴즈 탭 맨 위 카드는 들어간 세트를 건너뛴다(#593)
   */
  started?: boolean;
  /** 오늘의 복습 세트만: 그 복습 날짜(서울 YYYY-MM-DD, seoulDay). 다른 세트는 null(#561) */
  reviewDay: string | null;
  /**
   * 끝낸 세트만: 마지막으로 끝낸 풀이에서 틀린 문제 id(무효 풀이 제외, withCompleted). 세트 목록 · 오늘의 복습 응답만
   * 채운다. 유사 퀴즈 고르기(#605)가 틀린 문제를 처음부터 체크해 둔다
   */
  wrongQuestionIds?: string[];
}

/** 끝낸 풀이에서 틀린 문제를 읽을 만큼(withCompleted · 유사 퀴즈 고르기) */
export interface FinishedRow {
  _id: Types.ObjectId;
  quizSetId: Types.ObjectId;
  finishedAt: Date;
  answers?: { questionId: Types.ObjectId; correct: boolean; void?: boolean | string }[];
}

/** 그 풀이에서 틀린 문제 id. 무효 풀이(결함 문제, 오늘의 복습이 정함)는 틀린 것으로 보지 않는다 */
export const wrongIdsOf = (a: Pick<FinishedRow, 'answers'>): string[] =>
  (a.answers ?? []).filter((x) => !x.correct && !x.void).map((x) => x.questionId.toString());

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
  srsAttemptId?: Types.ObjectId;
  checked?: boolean;
}

/** DB에서 읽은 세트 한 줄(lean) */
export interface QuizSetRow {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  materialId?: Types.ObjectId;
  folderId?: Types.ObjectId;
  sourceSetId?: Types.ObjectId | null;
  sourceAttemptId?: Types.ObjectId | null;
  srsSavedAt?: Date | null;
  followUpPending?: boolean;
  cardsPending?: boolean;
  reviewDay?: string | null;
  title: string;
  status: 'generating' | 'ready' | 'failed';
  progress?: number;
  questionCount?: number;
  questions?: QuestionRow[];
  jobId?: Types.ObjectId | null;
  /** 앱이 이 세트를 취소한 시각(#642). 없으면 취소하지 않은 세트 */
  cancelRequestedAt?: Date;
  /** 앱의 취소가 이 세트를 기다리던 작업을 멈춘 시각(Codex #643 6차). 없으면 멈추지 않음 */
  cancelStoppedAt?: Date;
  deletedAt?: Date | null;
  createdAt: Date;
}

export interface PageRow {
  pageNo: number;
  ocrText?: string | null;
}

interface MaterialRow {
  _id: Types.ObjectId;
  folderId: Types.ObjectId;
  title: string;
  pages?: PageRow[];
  concepts?: string[];
  /** 노트 종류. 녹음 노트(recording)는 pages 가 없고 대본이 녹음 정리 작업 결과에 있다. 없는 옛 노트는 필기처럼 본다 */
  kind?: string;
  processing?: { status?: string; jobId?: Types.ObjectId | null };
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
    reviewDay: row.reviewDay ?? null,
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
    // 만들 때 '정답 둘' 검사를 통과한 문제(맞춤 퀴즈 generate.py, #625). 처음 복습 상태에 checked로 옮겨 오늘의 복습이
    // 다시 검사하지 않게 한다. 표시가 없는 문제(옛 문제 · 검사가 애매해 남겨 둔 초안으로 채운 문제)는 그대로 검사한다
    ...(q['checked'] === true ? { checked: true } : {}),
  };
}

export const notFound = (what: string) =>
  new NotFoundException({ code: NOT_FOUND, message: `${what}을 찾을 수 없어요` });

/** 앱이 보낸 id. 형식이 틀리면 없는 것과 같게 404 */
export function objectId(id: string, what: string): Types.ObjectId {
  if (!OBJECT_ID.test(id)) throw notFound(what);
  return new Types.ObjectId(id);
}

/**
 * 미리 만들기로 만든 세트를 지웠을 때 이어받는 새 세트의 id(setIdFor). 지운 세트의 id에서 늘 같은 값이
 * 나와 동시에 이어받는 요청들이 같은 id를 쓴다
 */
/**
 * 세트의 개념 카드 작업 id(#558). 세트 id에서 늘 같은 값이 나와 같은 세트의 카드 작업은 하나만 넣을 수 있다
 * (_id 고유 색인). nextSetId와 같은 방식(다른 접두어)
 */
export function cardsJobId(setId: Types.ObjectId): Types.ObjectId {
  const digest = createHash('sha256').update(`flashcards-job:${setId.toHexString()}`).digest();
  return new Types.ObjectId(digest.subarray(0, 12).toString('hex'));
}

export function nextSetId(id: Types.ObjectId): Types.ObjectId {
  const digest = createHash('sha256').update(`quiz-set-after:${id.toHexString()}`).digest();
  return new Types.ObjectId(digest.subarray(0, 12).toString('hex'));
}

/**
 * 앱이 취소한 세트(cancelRequestedAt, #642)의 작업이 그 세트의 취소로 멈췄는지: 그 세트에 멈춤 표시(cancelStoppedAt)가
 * 있거나 작업이 canceled다. 작업이 없으면 옮길 결과도 없어 true. 취소가 닿기 전에 끝난 작업(늦은 취소)은 false.
 * 미리 만들기는 취소가 멈추지 않고 이어받기만 풀어(awaited=false, AiJobsService.stop) 그 표시가 작업 하나에 하나라, 같은
 * 미리 만들기를 다른 세트가 다시 이어받은 뒤 옛 취소가 늦게 푼 것과 이 세트의 취소가 푼 것을 가릴 수 없다(Codex #643 6차).
 * 그래서 이 세트의 취소가 멈춘 직후 그 세트에 적는 cancelStoppedAt으로 본다(cancelWaiting). 맞춤 퀴즈 작업은 세트 하나만
 * 기다려 canceled가 곧 그 세트의 취소다
 */
export function canceledFirst(
  job: Pick<AppAiJob, 'status'> | null,
  stoppedAt?: Date | null,
): boolean {
  if (!job || stoppedAt) return true;
  return job.status === 'canceled';
}

/**
 * 취소 표시가 적힌 지 이만큼 지나야 끝난 작업이라는 이유만으로 세트를 지운다(#644). 그 전에는 표시를 적은 취소 요청이 아직
 * 늦은 취소인지 가리는 중일 수 있다(표시를 적고 → 멈춰 보고 → 늦었으면 거둠, 한 요청 안 ms 단위). 요청이 중간에 죽어
 * 남은 표시는 이 시간 뒤 조회가 정리한다
 */
export const CANCEL_SETTLE_GRACE_MS = 30_000;

/**
 * 같은 노트 다시 만들기(createOnce)가 처리 중인 취소(방금 적힌 표시 + 아직 도는 작업)를 만나면 그 취소가 끝나기를
 * 기다리는 최대 시간과 다시 읽는 간격(Codex #643 4차). 취소 요청 한 건은 ms 단위라 1초면 거의 늘 끝난다
 */
export const CANCEL_WAIT_MS = 1_000;
export const CANCEL_WAIT_STEP_MS = 200;

/** 아직 도는 작업인지(queued · running) */
const isActive = (job: Pick<AppAiJob, 'status'>) =>
  job.status === 'queued' || job.status === 'running';

/**
 * 취소 표시(cancelRequestedAt)가 남은 세트를 지울 때인지(#642): 작업이 없거나 그 세트의 취소로 멈췄으면
 * (canceledFirst, cancelStoppedAt) 바로, 끝난 작업(succeeded · failed · canceled)이면 표시가 적힌 지 CANCEL_SETTLE_GRACE_MS 뒤에(#644).
 * 취소 요청은 늦은 취소(작업이 먼저 끝남)면 표시를 거두므로, 끝난 작업에 오래 남은 표시는 앞 취소가 작업을 멈춘 뒤 세트를
 * 지우지 못했거나 요청이 중간에 죽은 것이다 — 미리 만들기의 이어받기 표시(awaited)는 겹친 요청이 다시 켜고 끌 수 있어
 * 판단에 쓰지 않는다(Codex 2차 · 6차, 그 세트의 멈춤 표시 cancelStoppedAt을 본다). 방금 적힌 표시는 그 취소가 아직 늦은 취소인지 가리는 중일 수
 * 있어 기다린다(Codex #643 3차: 그 사이 조회가 지우면 늦은 취소가 지켜야 할 완성된 세트를 잃음). 아직 도는 작업은 그
 * 취소가 아직 진행 중일 수 있어 기다린다
 */
export function cancelSettled(
  job: Pick<AppAiJob, 'status'> | null,
  set: { cancelRequestedAt: Date; cancelStoppedAt?: Date | null },
  now: Date = new Date(),
): boolean {
  if (!job || canceledFirst(job, set.cancelStoppedAt)) return true;
  if (isActive(job)) return false;
  return now.getTime() - new Date(set.cancelRequestedAt).getTime() >= CANCEL_SETTLE_GRACE_MS;
}

export const isDuplicateKey = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === DUPLICATE_KEY;

/**
 * 맞춤 퀴즈 세트 만들기 · 조회(#175). 세트를 만들면 FastAPI 처리기가 문제를 만드는 AI 작업(quiz_generate)을
 * 넣고, 앱이 세트나 작업을 조회할 때 끝난 작업의 결과를 세트에 옮긴다(따로 도는 반복 없이).
 * 남의 노트 · 세트는 없는 것과 같게 404로 답한다.
 */
@Injectable()
export class QuizSetsService implements OnModuleInit {
  private typeStatsCache?: { expiresAt: number; value: TypeStats };
  private typeStatsPending?: Promise<TypeStats>;
  constructor(
    @InjectModel(QuizSet.name) private readonly sets: Model<QuizSetDocument>,
    @InjectModel(Material.name) private readonly materials: Model<MaterialDocument>,
    @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
    private readonly jobs: AiJobsService,
    /** 녹음 노트의 대본을 퀴즈 입력 쪽으로(FR-38). 필기 노트는 쓰지 않는다 */
    private readonly recordingPages: RecordingNotePagesService,
    /** 세트를 넣은 뒤 노트의 학습 폴더가 지워졌는지 읽기만 한다(folderGone, #602) */
    @InjectModel(Folder.name) private readonly folders: Model<FolderDocument>,
  ) {}

  /**
   * 오답 복습 세트에 처리기 결과를 옮긴 뒤(세트마다 한 번) 부른다. SimilarQuizService가 넣는다: 그 작업을 기다리는
   * 사이 같은 퀴즈를 또 끝낸 풀이를 이어 받는다(같은 노트로 만드는 중인 세트는 하나라 그때 넣지 못함).
   * 주입 대신 넣는 이유: SimilarQuizService가 이 서비스를 받으므로 서로 받으면 순환 의존
   */
  afterReview?: (row: QuizSetRow) => Promise<unknown>;
  /** ms만큼 기다린다(dropCanceled). 시험이 바꿔 끼운다 */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  private readonly logger = new Logger(QuizSetsService.name);

  /** 앱이 맞춤 퀴즈 · 이어받은 미리 만들기를 취소하면 기다리던 세트를 지우도록 ai-jobs에 등록한다(#626) */
  onModuleInit(): void {
    for (const type of [GENERATE_TYPE, PREGEN_TYPE]) {
      this.jobs.registerCancelHandler(type, (ctx) => this.cancelWaiting(ctx));
    }
  }

  /**
   * 앱의 취소(AiJobsService.cancelByUser, #626): 작업을 멈추고, 그 작업을 기다리던 세트를 지운다(소프트 삭제 deletedAt).
   * 문제가 없는 failed 세트가 남지 않게 한다.
   * - 지울 세트는 멈추기 전에 고른다: 멈춘 뒤 다른 요청이 같은 미리 만들기를 새 세트로 다시 이어받아도 그 세트는 고르지
   *   않는다(createOnce는 이어받기가 풀린 세트를 돌려주지 않고 새 세트를 만든다)
   * - 멈춘 뒤 작업이 이 취소로 멈춘 상태일 때만 지운다: 취소가 닿기 전에 끝난 작업(늦은 취소)의 세트는 그대로 두고,
   *   그사이 다른 요청이 미리 만들기를 다시 이어받았으면(이어받기가 다시 켜짐) 지우지 않는다
   * - 미리 만들기는 뒤에서 계속 돌고, 다 만들면 다음 퀴즈 요청이 결과를 쓴다(unusedPregen은 지운 미완성 세트를 세지 않음)
   * - 앱이 세트 번호(quizSetId, #642)를 실으면 그 세트만 고른다. 남의 세트 · 이 작업을 기다리지 않는 세트는 404. 그 세트를
   *   이미 지웠거나 ready면 작업도 멈추지 않는다: 같은 미리 만들기를 새 세트가 다시 이어받았을 수 있어, 다시 온 옛 취소가
   *   새 세트의 이어받기를 풀거나 새 세트를 지우지 않게. 번호가 없으면(옛 앱) 이 작업을 기다리던 세트를 모두 고른다
   * - 고른 세트에 취소 표시(cancelRequestedAt)를 멈추기 전에 적는다: 지우다 실패한 채 작업이 끝나도 다음 조회(sync)가
   *   결과를 옮기지 않고 지운다(cancelSettled). 이 취소가 작업을 멈추지 못했으면(늦은 취소) 이번에 적은 표시를 거둔다.
   *   표시는 처음 적힌 시각을 지킨다($min, #644)
   * - 멈춘 뒤 취소하지 않은 다른 만드는 중 세트가 그 미리 만들기를 기다리면 이어받기를 되살린다(keepAwaited)
   * 여러 번 불려도 같다. 앞 호출이 지우다 실패했으면 다시 취소할 때 마저 지운다(작업이 그사이 끝났어도: 앞 표시가 남음).
   * 단 작업이 그 취소로 멈춘 흔적이 없고 앞 표시가 30초 안이면 앞 요청이 아직 처리 중일 수 있어 그 표시를 그대로 두고,
   * 30초 뒤 조회가 지운다(#644)
   */
  private async cancelWaiting(ctx: {
    userId: string;
    jobId: string;
    quizSetId?: string;
    cancel: () => Promise<boolean>;
  }): Promise<void> {
    const ownerId = objectId(ctx.userId, '퀴즈');
    const jobId = objectId(ctx.jobId, '퀴즈');
    const waiting = await this.waitingSets(ownerId, jobId, ctx.quizSetId);
    if (waiting.length === 0 && ctx.quizSetId !== undefined) return;
    const ids = waiting.map((w) => w._id);
    // 이 요청이 적는 표시 시각. 이미 표시가 있으면 더 이른(처음) 시각을 남긴다($min): 다시 취소해도 30초 유예가 다시
    // 시작되지 않고(#644), 늦은 취소는 이 시각 그대로인 표시만 거둔다(다른 요청이 적은 표시는 건드리지 않음)
    const mark = new Date();
    if (ids.length > 0) {
      const marked = await this.sets.updateMany(
        { _id: { $in: ids }, ownerId, status: { $ne: 'ready' }, deletedAt: null },
        { $min: { cancelRequestedAt: mark } },
      );
      // 고른 뒤 그 세트를 같은 취소의 다른 요청이 지웠거나 ready가 됐으면 작업도 멈추지 않는다: 그사이 새 세트가 같은
      // 미리 만들기를 이어받았을 수 있다(Codex 1차)
      if (ctx.quizSetId !== undefined && marked.matchedCount === 0) return;
    }
    if (!(await ctx.cancel())) {
      // 이 취소가 멈추지 못함(작업이 이미 끝남). 앞 취소가 멈춘 작업이면 마저 지운다: 그 세트의 멈춤 표시나 맞춤 퀴즈 작업의
      // canceled(canceledFirst — 미리 만들기의 이어받기 풀림은 다른 세트의 옛 취소일 수 있어 보지 않음, Codex 6차)가 있거나,
      // 앞 취소의 표시가 30초 넘게 남은 세트(앞 취소가 멈춘 뒤 지우다 실패했거나 요청이 죽음 — 늦은 취소는 표시를 거두므로,
      // Codex 2차 · cancelSettled). 방금 적힌 앞 표시는 그 요청이 아직 늦은 취소인지 가리는 중일 수 있어 그 요청에 맡긴다
      // (#644: 두 번 누른 늦은 취소가 세트를 지우지 않게. 앞 취소가 지우다 실패한 것이면 30초 뒤 조회가 지운다).
      // 그 밖은 늦은 취소라 세트를 그대로 두고 이 요청이 적은 표시만 거둔다(code-review)
      const job = await this.jobs.findMine(ctx.userId, ctx.jobId);
      const drop = waiting
        .filter(
          (w) =>
            canceledFirst(job, w.stoppedAt) ||
            (w.markedAt &&
              cancelSettled(job, { cancelRequestedAt: w.markedAt, cancelStoppedAt: w.stoppedAt })),
        )
        .map((w) => w._id);
      const keep = ids.filter((id) => !drop.includes(id));
      if (keep.length > 0) {
        await this.sets.updateMany(
          { _id: { $in: keep }, ownerId, cancelRequestedAt: mark },
          { $unset: { cancelRequestedAt: '' } },
        );
      }
      if (drop.length > 0) await this.dropSets(ctx.userId, drop);
      return;
    }
    // 이 취소가 작업을 멈췄다고 고른 세트에 적는다(Codex 6차): 지우다 실패한 채 작업이 끝나도 그 세트의 취소가 멈춘 것으로
    // 바로 지운다(canceledFirst). 미리 만들기의 이어받기 풀림은 작업 하나에 하나라 세트를 가리지 못한다
    if (ids.length > 0) {
      await this.sets.updateMany(
        { _id: { $in: ids }, ownerId, status: { $ne: 'ready' }, deletedAt: null },
        { $min: { cancelStoppedAt: new Date() } },
      );
    }
    await this.dropSets(ctx.userId, ids);
    await this.keepAwaited(ownerId, jobId);
  }

  /**
   * 이 작업을 기다리는, 취소하지 않은 만드는 중 세트가 있으면 미리 만들기의 이어받기를 다시 켠다(Codex 1차). 같은 세트의 취소
   * 두 건이 겹쳐 한쪽이 세트를 지운 뒤 새 세트가 다시 이어받으면, 늦게 도는 쪽의 stop이 새 세트의 이어받기를 풀 수 있어서다.
   * 새 세트를 넣기 전에 풀린 경우는 넣는 쪽이 넣은 뒤 다시 켠다(createOnce). 미리 만들기가 아니거나 끝났으면 바꾸지 않는다
   */
  private async keepAwaited(ownerId: Types.ObjectId, jobId: Types.ObjectId): Promise<void> {
    const other = await this.sets
      .findOne(
        { ownerId, jobId, status: 'generating', deletedAt: null, cancelRequestedAt: null },
        { _id: 1 },
      )
      .lean();
    if (other) await this.jobs.awaitAgain(ownerId.toHexString(), jobId.toHexString());
  }

  /**
   * 앱의 취소가 정리할 세트(cancelWaiting). quizSetId가 있으면 그 세트 하나: 내 세트이고 이 작업을 가리켜야 하며(아니면
   * 404) 아직 지우지 않았고 ready가 아닐 때만 고른다. 없으면 이 작업을 기다리는 아직 ready가 아닌 내 세트 모두
   */
  private async waitingSets(
    ownerId: Types.ObjectId,
    jobId: Types.ObjectId,
    quizSetId: string | undefined,
  ): Promise<{ _id: Types.ObjectId; markedAt?: Date; stoppedAt?: Date }[]> {
    const pick = (r: Pick<QuizSetRow, '_id' | 'cancelRequestedAt' | 'cancelStoppedAt'>) => ({
      _id: r._id,
      ...(r.cancelRequestedAt ? { markedAt: r.cancelRequestedAt } : {}),
      ...(r.cancelStoppedAt ? { stoppedAt: r.cancelStoppedAt } : {}),
    });
    if (quizSetId === undefined) {
      const rows = await this.sets
        .find(
          { ownerId, jobId, status: { $ne: 'ready' }, deletedAt: null },
          { _id: 1, cancelRequestedAt: 1, cancelStoppedAt: 1 },
        )
        .lean<Pick<QuizSetRow, '_id' | 'cancelRequestedAt' | 'cancelStoppedAt'>[]>();
      return rows.map(pick);
    }
    const target = await this.sets
      .findOne(
        { _id: objectId(quizSetId, '퀴즈'), ownerId },
        { jobId: 1, status: 1, deletedAt: 1, cancelRequestedAt: 1, cancelStoppedAt: 1 },
      )
      .lean<
        Pick<
          QuizSetRow,
          '_id' | 'jobId' | 'status' | 'deletedAt' | 'cancelRequestedAt' | 'cancelStoppedAt'
        >
      >();
    if (!target || !target.jobId?.equals(jobId)) throw notFound('퀴즈');
    return target.deletedAt || target.status === 'ready' ? [] : [pick(target)];
  }

  /**
   * 아직 ready가 아닌 내 세트들을 지우고(deletedAt) 딸린 개념 카드 작업(quiz_flashcards)도 멈춘다(#626). 카드 작업은 보통
   * ready 세트에만 있지만 세트가 ready로 바뀌는 순간과 겹치면 넣을 수 있다(넣는 쪽도 지운 세트면 멈춘다, ensureCards).
   * 이미 ready가 됐거나 지운 세트는 건너뛴다. when: 지울 때 더 맞아야 할 조건(createOnce: 취소 표시가 남음). 지운 수를 돌려준다
   */
  private async dropSets(
    userId: string,
    setIds: Types.ObjectId[],
    when: Record<string, unknown> = {},
  ): Promise<number> {
    const ownerId = objectId(userId, '퀴즈');
    const dropped: string[] = [];
    for (const _id of setIds) {
      const gone = await this.sets
        .findOneAndUpdate(
          { ...when, _id, ownerId, status: { $ne: 'ready' }, deletedAt: null },
          { $set: { deletedAt: new Date() } },
        )
        .lean();
      if (gone) dropped.push(_id.toHexString());
    }
    await this.jobs.cancelForTargets(userId, [
      { targetType: 'quiz_set', targetIds: dropped, types: [CARDS_TYPE] },
    ]);
    return dropped.length;
  }

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
    if (material.kind === 'recording' && material.processing?.status === 'failed') {
      throw new BadRequestException({
        code: VALIDATION_FAILED,
        message: '녹음 정리에 실패한 노트예요. 다시 정리한 뒤 퀴즈를 만들어 주세요',
      });
    }
    const pages = await this.recordingPages.notePages(owner, material);
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
    // 앱이 취소한(취소 표시) 세트는 취소 중이거나 지우다 실패해 남은 세트다(#626 · #642). 다시 돌려주면 취소가 이 세트를
    // 지워 새 화면이 404를 받으므로, 마저 지우고 아래에서 새 세트로 이어받는다. 작업이 끝났는데 방금 적힌 표시뿐인 세트는
    // 그 취소가 늦은 취소로 거둘 수 있어 지우지 않고 돌려준다(generatingSet canceled, #644)
    if (existing?.canceled) {
      // 읽은 뒤 작업이 끝나 그 취소가 늦은 취소가 됐을 수 있다(Codex #646 1차 · #643 4차): 처리 중인 취소면 끝나기를 짧게
      // 기다린 뒤 판단하고(dropCanceled), 지우지 않을 때는 처음부터 다시 본다(null → create가 한 번 더). 지울 때도 표시가
      // 남아 있을 때만 지운다(그사이 늦은 취소가 표시를 거뒀으면 지우지 않고 다시 봄)
      const setId = new Types.ObjectId(existing.quizSet._id);
      if (!(await this.dropCanceled(userId, setId, existing.job._id))) return null;
      const dropped = await this.dropSets(userId, [setId], {
        cancelRequestedAt: { $ne: null },
      });
      if (dropped === 0) {
        const left = await this.sets
          .findOne({ _id: setId }, { deletedAt: 1 })
          .lean<Pick<QuizSetRow, 'deletedAt'>>();
        if (left && !left.deletedAt) return null;
      }
    } else if (existing) {
      // 취소하지 않았는데 이어받기가 풀린 세트(겹친 옛 취소의 stop이 늦게 닿음)는 지우지 않고 이어받기를 되살려 돌려준다
      // (Codex 2차: 지우면 이미 이 세트를 받은 화면이 404)
      if (existing.job.type === PREGEN_TYPE && existing.job.awaited === false) {
        await this.jobs.awaitAgain(userId, existing.job._id);
        return { quizSet: existing.quizSet, job: { ...existing.job, awaited: true } };
      }
      return { quizSet: existing.quizSet, job: existing.job };
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
    // 세트를 넣은 뒤의 오류(폴더 확인 · 결과 옮기기)에는 넣은 작업을 거두지 않는다: 세트가 그 작업을 가리킨다
    let saved = false;
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
      saved = true;
      // 이어받은 뒤 세트를 넣기 전에 옛 취소의 stop이 이어받기를 풀었을 수 있어 넣은 뒤 다시 켠다(Codex 1차, keepAwaited)
      // 이어받기는 처리 순서만 바꾸므로 실패해도 세트 만들기는 그대로 돌려준다
      if (takenOver)
        await this.jobs.awaitAgain(userId, takenOver._id).catch((e: unknown) => {
          this.logger.warn(`이어받기를 다시 켜지 못했습니다(세트는 그대로): ${String(e)}`);
        });
      const row = created.toObject<QuizSetRow>();
      // 노트를 확인한 뒤 세트를 넣기 전에 학습 폴더가 지워졌으면 이 세트도 지우고(작업도 취소) 404(#602)
      if (await this.dropIfFolderGone(userId, row)) throw notFound('노트');
      if (!reused) return { quizSet: toAppSet(row, job.progress), job };
      // 끝난 작업이라 결과를 바로 옮겨 ready로(만드는 중으로 넣어 같은 노트의 고유 색인도 거친다)
      // 방금 넣은 세트라 취소 표시가 없어 지워지지 않는다(quizSet: null은 취소한 세트뿐)
      const synced = await this.sync(row);
      if (!synced.quizSet) throw notFound('퀴즈');
      return { quizSet: synced.quizSet, job: synced.job ?? job };
    } catch (e) {
      // 세트를 저장하지 못했으면 넣은 작업은 거둔다(이어받은 미리 만들기는 이어받기만 풀린다).
      // 같은 노트의 세트를 다른 요청이 먼저 만들었으면 그 세트를 돌려준다. 이때 이어받은 미리 만들기는
      // 먼저 만든 세트도 같은 작업을 이어받았으니 그대로 둔다. 끝난 미리 만들기는 거둘 것이 없다
      const duplicate = isDuplicateKey(e);
      if (!saved && !reused && !(duplicate && job.type === PREGEN_TYPE)) {
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
          // 먼저 만든 세트를 앱이 그사이 취소해 지웠으면 같은 노트의 만드는 중인 세트를 찾는다
          if (synced.quizSet) return { quizSet: synced.quizSet, job: synced.job ?? job };
        }
      }
      const other = await this.generatingSet(owner, material._id);
      return other && !other.canceled ? { quizSet: other.quizSet, job: other.job } : null;
    }
  }

  /**
   * 오늘의 복습 세트이거나 오늘의 복습에서 이어 만든 오답 복습 세트(sourceSetId를 거슬러 올라가 reviewDay가 있는 세트)인지.
   * 이런 세트는 첫 문제(baseSetId)의 노트 · 폴더만 가지지만 여러 폴더 문제를 섞는다(#602)
   */
  private async fromTodayReview(
    set: Pick<QuizSetRow, 'reviewDay' | 'sourceSetId'>,
  ): Promise<boolean> {
    let cur: Pick<QuizSetRow, 'reviewDay' | 'sourceSetId'> | null = set;
    // 끝(원본 없음)이나 이미 지나온 세트(고리)를 만날 때까지 오른다. 횟수로 끊지 않는다(Codex 1차: 끊으면 깊이 이어 만든
    // 오늘의 복습 세트를 지울 수 있음). 고리 안의 세트는 모두 reviewDay가 없어 오늘의 복습에서 온 것이 아니다
    const seen = new Set<string>();
    while (cur) {
      if (cur.reviewDay) return true;
      if (!cur.sourceSetId || seen.has(String(cur.sourceSetId))) return false;
      seen.add(String(cur.sourceSetId));
      cur = await this.sets
        .findOne({ _id: cur.sourceSetId }, { reviewDay: 1, sourceSetId: 1 })
        .lean<Pick<QuizSetRow, 'reviewDay' | 'sourceSetId'>>();
    }
    return false;
  }

  /**
   * 노트가 학습 폴더째 지워졌는지(#602). 노트가 지워졌고 그 폴더도 지워졌을 때만 true: 노트 하나만 지운 것은 퀴즈를
   * 그대로 두므로(폴더 삭제 때만 같이 지움) 여기서도 지운 것으로 보지 않는다. 없는 노트 · 폴더는 false(지금처럼 둠)
   */
  async folderGone(owner: Types.ObjectId, materialId: Types.ObjectId): Promise<boolean> {
    const note = await this.materials
      .findOne({ _id: materialId, ownerId: owner }, { deletedAt: 1, folderId: 1 })
      .lean<{ deletedAt?: Date | null; folderId?: Types.ObjectId | null }>();
    if (!note?.deletedAt || !note.folderId) return false;
    const folder = await this.folders
      .findOne({ _id: note.folderId, ownerId: owner }, { deletedAt: 1 })
      .lean<{ deletedAt?: Date | null }>();
    return !!folder?.deletedAt;
  }

  /**
   * 방금 넣은 세트의 노트가 학습 폴더째 지워졌으면(#602) 세트를 지우고 그 세트 · 노트의 진행 중인 퀴즈 작업을 취소한 뒤
   * true. 폴더 삭제는 노트 확인과 세트 넣기 사이에 커밋되면 이 세트를 보지 못하므로 넣은 쪽이 넣은 뒤에 다시 본다(커밋
   * 전에 넣었으면 폴더 삭제 쪽의 커밋 뒤 정리가 잡는다, QuizCleanupService)
   */
  async dropIfFolderGone(userId: string, set: QuizSetRow): Promise<boolean> {
    if (!set.materialId || !(await this.folderGone(set.ownerId, set.materialId))) return false;
    // 오늘의 복습에서 이어 만든 오답 복습은 여러 폴더 문제를 섞어 폴더 삭제에서 남긴다(QuizCleanupService.removeFor와 같음)
    if (await this.fromTodayReview(set)) return false;
    await this.sets.updateOne(
      { _id: set._id, ownerId: set.ownerId, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
    await this.jobs.cancelForTargets(userId, [
      { targetType: 'quiz_set', targetIds: [set._id.toString()], types: SET_JOB_TYPES },
      { targetType: 'material', targetIds: [set.materialId.toString()], types: [PREGEN_TYPE] },
    ]);
    return true;
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
   * 그 작업을 가리키는 세트가 없을 때만(지운 ready 세트 포함: 지운 퀴즈를 되살리지 않는다. ready가 되기 전에
   * 취소해 지운 세트는 빼고 센다, #626).
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
    const sets = await this.sets
      .find({ ownerId: owner, $or: [{ _id: jobId }, { jobId }] }, { status: 1, deletedAt: 1 })
      .lean<Pick<QuizSetRow, 'status' | 'deletedAt'>[]>();
    // 기다리다 취소해 지운 세트(ready가 되기 전에 지움, #626)는 퀴즈를 보인 적이 없어 쓴 것으로 세지 않는다. ready 전에
    // 세트를 지우는 다른 길은 학습 폴더 삭제뿐인데, 그때는 노트도 지워져 이 노트로 다시 만들 수 없다(create · pregenerate가 404)
    const used = sets.some((s) => !s.deletedAt || s.status === 'ready');
    return used ? null : found.job;
  }

  /**
   * 노트의 첫 맞춤 퀴즈를 미리 만드는 작업(quiz_pregen)을 넣는다(#134 · #274). 노트 정리가 끝나면
   * 노트 API가 부른다(아직 NestJS에 노트 API가 없어 부르는 곳은 그때 붙인다).
   * 처리기는 사용자 작업에 LLM 차례를 양보하며 안정적으로 만들고, 사용자가 그 사이 퀴즈를 요청하면
   * create가 이어받거나(도는 중) 결과를 바로 쓴다(끝남).
   * 넣지 않을 때: 물을 수 있는 쪽이 없음(null) · 도는 미리 만들기나 아직 쓰지 않은 결과가 있음(그 작업) ·
   * 이 노트에 세트가 이미 있음(null, 첫 세트만 미리 만든다).
   * 입력은 퀴즈 요청과 같다(generateInput): 이 노트의 세트는 아직 없지만 사용자의 다른 세트 · 풀이와 모든
   * 사용자의 유형별 정답률을 담아, 미리 만든 첫 세트에도 난이도 비율이 맞춰진다(Codex 리뷰 #300).
   * 알려진 한계: 확인과 넣기가 따로라 같은 노트에 거의 동시에 두 번 부르면 둘 다 넣을 수 있다
   * (노트 API는 정리가 끝날 때 한 번 부른다)
   */
  async pregenerate(userId: string, materialId: string): Promise<AppAiJob | null> {
    const owner = objectId(userId, '노트');
    const material = await this.materials
      .findOne({ _id: objectId(materialId, '노트'), ownerId: owner, deletedAt: null })
      .lean<MaterialRow>();
    if (!material) throw notFound('노트');
    const pages = await this.recordingPages.notePages(owner, material);
    if (!pages.some(askable)) return null;
    const pending =
      (await this.jobs.activePregen(userId, 'material', materialId)) ??
      (await this.unusedPregen(userId, owner, material, pages));
    if (pending) return pending;
    const hasSet = await this.sets
      .findOne({ ownerId: owner, materialId: material._id, deletedAt: null })
      .lean<QuizSetRow>();
    if (hasSet) return null;
    const job = await this.jobs.enqueue({
      type: PREGEN_TYPE,
      userId,
      targetType: 'material',
      targetId: materialId,
      input: await this.generateInput(owner, material, pages),
    });
    // 노트를 확인한 뒤 넣기 전에 학습 폴더가 지워졌으면 넣은 작업을 멈춘다(#602, 쓸 곳이 없는 AI 호출을 줄임)
    if (await this.folderGone(owner, material._id)) {
      await this.jobs.cancelForTargets(userId, [
        { targetType: 'material', targetIds: [materialId], types: [PREGEN_TYPE] },
      ]);
      return null;
    }
    return job;
  }

  /** 내 퀴즈 세트(최근 것부터). 만드는 중인 세트는 작업 결과를 먼저 옮기고, 끝까지 푼 세트에 completed를 붙인다 */
  async list(userId: string): Promise<AppQuizSet[]> {
    const owner = objectId(userId, '퀴즈');
    const rows = await this.sets
      .find({ ownerId: owner, deletedAt: null })
      .sort({ createdAt: -1 })
      .lean<QuizSetRow[]>();
    const synced = await Promise.all(rows.map(async (row) => (await this.sync(row)).quizSet));
    // 취소한 뒤 지우지 못해 남았던 세트는 이번 동기화가 지웠다(#642)
    return this.withCompleted(
      owner,
      synced.filter((s): s is AppQuizSet => s !== null),
    );
  }

  /**
   * ready 세트 중 이 사용자가 끝까지 푼 풀이(finishedAt)가 있는 세트에 completed: true(#561), 시작한 풀이가
   * 있는 세트에 started: true(#593)를 붙인다. 세트 수와 상관없이 풀이는 두 번(끝낸 · 시작한)만 읽는다.
   * 오늘의 복습 조회(TodayReviewService.get)도 같이 쓴다
   */
  async withCompleted(owner: Types.ObjectId, sets: AppQuizSet[]): Promise<AppQuizSet[]> {
    const ready = sets.filter((s) => s.status === 'ready').map((s) => new Types.ObjectId(s._id));
    if (ready.length === 0) return sets;
    const mine = { userId: owner, quizSetId: { $in: ready } };
    const finishedOnly = { ...mine, finishedAt: { $ne: null } };
    // 같은 세트를 여러 번 풀었어도 세트마다 한 줄(distinct). 틀린 문제는 세트마다 마지막으로 끝낸 풀이 하나만 DB에서
    // 골라 받는다(세트 수만큼만 오고, 풀이가 쌓여도 응답에 실려 오는 양은 같다, code-review 2차)
    const [finished, begun, lastRows] = (await Promise.all([
      this.attempts.distinct('quizSetId', finishedOnly),
      this.attempts.distinct('quizSetId', mine),
      this.attempts.aggregate<{ _id: Types.ObjectId; answers?: FinishedRow['answers'] }>([
        { $match: finishedOnly },
        { $sort: { finishedAt: -1 } },
        { $group: { _id: '$quizSetId', answers: { $first: '$answers' } } },
      ]),
    ])) as [
      Types.ObjectId[],
      Types.ObjectId[],
      { _id: Types.ObjectId; answers?: FinishedRow['answers'] }[],
    ];
    const done = new Set(finished.map((id) => id.toString()));
    const started = new Set(begun.map((id) => id.toString()));
    const wrong = new Map(lastRows.map((a) => [String(a._id), wrongIdsOf(a)] as const));
    // 끝낸 풀이도 시작한 풀이다. 두 조회가 따로 읽으므로 completed는 started와 상관없이 끝낸 풀이로만 정한다
    return sets.map((s) => {
      if (s.status !== 'ready') return s;
      const finishedHere = done.has(s._id);
      if (!finishedHere && !started.has(s._id)) return s;
      return {
        ...s,
        started: true,
        ...(finishedHere ? { completed: true, wrongQuestionIds: wrong.get(s._id) ?? [] } : {}),
      };
    });
  }

  /** 세트 하나. 만드는 중이면 작업 결과를 먼저 옮긴다 */
  async findMine(userId: string, setId: string): Promise<AppQuizSet> {
    const row = await this.sets
      .findOne({ _id: objectId(setId, '퀴즈'), ownerId: objectId(userId, '퀴즈'), deletedAt: null })
      .lean<QuizSetRow>();
    if (!row) throw notFound('퀴즈');
    const { quizSet } = await this.sync(row);
    // 취소한 뒤 지우지 못해 남았던 세트는 이번 동기화가 지웠다(#642)
    if (!quizSet) throw notFound('퀴즈');
    return quizSet;
  }

  /**
   * 다시 만들기(createOnce)가 만난 취소 세트를 지울지(true) 처음부터 다시 볼지(false). 작업 · 세트를 다시 읽어 작업이 없거나
   * 그 세트의 취소로 멈췄으면(canceledFirst: 세트의 멈춤 표시 · 맞춤 퀴즈 canceled, Codex 6차) 지우고, 그 취소로 멈춘 흔적 없이 끝났으면 늦은 취소가 될 수 있어 다시 본다(Codex #646 1차).
   * 작업이 아직 돌고 표시가 방금(CANCEL_SETTLE_GRACE_MS 안) 적혔으면 그 취소가 처리 중이라(표시를 적고 → 멈춰 보고 →
   * 늦었으면 거둠), 읽은 직후 작업이 끝나면 늦은 취소가 지켜야 할 세트를 지울 수 있다(Codex #643 4차). 그래서
   * CANCEL_WAIT_STEP_MS마다 작업 · 세트를 다시 읽으며 최대 CANCEL_WAIT_MS 그 취소가 끝나기를 기다린다. 그사이 표시가
   * 사라졌거나(늦은 취소가 거둠) 세트가 지워졌거나(그 취소가 지움) ready면 다시 본다. 오래된 표시(요청이 죽음)는 지금처럼
   * 지운다. 다 기다려도 그 취소가 처리 중이면 지우지 않고 409 QUIZ_CANCEL_PENDING으로 잠시 뒤 다시 하게 한다(Codex #643
   * 5차: 마지막 읽기 직후 작업이 끝나도 늦은 취소의 세트를 지키게 — 지우는 건 그 취소가 멈춘 게 확인됐거나 표시가 오래됐을 때뿐)
   */
  private async dropCanceled(
    userId: string,
    setId: Types.ObjectId,
    jobId: string,
  ): Promise<boolean> {
    for (let waited = 0; ; waited += CANCEL_WAIT_STEP_MS) {
      // 작업을 먼저 읽는다: 그 뒤 취소가 멈추고 표시를 적거나 세트를 지우면 아래 세트 읽기가 본다
      const job = await this.jobOf(userId, jobId);
      if (!job) return true;
      const row = await this.sets
        .findOne(
          { _id: setId },
          { status: 1, deletedAt: 1, cancelRequestedAt: 1, cancelStoppedAt: 1 },
        )
        .lean<Pick<QuizSetRow, 'status' | 'deletedAt' | 'cancelRequestedAt' | 'cancelStoppedAt'>>();
      if (!row || row.deletedAt || row.status === 'ready' || !row.cancelRequestedAt) return false;
      if (canceledFirst(job, row.cancelStoppedAt)) return true;
      if (!isActive(job)) return false;
      const age = Date.now() - new Date(row.cancelRequestedAt).getTime();
      if (age >= CANCEL_SETTLE_GRACE_MS) return true;
      if (waited >= CANCEL_WAIT_MS) {
        throw new ConflictException({
          code: ERROR_CODES.QUIZ_CANCEL_PENDING,
          message: '취소를 처리하는 중이에요. 잠시 뒤 다시 시도해 주세요',
        });
      }
      await this.sleep(CANCEL_WAIT_STEP_MS);
    }
  }

  /**
   * 같은 노트의 만드는 중인 세트. 작업이 이미 끝났으면 결과를 옮기고, 그래도 만드는 중일 때만 돌려준다.
   * canceled: 앱이 취소 표시를 적은, 아직 도는 작업의 세트(#642, 앱 응답에는 넣지 않는다). 작업이 끝났는데 남은 세트는
   * 방금 적힌 표시뿐이라(오래된 표시는 sync가 지움) 그 취소가 늦은 취소로 거둘 수 있어 취소한 세트로 보지 않는다(#644)
   */
  private async generatingSet(
    owner: Types.ObjectId,
    materialId: Types.ObjectId,
  ): Promise<{ quizSet: AppQuizSet; job: AppAiJob; canceled: boolean } | null> {
    const row = await this.sets
      .findOne({ ownerId: owner, materialId, status: 'generating', deletedAt: null })
      .lean<QuizSetRow>();
    if (!row) return null;
    const synced = await this.sync(row);
    return synced.quizSet?.status === 'generating' && synced.job
      ? {
          quizSet: synced.quizSet,
          job: synced.job,
          canceled: !!row.cancelRequestedAt && isActive(synced.job),
        }
      : null;
  }

  /**
   * 만드는 중인 세트에 작업 결과를 옮긴다. 성공했으면 문제를 넣어 ready, 실패 · 취소면 failed.
   * 아직 처리 중이면 작업의 진행률만 응답에 담는다. 바꿀 때는 지금 상태일 때만 바꿔, 여러 요청이
   * 같이 옮겨도 한 번만 반영된다.
   * failed 세트도 작업이 나중에 성공했으면(ai-jobs의 다시 시도, 뒤에서 마저 만든 미리 만들기) ready로
   * 되살린다. 다시 만드는 중으로는 되돌리지 않는다(그 사이 같은 노트에 새 세트가 있을 수 있다).
   * 앱이 취소했는데(cancelRequestedAt) 지우지 못한 채 남은 세트는 작업이 끝났거나 그 취소로 멈췄으면(cancelSettled) 결과를
   * 옮기지 않고 지운 뒤 quizSet: null을 돌려준다(#642). 늦은 취소(작업이 먼저 끝남)는 취소 요청이 표시를 거둬 지금처럼 옮긴다.
   * 끝난 작업에 방금 적힌 표시는 그 취소 요청이 아직 늦은 취소인지 가리는 중일 수 있어 지우지도 옮기지도 않는다(#644)
   */
  private async sync(
    row: QuizSetRow,
  ): Promise<{ quizSet: AppQuizSet | null; job: AppAiJob | null }> {
    if (row.followUpPending && row.status !== 'generating') await this.followUp(row);
    if (row.cardsPending && row.status === 'ready') await this.ensureCards(row);
    if (row.status === 'ready') return { quizSet: toAppSet(row), job: null };
    const job = row.jobId ? await this.findJob(row) : null;
    if (
      row.cancelRequestedAt &&
      cancelSettled(job, {
        cancelRequestedAt: row.cancelRequestedAt,
        cancelStoppedAt: row.cancelStoppedAt,
      })
    ) {
      await this.dropSets(row.ownerId.toHexString(), [row._id]);
      return { quizSet: null, job };
    }
    // 끝난 작업인데 방금 적힌 표시: 취소 요청이 아직 늦은 취소인지 가리는 중이라 지우지도 결과를 옮기지도 않고 지금대로
    // 둔다(#644). 늦은 취소면 표시를 거둔 뒤 다음 조회가 옮기고, 그 취소가 지우거나 요청이 죽었으면 30초 뒤 조회가 지운다
    if (row.cancelRequestedAt && job && !isActive(job)) return { quizSet: toAppSet(row), job };
    if (row.status === 'failed') {
      const ready = job?.status === 'succeeded' ? readyUpdate(job) : null;
      if (ready) return this.settle(row, ready, job);
      // 오답 복습을 다시 시도해 끝났는데 새 문제는 없으면(빈 reviewQuestions) 세트는 failed로 두고 복습 상태만 옮긴다(한 번만)
      if (job && REVIEW_TYPES.includes(job.type) && job.status === 'succeeded')
        await this.saveSrs(row, job);
      return { quizSet: toAppSet(row), job };
    }
    if (job && (job.status === 'queued' || job.status === 'running')) {
      return { quizSet: toAppSet(row, job.progress), job };
    }
    // 작업이 없어졌거나 실패 · 취소, 또는 쓸 문제가 없음(처리기 result.questions가 [])
    const update = (job?.status === 'succeeded' ? readyUpdate(job) : null) ?? { status: 'failed' };
    return this.settle(row, update, job);
  }

  /** 이어 받을 풀이를 넣고(afterReview) 표시를 지운다. 실패하면 표시를 남겨 다음 조회가 다시 넣는다 */
  private async followUp(row: QuizSetRow): Promise<void> {
    if (!this.afterReview) return;
    try {
      await this.afterReview(row);
    } catch (e) {
      this.logger.warn(`이어 받을 오답 복습을 넣지 못했습니다(다음 조회에 다시): ${String(e)}`);
      return;
    }
    await this.sets.findOneAndUpdate({ _id: row._id }, { $set: { followUpPending: false } }).lean();
  }

  /** 세트가 아직 row.status일 때만 바꾼다(여러 요청이 같이 옮겨도 한 번만) */
  private async settle(
    row: QuizSetRow,
    update: Record<string, unknown>,
    job: AppAiJob | null,
  ): Promise<{ quizSet: AppQuizSet | null; job: AppAiJob | null }> {
    // 처리기가 뽑은 개념 이름은 세트를 ready로 바꾸기 전에 노트에 남긴다: 저장이 실패하면 세트도 그대로라
    // 다음 조회가 다시 옮기며 다시 저장한다(Codex 리뷰 #276). 같이 옮기는 요청이 모두 저장해도 같은 값
    if (update['status'] === 'ready' && job) await this.saveConcepts(row, job);
    // 오답 복습은 틀린 문제들의 복습 상태(srsUpdates)를 세트를 바꾸기 전에 옮긴다(saveConcepts와 같은 이유).
    // 새 문제를 하나도 못 만들어 세트가 failed가 되어도 처리기가 끝냈으면 복습 상태는 옮긴다
    if (job && REVIEW_TYPES.includes(job.type) && job.status === 'succeeded')
      await this.saveSrs(row, job);
    // 오늘의 복습은 노트를 섞으므로 세트를 만들 때 노트가 없다: 첫 문제가 나온 세트(baseSetId)의 노트 · 폴더를 쓴다
    if (update['status'] === 'ready' && job?.type === TODAY_TYPE)
      Object.assign(update, await this.baseOf(row, job));
    // 노트가 있는 만드는 중 세트(일반 퀴즈 · 오답 복습)가 끝나면 그 노트를 기다리던 풀이를 이어 받는다:
    // 「이어 받을 풀이 남음」을 세트와 함께 적고, 넣은 뒤에 지운다(실패하면 다음 조회가 다시)
    if (row.status === 'generating' && row.materialId) update['followUpPending'] = true;
    // 맞춤 퀴즈 · 미리 만들기 세트가 ready가 되면 같은 범위의 개념 카드 작업을 넣는다(#558): 「카드 작업 남음」을
    // 세트와 함께 적고, 넣은 뒤에 지운다. 넣지 못하면(일시 오류 · 서버가 그 사이 멈춤) 다음 조회가 다시 넣는다.
    // 카드는 처리기가 따로 만들어 퀴즈 작업을 늦추지 않는다
    if (update['status'] === 'ready' && job && CARD_TYPES.includes(job.type))
      update['cardsPending'] = true;
    // 세트를 읽은 뒤 앱이 취소 표시를 적었으면 바꾸지 않는다(#642, 읽은 세트에는 아직 표시가 없어 위 sync가 거르지 못한
    // 경우). 표시는 맞춤 퀴즈 · 미리 만들기 세트에만 적으므로 다른 세트에는 늘 맞는 조건이다
    const updated = await this.sets
      .findOneAndUpdate(
        { _id: row._id, status: row.status, cancelRequestedAt: null },
        { $set: update },
        { returnDocument: 'after' },
      )
      .lean<QuizSetRow>();
    if (updated?.followUpPending) await this.followUp(updated);
    // 개념 카드 작업도 세트를 바꾼 뒤 바로 넣어 본다(표시는 위 갱신에 같이 적었다)
    if (updated?.cardsPending) await this.ensureCards(updated);
    const current =
      updated ?? (await this.sets.findOne({ _id: row._id }).lean<QuizSetRow>()) ?? row;
    // 위 조건에 막혔으면(그사이 앱이 취소함, 작업은 이미 끝남) 지울 때인 세트(cancelSettled)나 그사이 지운 세트는 돌려주지
    // 않고 여기서 지운다(이미 지웠으면 건너뜀). 방금 적힌 표시는 그 취소가 늦은 취소일 수 있어 옮기지 않은 채 돌려준다(#644)
    if (
      !updated &&
      current.cancelRequestedAt &&
      current.status !== 'ready' &&
      (current.deletedAt ||
        cancelSettled(job, {
          cancelRequestedAt: current.cancelRequestedAt,
          cancelStoppedAt: current.cancelStoppedAt,
        }))
    ) {
      await this.dropSets(row.ownerId.toHexString(), [row._id]);
      return { quizSet: null, job };
    }
    return { quizSet: toAppSet(current), job };
  }

  /**
   * 「카드 작업 남음」(cardsPending)인 세트의 개념 카드 작업(quiz_flashcards, #558)을 넣고 표시를 지운다.
   * 작업 id는 세트 id에서 정해져(cardsJobId) 같은 세트의 작업은 하나뿐이다: 여러 요청이 같이 넣거나 넣은 뒤 표시를
   * 지우기 전에 멈춘 요청이 있어도 _id 고유 색인이 둘째를 막고(E11000 = 이미 넣음), 표시는 넣은 뒤에만 지운다
   * (Codex 재리뷰: 먼저 지우면 넣기 전에 멈출 때 카드가 빠짐). 넣기 · 지우기가 실패하면 표시가 남아 다음 조회가
   * 다시 해 본다(경고 로그만, 노트 · 문제 글은 넣지 않음). 카드는 퀴즈의 덤이라 실패해도 조회 · 세트는 그대로.
   * 입력은 퀴즈 작업에 넣었던 노트(input.material)와 세트의 문제
   */
  private async ensureCards(set: QuizSetRow): Promise<void> {
    const owner = set.ownerId.toHexString();
    try {
      const material = set.jobId
        ? await this.jobs.materialInputOf(owner, set.jobId.toHexString())
        : null;
      const questions = set.questions ?? [];
      if (material && questions.length > 0) {
        await this.jobs
          .enqueue({
            id: cardsJobId(set._id).toHexString(),
            type: CARDS_TYPE,
            userId: owner,
            targetType: 'quiz_set',
            targetId: set._id.toHexString(),
            input: { material, questions: questions.map(toWorkerQuestion) },
          })
          .catch((e: unknown) => {
            if (!isDuplicateKey(e)) throw e; // 이미 넣음
          });
        // 세트를 읽은 뒤 넣기 전에 세트가 지워졌으면(학습 폴더 삭제, #602) 넣은 카드 작업을 멈춘다. 폴더 삭제의 작업
        // 취소(QuizCleanupService.afterRemove)가 먼저 끝났을 수 있어 넣은 쪽이 다시 본다(Codex 4차)
        const alive = await this.sets
          .findOne({ _id: set._id, ownerId: set.ownerId, deletedAt: null }, { _id: 1 })
          .lean();
        if (!alive) {
          await this.jobs.cancelForTargets(owner, [
            { targetType: 'quiz_set', targetIds: [set._id.toHexString()], types: [CARDS_TYPE] },
          ]);
        }
      }
      await this.sets
        .findOneAndUpdate({ _id: set._id, cardsPending: true }, { $set: { cardsPending: false } })
        .lean();
    } catch (e) {
      this.logger.warn(
        `개념 카드 작업을 넣지 못했습니다(퀴즈는 그대로, 다음 조회에 다시, 세트 ${set._id.toHexString()}): ${
          e instanceof Error ? e.name : typeof e
        }`,
      );
    }
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

  /**
   * 오답 복습 결과의 복습 상태(result.srsUpdates: [{quizSetId, questionId, srs}])를 그 문제에 쓴다. 이 사용자의 세트만 고친다.
   * 문제마다 그 상태를 만든 세트의 시각(srsAt = 세트 createdAt, 처리기 입력을 모은 때)을 함께 남기고, 남은 값보다
   * 더 새 세트의 상태만 쓴다(조건부 쓰기 하나). 그래서 여러 요청이 같이 옮기거나 늦게 도착해도, 그 뒤에 만든
   * 세트가 고친 상태를 되돌리지 않는다. 같은 세트가 다시 써도 같은 값이다.
   * 다 쓴 뒤에만 srsSavedAt을 남긴다: 쓰다 실패하면 세트를 바꾸기 전이라(settle) 다음 조회가 다시 옮긴다
   */
  private async saveSrs(row: QuizSetRow, job: AppAiJob): Promise<void> {
    if (row.srsSavedAt) return;
    const updates = job.result?.['srsUpdates'];
    if (!Array.isArray(updates)) return;
    const at = row.createdAt ?? row._id.getTimestamp();
    for (const u of updates as { quizSetId?: unknown; questionId?: unknown; srs?: unknown }[]) {
      if (
        typeof u.quizSetId !== 'string' ||
        !OBJECT_ID.test(u.quizSetId) ||
        typeof u.questionId !== 'string' ||
        !OBJECT_ID.test(u.questionId) ||
        !u.srs ||
        typeof u.srs !== 'object'
      )
        continue;
      await this.sets.updateOne(
        { _id: new Types.ObjectId(u.quizSetId), ownerId: row.ownerId },
        // 퀴즈를 끝낼 때 쓴 처음 상태 표시(srsAttemptId)는 지운다: 이제 이 상태는 그 풀이만의 것이 아니다
        {
          $set: { 'questions.$[q].srs': u.srs, 'questions.$[q].srsAt': at },
          $unset: { 'questions.$[q].srsAttemptId': '' },
        },
        // srsAt이 없거나 이 세트보다 오래된 문제만(더 새 세트가 쓴 상태는 그대로)
        {
          arrayFilters: [
            { 'q._id': new Types.ObjectId(u.questionId), 'q.srsAt': { $not: { $gt: at } } },
          ],
        },
      );
    }
    // 오늘의 복습이 결함 문제라 무효로 한 풀이(voidAnswers: [{attemptId, questionId, void}])
    const voids = job.result?.['voidAnswers'];
    for (const v of (Array.isArray(voids) ? voids : []) as {
      attemptId?: unknown;
      questionId?: unknown;
      void?: unknown;
    }[]) {
      if (
        typeof v.attemptId !== 'string' ||
        !OBJECT_ID.test(v.attemptId) ||
        typeof v.questionId !== 'string' ||
        !OBJECT_ID.test(v.questionId) ||
        (v.void !== true && typeof v.void !== 'string')
      )
        continue;
      await this.attempts.updateOne(
        { _id: new Types.ObjectId(v.attemptId), userId: row.ownerId },
        { $set: { 'answers.$[a].void': v.void } },
        { arrayFilters: [{ 'a.questionId': new Types.ObjectId(v.questionId) }] },
      );
    }
    await this.sets
      .findOneAndUpdate({ _id: row._id, srsSavedAt: null }, { $set: { srsSavedAt: new Date() } })
      .lean();
  }

  /** 오늘의 복습 결과의 baseSetId 세트에서 노트 · 폴더를 가져온다(이 사용자의 세트만) */
  private async baseOf(row: QuizSetRow, job: AppAiJob): Promise<Record<string, unknown>> {
    const id = job.result?.['baseSetId'];
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) return {};
    const base = await this.sets
      .findOne(
        { _id: new Types.ObjectId(id), ownerId: row.ownerId },
        { materialId: 1, folderId: 1 },
      )
      .lean<Pick<QuizSetRow, 'materialId' | 'folderId'>>();
    return base?.materialId ? { materialId: base.materialId, folderId: base.folderId } : {};
  }

  private findJob(row: QuizSetRow): Promise<AppAiJob | null> {
    return this.jobOf(row.ownerId.toString(), row.jobId!.toString());
  }

  /** 내 작업을 읽는다. 없으면 null */
  private async jobOf(userId: string, jobId: string): Promise<AppAiJob | null> {
    try {
      return await this.jobs.findMine(userId, jobId);
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }

  /**
   * 처리기 입력(apps/ai services/quiz/generate.py 「input」). 처리기는 다른 컬렉션을 읽지 않으므로
   * 이 노트 글 · 사용자의 다른 세트와 풀이 · 그 세트가 가리키는 노트 글을 모두 담는다.
   * 노트의 개념 이름(concepts)은 지난 퀴즈 · 미리 만들기가 저장했으면 넣는다(처리기가 다시 뽑지 않음).
   * 모든 사용자의 유형별 정답률(typeStats)도 넣는다: 처리기가 유형 난이도를 고친다(#268).
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
      notes: Object.fromEntries(
        await Promise.all(
          others.map(
            async (m) => [m._id.toString(), await this.recordingPages.notePages(owner, m)] as const,
          ),
        ),
      ),
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
  /** 모든 사용자의 유형별 푼 수 · 맞힌 수(#268). 없으면 처리기는 유형의 처음 난이도를 쓴다 */
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

// 필기 노트 글 고르기는 note-pages.ts 로 옮겼다(녹음 노트 서비스도 쓰므로). 기존 import 경로를 위해 다시 내보낸다
export { textPages } from './note-pages.js';

/** 저장한 문제 → 처리기 입력의 문제(apps/ai services/quiz/review.py parse_question) */
export function toWorkerQuestion(q: QuestionRow): Record<string, unknown> {
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

/**
 * 오답 복습 처리기에 넘길 문제. 이 풀이를 끝낼 때 처음 복습 상태를 쓴 문제(srsAttemptId)는 복습 상태 없이 넘긴다:
 * 처리기가 이 풀이로 srs.update(None, …)를 다시 하므로, 쓴 상태를 넘기면 같은 풀이를 두 번 센다
 */
export function reviewInputQuestion(
  q: QuestionRow,
  attemptId: Types.ObjectId,
): Record<string, unknown> {
  return toWorkerQuestion(q.srsAttemptId?.equals(attemptId) ? { ...q, srs: null } : q);
}

/** 처리기 결과의 문제들. 모양이 틀린 문제는 빼고 쓴다 */
function workerQuestions(raw: unknown): QuestionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(fromWorkerQuestion).filter((q): q is QuestionRow => q !== null);
}

/** 오답 복습 결과의 새 문제들: 처리기가 정한 복습 상태(srs)를 그대로 둔다 */
function reviewQuestions(raw: unknown): QuestionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const q = fromWorkerQuestion(r);
    if (!q) return [];
    const srs = (r as { srs?: unknown }).srs;
    return [
      { ...q, srs: srs && typeof srs === 'object' ? (srs as Record<string, unknown>) : null },
    ];
  });
}

/**
 * 성공한 작업의 결과에서 세트에 넣을 수 있는 문제들(모양이 틀린 문제는 뺀다). 세트 동기화(readyUpdate)와
 * 작업 완료 알림(ai-job-notices.service.ts, #634)이 같은 규칙으로 문제를 센다
 */
export function resultQuestions(job: Pick<AppAiJob, 'type' | 'result'>): QuestionRow[] {
  // 오답 복습(similar_quiz)은 새 문제를 reviewQuestions에 담고, 문제마다 처음 복습 상태(srs)를 준다
  // 오늘의 복습도 문제마다 복습 상태(srs)를 가진 사본을 questions에 담는다
  const similar = job.type === SIMILAR_TYPE;
  const keepSrs = similar || job.type === TODAY_TYPE;
  const raw = job.result?.[similar ? 'reviewQuestions' : 'questions'];
  return keepSrs ? reviewQuestions(raw) : workerQuestions(raw);
}

/**
 * 성공한 작업의 결과로 세트를 ready로 바꾸는 값. 쓸 문제가 없으면 null(세트를 failed로).
 * 모양이 틀린 문제를 빼면 번호가 비므로 처리기의 order 차례대로 1부터 다시 매긴다(/code-review)
 */
function readyUpdate(job: AppAiJob): Record<string, unknown> | null {
  const sorted = resultQuestions(job).sort((a, b) => a.order - b.order);
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
