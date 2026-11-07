import { Injectable, NotFoundException } from '@nestjs/common';
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

export function toAppJob(row: AiJobRow): AppAiJob {
  const job: AppAiJob = {
    _id: row._id.toString(),
    type: row.type,
    status: row.status,
    targetType: row.targetType,
    targetId: row.targetId.toString(),
    progress: row.progress ?? 0,
    attempts: row.attempts ?? 0,
    result: row.result ?? null,
    error: row.error ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  // 공용 스키마에서 '없거나 문자열 · 불리언'이라 null은 보내지 않는다
  if (typeof row.step === 'string') job.step = row.step;
  if (typeof row.awaited === 'boolean') job.awaited = row.awaited;
  return job;
}

const notFound = () => new NotFoundException({ code: NOT_FOUND, message: '작업을 찾을 수 없어요' });

/** 문자열 id를 ObjectId로. 형식이 틀리면 없는 작업과 같게 404 */
function objectId(id: string): Types.ObjectId {
  if (!/^[0-9a-f]{24}$/i.test(id)) throw notFound();
  return new Types.ObjectId(id);
}

/**
 * ai_jobs에 작업을 넣고, 앱이 진행 상태를 보거나 취소 · 다시 시도할 수 있게 한다(#175).
 * FastAPI 처리기가 작업을 가져가 처리한 뒤 결과를 같은 문서에 쓴다. 상태 · 필드 규칙은
 * 처리기 쪽 문서(apps/ai/app/worker/jobs.py)를 따른다.
 * 모든 조회 · 변경은 userId 조건을 함께 걸어, 남의 작업은 없는 작업과 같게 404로 답한다.
 */
@Injectable()
export class AiJobsService {
  constructor(@InjectModel(AiJob.name) private readonly jobs: Model<AiJobDocument>) {}

  /** 처리기가 가져갈 수 있게 queued로 넣는다 */
  async enqueue(job: NewAiJob): Promise<AppAiJob> {
    const created = await this.jobs.create({
      type: job.type,
      userId: objectId(job.userId),
      targetType: job.targetType,
      targetId: objectId(job.targetId),
      input: job.input,
      status: 'queued',
      progress: 0,
      attempts: 0,
      result: null,
      awaited: false,
    });
    return toAppJob(created.toObject<AiJobRow>());
  }

  /** 앱의 진행 상태 조회. 본인 작업만 */
  async findMine(userId: string, jobId: string): Promise<AppAiJob> {
    const row = await this.jobs
      .findOne({ _id: objectId(jobId), userId: objectId(userId) })
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
   * 아직 처리 중이거나 이미 성공한 작업은 바꾸지 않고 지금 상태를 돌려준다.
   */
  async retry(userId: string, jobId: string): Promise<AppAiJob> {
    const filter = { _id: objectId(jobId), userId: objectId(userId) };
    const row = await this.jobs
      .findOneAndUpdate(
        { ...filter, status: { $in: RETRYABLE } },
        {
          $set: {
            status: 'queued',
            attempts: 0,
            progress: 0,
            retryAt: null,
            lockedUntil: null,
            result: null,
            error: null,
          },
          $unset: { step: '', lockedBy: '' },
        },
        { returnDocument: 'after' },
      )
      .lean<AiJobRow>();
    if (row) return toAppJob(row);
    return this.findMine(userId, jobId);
  }

  /**
   * 같은 대상의 미리 만들기(quiz_pregen)가 아직 끝나지 않았으면 이어받는다: 새 작업을 넣지 않고
   * awaited=true를 켜서 처리기가 사용자 작업처럼 먼저 처리하게 한다(#134 · #138).
   * 넣으면 같은 퀴즈를 두 번 만들기 때문이다. 이어받을 작업이 없으면 null(호출하는 쪽이 새로 넣는다).
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
        { returnDocument: 'after', sort: { createdAt: -1 } },
      )
      .lean<AiJobRow>();
    return row ? toAppJob(row) : null;
  }
}
