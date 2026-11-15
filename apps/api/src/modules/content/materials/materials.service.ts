import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES, UPLOAD_RULES } from '@notelink/shared';
import { Model, Types } from 'mongoose';

import { type AppAiJob, AiJobsService } from '../../../ai-jobs/ai-jobs.service.js';
import { QuizSetsService } from '../../../quiz-sets/quiz-sets.service.js';
import { BlobStorageService } from '../../upload/blob-storage.service.js';
import { Folder } from '../schemas/folder.schema.js';
import { Material } from '../schemas/material.schema.js';
import type { CreateMaterialDto } from './dto/create-material.dto.js';
import { syncFromJob } from './material-sync.js';
import { type MaterialRow, toAppMaterial } from './material-view.js';

type AppMaterial = ReturnType<typeof toAppMaterial>;

/** AI 입력에 넣는 파일 읽기 주소 유효 시간. 처리기가 다시 시도해도 만료되지 않게 넉넉히 둔다 */
export const AI_READ_SAS_MS = 24 * 60 * 60 * 1000;
/** 응답에 담는 원본 이미지 읽기 주소 유효 시간 */
export const APP_READ_SAS_MS = 60 * 60 * 1000;
/** Idempotency-Key 최대 길이 */
export const IDEMPOTENCY_KEY_MAX = 128;

/** 노트 종류 → 업로드 종류(UPLOAD_RULES · blob 경로 uploads/<업로드 종류>/<userId>/) */
const UPLOAD_KIND = { handwriting: 'image', document: 'document', recording: 'audio' } as const;
/** 노트 종류 → AI 작업 종류. 문서도 노트 정리 처리기(handwriting_summary)가 읽는다(apps/ai worker/handlers.py) */
const JOB_TYPE = {
  handwriting: 'handwriting_summary',
  document: 'handwriting_summary',
  recording: 'recording_summary',
} as const;
const DUPLICATE_KEY = 11000;
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const KEY_FORMAT = /^[\x21-\x7e]+$/;

const notFound = (what: string) =>
  new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: `${what} 정보를 찾을 수 없어요` });
const invalid = (message: string) =>
  new BadRequestException({ code: ERROR_CODES.VALIDATION, message });
const conflict = (message: string) =>
  new ConflictException({ code: ERROR_CODES.IDEMPOTENCY_CONFLICT, message });
const isDuplicateKey = (e: unknown) =>
  typeof e === 'object' && e !== null && (e as { code?: unknown }).code === DUPLICATE_KEY;

/** 앱이 보낸 id. 형식이 틀리면 없는 것과 같게 404 */
export function objectId(id: string, what = '노트'): Types.ObjectId {
  if (!OBJECT_ID.test(id)) throw notFound(what);
  return new Types.ObjectId(id);
}

/** Idempotency-Key 헤더 검사. 없으면 undefined */
export function parseIdempotencyKey(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    raw.length > IDEMPOTENCY_KEY_MAX ||
    !KEY_FORMAT.test(raw)
  )
    throw invalid(`Idempotency-Key는 공백 없는 ${IDEMPOTENCY_KEY_MAX}자 이하여야 해요`);
  return raw;
}

interface NormalizedBody {
  folderId: string;
  kind: CreateMaterialDto['kind'];
  source: CreateMaterialDto['source'];
  title: string;
  description: string | null;
  blobUrls: string[];
  avatarItemId: string | null;
}

const normalize = (dto: CreateMaterialDto): NormalizedBody => ({
  folderId: dto.folderId.toLowerCase(),
  kind: dto.kind,
  source: dto.source,
  title: dto.title,
  description: dto.description ? dto.description : null,
  blobUrls: dto.blobUrls,
  avatarItemId: dto.avatarItemId ? dto.avatarItemId.toLowerCase() : null,
});

/** 같은 내용이면 같은 값. 키가 같은데 내용이 다른 요청을 가린다 */
export const fingerprintOf = (body: NormalizedBody): string =>
  createHash('sha256')
    .update(
      JSON.stringify([
        body.folderId,
        body.kind,
        body.source,
        body.title,
        body.description,
        body.blobUrls,
        body.avatarItemId,
      ]),
    )
    .digest('hex');

/** 검사를 마친 올린 파일 하나 */
interface UploadedFile {
  blobUrl: string;
  /** AI 처리기가 내려받는 읽기 전용 주소(DB에는 저장하지 않는다) */
  readUrl: string;
  sizeBytes: number;
}

/** 주소 끝의 확장자(소문자). 없으면 빈 문자열 */
const extensionOf = (url: string): string => url.split('.').pop()?.toLowerCase() ?? '';

/**
 * 노트(자료) 등록 · 조회 · 수정 · 삭제. 등록하면 FastAPI 처리기가 정리하는 AI 작업(ai_jobs)을 넣고,
 * 앱이 노트를 조회할 때 끝난 작업의 결과를 노트에 옮긴다(따로 도는 반복 없이, quiz-sets 와 같은 방식).
 * 남의 노트 · 없는 노트는 같게 404 로 답한다.
 */
@Injectable()
export class MaterialsService {
  constructor(
    @InjectModel(Material.name) private readonly materials: Model<Material>,
    @InjectModel(Folder.name) private readonly folders: Model<Folder>,
    private readonly jobs: AiJobsService,
    private readonly blobs: BlobStorageService,
    private readonly quizSets: QuizSetsService,
  ) {}

  private readonly logger = new Logger(MaterialsService.name);

  /**
   * 노트를 등록하고 정리 작업을 넣는다. 응답은 앱의 로컬 모의 API(content.createMaterial)와 같은 { material, job }.
   * key(Idempotency-Key)가 있으면 같은 키의 재요청은 새로 만들지 않고 처음 만든 노트와 그 작업을 돌려준다.
   * 같은 키에 다른 내용(또는 이미 지운 노트)이면 409 IDEMPOTENCY_CONFLICT.
   * 노트를 먼저 만들고 작업을 넣은 뒤 작업 id 를 연결한다(작업을 넣는 서비스가 트랜잭션을 받지 않는다).
   * 노트만 만들고 멈춘 요청은 같은 키의 재요청이 작업을 마저 넣는다. 키 없는 요청이 작업을 넣지 못하면 노트를 지운다.
   */
  async register(
    userId: string,
    dto: CreateMaterialDto,
    key?: string,
  ): Promise<{ material: AppMaterial; job: AppAiJob }> {
    const owner = new Types.ObjectId(userId);
    const body = normalize(dto);
    const fingerprint = fingerprintOf(body);
    if (key) {
      const existing = await this.findByKey(owner, key);
      if (existing) return this.replay(userId, existing, fingerprint);
    }
    const folder = await this.folders
      .findOne({ _id: new Types.ObjectId(body.folderId), ownerId: owner, deletedAt: null })
      .lean<{ _id: Types.ObjectId; subjectName?: string }>();
    if (!folder) throw notFound('폴더');
    const files = await this.prepareFiles(userId, body.kind, body.blobUrls);

    let created: MaterialRow;
    try {
      const doc = await this.materials.create({
        ownerId: owner,
        folderId: folder._id,
        kind: body.kind,
        source: body.source,
        title: body.title,
        description: body.description,
        avatarItemId: body.avatarItemId ? new Types.ObjectId(body.avatarItemId) : null,
        processing: { status: 'queued', progress: 0, jobId: null },
        // 이미지는 업로드마다 한 쪽. PDF 는 한 쪽으로 두었다가 정리가 끝나면 쪽 수만큼 펼친다
        pages:
          body.kind === 'recording'
            ? []
            : files.map((f, i) => ({
                pageNo: i + 1,
                imageUrl: f.blobUrl,
                sizeBytes: f.sizeBytes,
                ocrText: null,
                takenAt: null,
              })),
        blobUrls: body.blobUrls,
        ...(key ? { requestId: key, requestFingerprint: fingerprint } : {}),
      });
      created = doc.toObject() as unknown as MaterialRow;
    } catch (e) {
      // 같은 키의 요청이 거의 동시에 와서 다른 쪽이 먼저 만들었다
      if (key && isDuplicateKey(e)) {
        const existing = await this.findByKey(owner, key);
        if (existing) return this.replay(userId, existing, fingerprint);
      }
      throw e;
    }

    // 폴더 목록이 최근에 바뀐 순이라 노트를 넣은 폴더를 맨 앞으로(실패해도 등록은 성공으로 본다)
    await this.folders
      .updateOne({ _id: folder._id, ownerId: owner }, { $set: { updatedAt: new Date() } })
      .catch(() => undefined);

    try {
      const started = await this.startJob(userId, created, folder.subjectName, files);
      return { material: await this.view(started.row), job: started.job };
    } catch (e) {
      // 키가 없으면 재요청으로 이어갈 수 없다. 작업 없는 노트가 남지 않게 지운다
      if (!key) {
        await this.materials
          .updateOne(
            { _id: created._id, 'processing.jobId': null },
            { $set: { deletedAt: new Date() } },
          )
          .catch(() => undefined);
      }
      throw e;
    }
  }

  private findByKey(owner: Types.ObjectId, key: string): Promise<MaterialRow | null> {
    return this.materials.findOne({ ownerId: owner, requestId: key }).lean<MaterialRow>();
  }

  /** 같은 키로 이미 만든 노트 → 같은 결과. 작업을 넣기 전에 멈춘 노트는 작업을 마저 넣는다 */
  private async replay(
    userId: string,
    existing: MaterialRow,
    fingerprint: string,
  ): Promise<{ material: AppMaterial; job: AppAiJob }> {
    if (existing.requestFingerprint !== fingerprint)
      throw conflict('같은 등록 키에 다른 자료를 보낼 수 없어요');
    if (existing.deletedAt) throw conflict('이 등록 키로 만든 자료는 이미 지웠어요');
    if (existing.processing.jobId) {
      return {
        material: await this.view(existing),
        job: await this.jobs.findMine(userId, existing.processing.jobId.toString()),
      };
    }
    const folder = await this.folders
      .findOne({ _id: existing.folderId, ownerId: existing.ownerId, deletedAt: null })
      .lean<{ subjectName?: string }>();
    const files = await this.prepareFiles(userId, existing.kind, existing.blobUrls ?? []);
    const started = await this.startJob(userId, existing, folder?.subjectName, files);
    return { material: await this.view(started.row), job: started.job };
  }

  /**
   * 정리 작업을 넣고 노트에 작업 id 를 연결한다. 연결은 아직 작업이 없을 때만 한다:
   * 같은 키의 요청이 겹쳐 다른 쪽이 먼저 연결했으면 내가 넣은 작업은 취소하고 먼저 연결된 작업을 돌려준다
   */
  private async startJob(
    userId: string,
    material: MaterialRow,
    subjectName: string | undefined,
    files: UploadedFile[],
  ): Promise<{ row: MaterialRow; job: AppAiJob }> {
    const kind = material.kind as keyof typeof JOB_TYPE;
    const input =
      kind === 'recording'
        ? { audioUrl: files[0]!.readUrl, sizeBytes: files[0]!.sizeBytes }
        : {
            pages: files.map((f, i) => ({ pageNo: i + 1, imageUrl: f.readUrl })),
            ...(subjectName ? { subject: subjectName } : {}),
          };
    const job = await this.jobs.enqueue({
      type: JOB_TYPE[kind],
      userId,
      targetType: 'material',
      targetId: material._id.toString(),
      input,
    });
    const linked = await this.materials
      .findOneAndUpdate(
        { _id: material._id, 'processing.jobId': null },
        { $set: { 'processing.jobId': new Types.ObjectId(job._id) } },
        { returnDocument: 'after' },
      )
      .lean<MaterialRow>();
    if (linked) return { row: linked, job };
    await this.jobs.cancel(userId, job._id);
    const current = await this.materials.findOne({ _id: material._id }).lean<MaterialRow>();
    const jobId = current?.processing.jobId;
    if (!current || !jobId) throw new Error('materials: 작업 연결이 계속 겹침');
    return { row: current, job: await this.jobs.findMine(userId, jobId.toString()) };
  }

  /**
   * 올린 파일을 검사하고 AI 입력에 넣을 읽기 주소를 만든다.
   * 개수 · 확장자 · PDF 단독 규칙을 먼저 보고(저장소를 부르기 전), 파일이 내 폴더 경로
   * uploads/<업로드 종류>/<내 userId>/ 에 실제로 있는지 · 크기 한도(UPLOAD_RULES)를 본다
   */
  private async prepareFiles(
    userId: string,
    kind: string,
    blobUrls: string[],
  ): Promise<UploadedFile[]> {
    if (!(kind in UPLOAD_KIND)) throw invalid('자료 종류를 확인해 주세요');
    const uploadKind = UPLOAD_KIND[kind as keyof typeof UPLOAD_KIND];
    const rule = UPLOAD_RULES[uploadKind];
    if (new Set(blobUrls).size !== blobUrls.length)
      throw invalid('같은 파일을 두 번 넣을 수 없어요');
    if (kind === 'recording' && blobUrls.length !== 1)
      throw invalid('녹음은 파일 하나만 올릴 수 있어요');
    for (const url of blobUrls) {
      if (!(rule.exts as readonly string[]).includes(extensionOf(url))) {
        throw new BadRequestException({
          code: ERROR_CODES.FILE_NOT_ALLOWED,
          message: '올릴 수 없는 파일 형식이에요',
        });
      }
    }
    if (
      kind === 'document' &&
      blobUrls.length > 1 &&
      blobUrls.some((u) => extensionOf(u) === 'pdf')
    )
      throw invalid('PDF는 다른 파일과 함께 올릴 수 없어요');
    const prefix = `uploads/${uploadKind}/${userId.toLowerCase()}/`;
    const files = await Promise.all(
      blobUrls.map(async (blobUrl) => {
        const { readUrl, sizeBytes } = await this.blobs.createReadAccess(blobUrl, AI_READ_SAS_MS, {
          prefix,
        });
        if (sizeBytes === undefined || sizeBytes > rule.maxBytes)
          throw new BadRequestException({
            code: ERROR_CODES.FILE_NOT_ALLOWED,
            message: '파일이 너무 커요',
          });
        return { blobUrl, readUrl, sizeBytes };
      }),
    );
    return files;
  }

  /** 내 노트 한 개. 정리 중이면 끝난 작업의 결과를 먼저 옮긴다. 남의 것 · 지운 것 · 없는 것 · 잘못된 id 는 404 */
  async findMine(userId: string, id: string): Promise<AppMaterial> {
    const owner = new Types.ObjectId(userId);
    const row = await this.materials
      .findOne({ _id: objectId(id), ownerId: owner, deletedAt: null })
      .lean<MaterialRow>();
    if (!row) throw notFound('노트');
    const synced = await this.sync(userId, row);
    if (!synced) throw notFound('노트');
    return this.view(synced);
  }

  /**
   * 정리 작업의 상태 · 결과를 노트에 옮긴다(quiz-sets 의 sync 와 같은 방식: 조회할 때, 지금 상태일 때만 바꿔
   * 여러 요청이 같이 옮겨도 한 번만 반영). 이미 끝난 노트는 작업을 읽지 않는다.
   * 처리 완료로 바뀐 필기 · 문서는 이어서 첫 맞춤 퀴즈를 미리 만든다(실패해도 노트 조회는 성공).
   * 그 사이 지웠으면 null
   */
  async sync(userId: string, row: MaterialRow): Promise<MaterialRow | null> {
    const jobId = row.processing.jobId;
    if (!jobId || row.processing.status === 'done') return row;
    const job = await this.findJob(userId, jobId);
    // 작업이 없어졌으면 정리가 끝날 수 없다. 처리 중이던 노트는 실패로
    const update = job
      ? syncFromJob(row, job)
      : row.processing.status === 'failed'
        ? null
        : { 'processing.status': 'failed' };
    if (!update) return row;
    const filter = {
      _id: row._id,
      ownerId: row.ownerId,
      deletedAt: null,
      'processing.status': row.processing.status,
    };
    const updated = await this.materials
      .findOneAndUpdate(filter, { $set: update }, { returnDocument: 'after' })
      .lean<MaterialRow>();
    if (!updated) {
      // 다른 요청이 먼저 옮겼거나 그 사이 지웠다
      return this.materials
        .findOne({ _id: row._id, ownerId: row.ownerId, deletedAt: null })
        .lean<MaterialRow>();
    }
    if (update['processing.status'] === 'done' && updated.kind !== 'recording') {
      await this.pregenerate(userId, updated);
    }
    return updated;
  }

  private async findJob(userId: string, jobId: Types.ObjectId): Promise<AppAiJob | null> {
    try {
      return await this.jobs.findMine(userId, jobId.toString());
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }

  /** 노트 정리가 끝나면 첫 맞춤 퀴즈를 미리 만들어 둔다(#134). 못 넣어도 노트 조회는 그대로 성공 */
  private async pregenerate(userId: string, row: MaterialRow): Promise<void> {
    try {
      await this.quizSets.pregenerate(userId, row._id.toString());
    } catch (e) {
      const reason = e instanceof Error ? e.message : '알 수 없는 오류';
      this.logger.warn(`퀴즈 미리 만들기를 넣지 못했어요(노트 ${row._id.toString()}): ${reason}`);
    }
  }

  /** 앱에 보낼 노트 한 개. 쪽 이미지는 읽기 SAS 로 바꾼다(저장소 설정이 없거나 만들지 못하면 원래 주소) */
  private async view(row: MaterialRow): Promise<AppMaterial> {
    if (!row.pages || row.pages.length === 0) return toAppMaterial(row, (u) => u);
    const signed = new Map<string, string>();
    await Promise.all(
      [...new Set(row.pages.map((p) => p.imageUrl))].map(async (url) => {
        try {
          signed.set(url, (await this.blobs.createReadAccess(url, APP_READ_SAS_MS)).readUrl);
        } catch {
          // 저장소 설정이 없거나 주소가 맞지 않아도 응답은 실패시키지 않는다(주소 · SAS 는 로그에 남기지 않는다)
        }
      }),
    );
    return toAppMaterial(row, (url) => signed.get(url) ?? url);
  }
}
