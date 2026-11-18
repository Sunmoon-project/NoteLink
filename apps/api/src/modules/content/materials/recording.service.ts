import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES, type Recording } from '@notelink/shared';
import { Model, Types } from 'mongoose';

import { AiJob } from '../../quiz/schemas/ai-job.schema.js';
import { BlobStorageService } from '../../upload/blob-storage.service.js';
import { Material } from '../schemas/material.schema.js';
import { isRecord } from './material-sync.js';
import type { MaterialRow } from './material-view.js';
import { MaterialsService, objectId } from './materials.service.js';
import { emptyPlayback, playbackFromResult } from './recording-view.js';

/**
 * 재생 화면에 주는 원본 녹음 읽기 주소의 유효 시간. 플레이어는 이 주소로 구간을 계속 받으므로, 처리하는 가장 긴
 * 녹음(2시간, apps/ai services/recording/job.py RECORDING_MAX_MS)을 느리게 · 멈췄다 들어도 끊기지 않게 넉넉히 둔다
 */
export const RECORDING_READ_SAS_MS = 6 * 60 * 60 * 1000;

/** 녹음 정리 작업에서 재생 화면에 쓰는 값만 읽는다(단어 시각은 자막 채움 · 립싱크에 쓴다. 조각 embedding 은 크고 쓰지 않는다) */
const JOB_PROJECTION = {
  status: 1,
  'input.sizeBytes': 1,
  'result.durationMs': 1,
  'result.transcript': 1,
  'result.sentences.text': 1,
  'result.sentences.startMs': 1,
  'result.sentences.endMs': 1,
  'result.sentences.words': 1,
  'result.slides.title': 1,
  'result.slides.summary': 1,
  'result.slides.startMs': 1,
  'result.slides.endMs': 1,
};

const notFound = () =>
  new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: '녹음 정보를 찾을 수 없어요' });

/**
 * 녹음 노트의 재생 정보(GET /materials/:id/recording). 원본 녹음의 읽기 주소에, 정리가 끝났으면 녹음 정리
 * 작업(recording_summary) 결과의 길이 · 대본 · 슬라이드를 붙인다. 결과는 ai_jobs 에만 있어(recordings 컬렉션에
 * 쓰는 곳 없음) 조회할 때마다 바꿔 담는다. 크기는 등록할 때 저장소에서 확인해 작업 input 에 넣은 값이다.
 * 입 모양(visemeUrl)은 만드는 곳이 없어 null. 남의 노트 · 지운 노트 · 없는 노트 · 녹음이 아닌 노트는 404
 */
@Injectable()
export class RecordingService {
  private readonly logger = new Logger(RecordingService.name);

  constructor(
    @InjectModel(Material.name) private readonly materials: Model<Material>,
    @InjectModel(AiJob.name) private readonly jobs: Model<AiJob>,
    private readonly notes: MaterialsService,
    private readonly blobs: BlobStorageService,
  ) {}

  async findMine(userId: string, id: string): Promise<Recording> {
    const owner = new Types.ObjectId(userId);
    const row = await this.materials
      .findOne({ _id: objectId(id, '녹음'), ownerId: owner, deletedAt: null, kind: 'recording' })
      .lean<MaterialRow>();
    if (!row) throw notFound();
    // 노트 조회처럼 끝난 작업의 상태 · 요약을 먼저 옮긴다(그 사이 지웠으면 null)
    const synced = await this.notes.sync(userId, row);
    if (!synced) throw notFound();
    const jobId = synced.processing.jobId;
    const [audioUrl, job] = await Promise.all([
      this.audioUrl(synced),
      jobId
        ? this.jobs
            .findOne({ _id: jobId, userId: owner, type: 'recording_summary' }, JOB_PROJECTION)
            .lean<{ status: string; input?: unknown; result?: unknown }>()
        : null,
    ]);
    const size = isRecord(job?.input) ? job.input['sizeBytes'] : undefined;
    return {
      // 재생 정보는 노트마다 하나라 노트 id 를 쓴다(recordings 문서가 없다)
      _id: synced._id.toString(),
      materialId: synced._id.toString(),
      audioUrl,
      audioSizeBytes: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : 0,
      ...(job?.status === 'succeeded' ? playbackFromResult(job.result) : emptyPlayback()),
      visemeUrl: null,
    };
  }

  /**
   * 원본 녹음 읽기 주소. 원본 주소가 없거나 저장소 설정이 없거나 주소를 만들지 못하면 빈 글자: 응답은 실패시키지
   * 않아 대본 · 슬라이드는 볼 수 있다(앱은 빈 주소면 재생만 막는다). 주소 · SAS 는 로그에 남기지 않는다
   */
  private async audioUrl(row: MaterialRow): Promise<string> {
    const source = row.blobUrls?.[0];
    if (!source) return '';
    try {
      return (await this.blobs.createReadAccess(source, RECORDING_READ_SAS_MS)).readUrl;
    } catch (e) {
      const reason = e instanceof Error ? e.constructor.name : '알 수 없는 오류';
      this.logger.warn(
        `녹음 원본 읽기 주소를 만들지 못했어요(노트 ${row._id.toString()}): ${reason}`,
      );
      return '';
    }
  }
}
