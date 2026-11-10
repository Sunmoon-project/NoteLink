import { HttpException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { ERROR_CODES } from '@notelink/shared';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { AiJob, type AiJobDocument } from '../modules/quiz/schemas/ai-job.schema.js';

/** 작업이 없거나 남의 작업일 때의 오류 코드(packages/shared ERROR_CODES.NOT_FOUND 와 같은 값) */
export const NOT_FOUND = 'NOT_FOUND';

/** 노트를 만들 때 넣는 첫 맞춤 퀴즈 미리 만들기(#134). 처리기는 사용자 작업과 따로 처리한다 */
export const PREGEN_TYPE = 'quiz_pregen';

/** 처리기가 아직 끝내지 않은 상태. 취소할 수 있고, 미리 만들기를 이어받을 수 있다 */
const ACTIVE = ['queued', 'running'];
/** 앱의 '다시 시도'로 다시 넣을 수 있는 상태 */
const RETRYABLE = ['failed', 'canceled'];
/** 대기 한도를 확인하는 동안의 상태. 처리기는 queued만 가져가므로 이 상태의 작업은 잡히지 않는다 */
const HELD = 'held';
/** 확인 도중 서버가 멈춰 남은 held는 이 시간이 지나면 한도 계산에서 뺀다(그 사용자가 막히지 않게) */
const HELD_TTL_MS = 60_000;

/**
 * 사용자마다 동시에 기다릴 수 있는 작업 수(종류별). 학교 LLM 분당 한도를 함께 쓰는 작업을 몰아 보내지 못하게 한다.
 * 새로 넣을 때와 다시 시도할 때 모두 이 서비스가 지킨다(호출하는 쪽에서 따로 세지 않는다).
 */
export const PENDING_LIMIT = { note_ask: 2 } as const satisfies Record<string, number>;
const limitOf = (type: string): number | undefined =>
  (PENDING_LIMIT as Record<string, number | undefined>)[type];

const tooMany = () =>
  new HttpException(
    {
      code: ERROR_CODES.RATE_LIMITED,
      message: '앞의 요청을 처리하는 중이에요',
      retryAfterSeconds: 10,
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );

/** 작업을 넣을 때 NestJS가 정하는 값. 나머지(상태 · 시도 · 결과)는 서비스가 처음 값으로 채운다 */
export interface NewAiJob {
  type: string;
  userId: string;
  targetType: string;
  targetId: string;
  /** 처리기는 다른 컬렉션을 읽지 않으므로 처리에 필요한 자료를 모두 담는다(apps/ai jobs.py) */
  input: Record<string, unknown>;
}

/** 앱에 보내는 작업 모양(packages/shared AiJob). input · 잠금 · 중간 결과는 보내지 않는다 */
export interface AppAiJob {
  _id: string;
  type: string;
  status: string;
  targetType: string;
  targetId: string;
  progress: number;
  attempts: number;
  step?: string;
  awaited?: boolean;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** DB에서 읽은 작업 한 줄(lean). 서비스가 쓰는 필드만 적는다 */
export interface AiJobRow {
  _id: Types.ObjectId;
  type: string;
  status: string;
  targetType: string;
  targetId: Types.ObjectId;
  progress?: number;
  attempts?: number;
  step?: string | null;
  awaited?: boolean;
  result?: Record<string, unknown> | null;
  error?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 처리기가 정한 원인 코드가 없는 실패(LLM 응답 없음 · 처리 중 오류 · 시도 한도). 앱은 공통 실패 화면을 보인다 */
export const AI_JOB_FAILED = 'AI_JOB_FAILED';

/**
 * 처리기가 원인 코드를 붙인 오류: '<코드>: <원인>'(apps/ai runner.py JobInputError).
 * 앱이 아는 코드만 그대로 보낸다(지금은 녹음 정리 apps/ai services/recording/job.py). 새 코드를
 * 처리기에 더하면 여기에도 더한다. 원인 문구는 처리기 내부 내용이 섞일 수 있어 보내지 않는다
 */
const APP_ERROR_CODES = new Set(['NO_SPEECH', 'INVALID_FILE']);
const CODED_ERROR = /^([A-Z][A-Z0-9_]*): /;

/**
 * 처리기가 쓴 오류를 앱에 보낼 코드로 바꾼다. 앱은 error를 원인 문구가 아니라 코드로 읽는다
 * (apps/mobile features/quiz/quiz.tsx acceptJob · ERROR_CODES와 비교).
 * 처리기 문구에는 예외 내용(LLM 서버 주소 · 응답 일부 등)이 섞일 수 있어 그대로 보내지 않는다.
 * 원래 문구는 ai_jobs에 그대로 남아 서버에서 원인을 볼 수 있다.
 */
export function toAppError(error: string | null | undefined): string | null {
  if (error === null || error === undefined) return null;
  const code = CODED_ERROR.exec(error)?.[1];
  return code !== undefined && APP_ERROR_CODES.has(code) ? code : AI_JOB_FAILED;
}

export function toAppJob(row: AiJobRow): AppAiJob {
  const job: AppAiJob = {
    _id: row._id.toString(),
    type: row.type,
    // 다시 시도의 한도 확인 중(held)에 조회하면 queued로 보인다(공용 스키마에 held가 없음)
    status: row.status === HELD ? 'queued' : row.status,
    targetType: row.targetType,
    targetId: row.targetId.toString(),
    progress: row.progress ?? 0,
    attempts: row.attempts ?? 0,
    result: row.result ?? null,
    error: toAppError(row.error),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  // 공용 스키마에서 '없거나 문자열 · 불리언'이라 null은 보내지 않는다
  if (typeof row.step === 'string') job.step = row.step;
  if (typeof row.awaited === 'boolean') job.awaited = row.awaited;
  return job;
}

/** 앱에 보내지 않는 큰 필드(노트 · 대본 전문, 중간 결과). 앱이 몇 초마다 조회하므로 DB에서부터 읽지 않는다 */
const APP_PROJECTION = { input: 0, checkpoint: 0 };

const notFound = () => new NotFoundException({ code: NOT_FOUND, message: '작업을 찾을 수 없어요' });

const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** 앱이 보낸 id를 ObjectId로. 형식이 틀리면 없는 작업과 같게 404 */
function objectId(id: string): Types.ObjectId {
  if (!OBJECT_ID.test(id)) throw notFound();
  return new Types.ObjectId(id);
}

/** 서버 안에서 넘긴 id(작업을 넣는 모듈). 틀리면 서버 코드 문제라 404가 아니라 오류로 올린다 */
function serverObjectId(id: string, name: string): Types.ObjectId {
  if (!OBJECT_ID.test(id)) throw new Error(`ai_jobs: ${name}가 ObjectId 형식이 아님`);
  return new Types.ObjectId(id);
}

/** 처리기가 아직 잡고 있지 않음: 잠금이 없거나 지났다(apps/ai jobs.py 잠금) */
const unlocked = (now: Date) => [{ lockedUntil: null }, { lockedUntil: { $lte: now } }];

/**
 * ai_jobs에 작업을 넣고, 앱이 진행 상태를 보거나 취소 · 다시 시도할 수 있게 한다(#175).
 * FastAPI 처리기가 작업을 가져가 처리한 뒤 결과를 같은 문서에 쓴다. 상태 · 필드 규칙은
 * 처리기 쪽 문서(apps/ai/app/worker/jobs.py)를 따른다.
 * 모든 조회 · 변경은 userId 조건을 함께 걸어, 남의 작업은 없는 작업과 같게 404로 답한다.
 */
@Injectable()
export class AiJobsService {
  constructor(@InjectModel(AiJob.name) private readonly jobs: Model<AiJobDocument>) {}

  /**
   * 처리기가 가져갈 수 있게 queued로 넣는다. PENDING_LIMIT에 있는 종류는 처리기가 잡지 못하는 held로
   * 넣고, 자기를 포함한 대기 작업을 센 뒤 한도 안이면 queued로 연다(Codex #244). 넘으면 문서를 지우고 429:
   * 거절한 요청이 LLM을 쓰거나 본문 복사본을 남기지 않는다. 넣은 뒤에 세므로 동시에 온 요청은 함께
   * 거절될 수는 있어도(앱은 잠시 뒤 다시) 한도를 넘지 않는다. 이미 한도면 넣기 전에 바로 거절한다.
   */
  async enqueue(job: NewAiJob): Promise<AppAiJob> {
    const userId = serverObjectId(job.userId, 'userId');
    const limit = limitOf(job.type);
    if (limit !== undefined && (await this.pending(userId, job.type)) >= limit) throw tooMany();
    const created = await this.jobs.create({
      type: job.type,
      userId,
      targetType: job.targetType,
      targetId: serverObjectId(job.targetId, 'targetId'),
      input: job.input,
      ...(limit === undefined ? { status: 'queued' } : { status: HELD, heldAt: new Date() }),
      progress: 0,
      attempts: 0,
      result: null,
      awaited: false,
    });
    const row = created.toObject<AiJobRow>();
    if (limit === undefined) return toAppJob(row);
    if ((await this.pending(userId, job.type)) > limit) {
      await this.jobs.deleteOne({ _id: row._id, status: HELD });
      throw tooMany();
    }
    await this.release(row._id);
    const { heldAt: _heldAt, ...rest } = row as AiJobRow & { heldAt?: Date };
    return toAppJob({ ...rest, status: 'queued' });
  }

  /** 이 종류의 대기 작업 수(queued · running · 확인 중인 held). 한도 없는 종류는 세지 않는다 */
  private async pending(userId: Types.ObjectId, type: string): Promise<number> {
    if (limitOf(type) === undefined) return 0;
    return this.jobs.countDocuments({
      userId,
      type,
      $or: [
        { status: { $in: ACTIVE } },
        { status: HELD, heldAt: { $gt: new Date(Date.now() - HELD_TTL_MS) } },
      ],
    });
  }

  /** 한도 확인을 마친 held 작업을 처리기가 가져갈 수 있게 연다 */
  private async release(id: Types.ObjectId): Promise<void> {
    await this.jobs
      .findOneAndUpdate(
        { _id: id, status: HELD },
        { $set: { status: 'queued' }, $unset: { heldAt: '' } },
      )
      .lean();
  }

  /** 앱의 진행 상태 조회. 본인 작업만 */
  async findMine(userId: string, jobId: string): Promise<AppAiJob> {
    const row = await this.jobs
      .findOne({ _id: objectId(jobId), userId: objectId(userId) }, APP_PROJECTION)
      .lean<AiJobRow>();
    if (!row) throw notFound();
    return toAppJob(row);
  }

  /**
   * 아직 끝나지 않은 작업을 canceled로 바꾼다. 처리 중이면 처리기가 다음에 쓸 때 알아채고 결과를 버린다.
   * 이미 끝난 작업(succeeded · failed · canceled)은 그대로 둔다(앱이 두 번 눌러도 같은 결과).
   */
  async cancel(userId: string, jobId: string): Promise<void> {
    const filter = { _id: objectId(jobId), userId: objectId(userId) };
    const row = await this.jobs
      .findOneAndUpdate(
        { ...filter, status: { $in: ACTIVE } },
        { $set: { status: 'canceled' } },
        { projection: { _id: 1 } },
      )
      .lean();
    if (row) return;
    if ((await this.jobs.exists(filter)) === null) throw notFound();
  }

  /**
   * 실패하거나 취소한 작업을 다시 넣는다. 처리기 규칙대로 attempts=0 · retryAt=null로 되돌리고
   * 지난 오류 · 결과를 지운다(중간 결과 checkpoint는 남겨 처리기가 다시 쓴다).
   * 아직 처리 중이거나 이미 성공한 작업은 바꾸지 않고 지금 상태를 돌려준다(앱의 '다시 시도'는
   * 실패 화면에만 있고, 처리기가 failed로 바꾼 작업은 잠금이 비어 있어 지금 앱에서는 늘 다시 넣는다).
   * 처리 중에 취소한 작업은 처리기가 다음에 쓸 때까지(LLM 호출 중이면 몇 분) 계속 돌기 때문에,
   * 잠금이 풀릴 때까지는 다시 넣지 않는다. 바로 넣으면 같은 작업을 두 처리기가 함께 만든다
   * (/code-review #175). 그동안은 canceled 그대로 돌려주고, 앱이 잠시 뒤 다시 누르면 된다.
   */
  async retry(userId: string, jobId: string): Promise<AppAiJob> {
    const filter = { _id: objectId(jobId), userId: objectId(userId) };
    const reset = {
      status: 'queued',
      attempts: 0,
      progress: 0,
      retryAt: null,
      lockedUntil: null,
      result: null,
      error: null,
    };
    // 처리기가 잡지 못하는 held로 바꾸고 한도를 센다. 넘으면 바꾸기 전 값으로 되돌리므로 그 값을 받는다
    const before = await this.jobs
      .findOneAndUpdate(
        { ...filter, status: { $in: RETRYABLE }, $or: unlocked(new Date()) },
        {
          $set: { ...reset, status: HELD, heldAt: new Date() },
          $unset: { step: '', lockedBy: '' },
        },
        { projection: APP_PROJECTION },
      )
      .lean<AiJobRow & { userId: Types.ObjectId }>();
    if (!before) return this.findMine(userId, jobId);
    const limit = limitOf(before.type);
    if (limit !== undefined && (await this.pending(before.userId, before.type)) > limit) {
      await this.jobs
        .findOneAndUpdate(
          { _id: before._id, status: HELD },
          {
            $set: {
              status: before.status,
              attempts: before.attempts ?? 0,
              progress: before.progress ?? 0,
              result: before.result ?? null,
              error: before.error ?? null,
            },
            $unset: { heldAt: '' },
          },
        )
        .lean();
      throw tooMany();
    }
    await this.release(before._id);
    const { step: _step, ...rest } = before;
    return toAppJob({ ...rest, ...reset });
  }

  /**
   * 같은 대상의 미리 만들기(quiz_pregen)가 아직 끝나지 않았으면 이어받는다: 새 작업을 넣지 않고
   * awaited=true를 켜서 처리기가 사용자 작업처럼 먼저 처리하게 한다(#134 · #138).
   * 넣으면 같은 퀴즈를 두 번 만들기 때문이다. 이어받을 작업이 없으면 null(호출하는 쪽이 새로 넣는다).
   *
   * running이면 잠금이 지났어도(처리기가 멈춤) 이어받고, 처리기 상태는 바꾸지 않는다. 처리기는
   * 시도가 남았으면 다시 가져가므로 새로 넣으면 둘 다 처리된다(Codex #188). 시도를 다 썼으면 처리기가
   * failed로 바꾸고, 앱은 실패를 보여 주어 사용자가 다시 시도한다(다시 시도는 awaited를 남긴다).
   * 시도 한도 · 잠금 시각은 처리기 설정 · 시계라 NestJS는 판단에 쓰지 않는다.
   *
   * 알려진 한계: 이 확인과 호출하는 쪽의 enqueue는 따로라서, 같은 노트에 퀴즈 요청이 거의 동시에
   * 두 번 오면 둘 다 null을 받고 두 번 넣을 수 있다. 퀴즈 세트를 만드는 쪽(quiz-sets)에서 노트마다
   * 만드는 중인 세트를 하나로 막는다(#175 다음 단계).
   */
  async takeOverPregen(
    userId: string,
    targetType: string,
    targetId: string,
  ): Promise<AppAiJob | null> {
    const row = await this.jobs
      .findOneAndUpdate(
        {
          userId: objectId(userId),
          type: PREGEN_TYPE,
          targetType,
          targetId: objectId(targetId),
          status: { $in: ACTIVE },
        },
        { $set: { awaited: true } },
        { returnDocument: 'after', sort: { createdAt: -1 }, projection: APP_PROJECTION },
      )
      .lean<AiJobRow>();
    return row ? toAppJob(row) : null;
  }
}
