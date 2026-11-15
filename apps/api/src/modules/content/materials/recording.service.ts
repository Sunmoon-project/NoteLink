import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES, type Recording } from '@notelink/shared';
import { Model, Types } from 'mongoose';

import { AiJobsService, type AppAiJob } from '../../../ai-jobs/ai-jobs.service.js';
import { BlobStorageService } from '../../upload/blob-storage.service.js';
import { Material } from '../schemas/material.schema.js';
import type { MaterialRow } from './material-view.js';
import { APP_READ_SAS_MS, MaterialsService, objectId } from './materials.service.js';
import { EMPTY_PLAYBACK, playbackFromResult } from './recording-view.js';

const notFound = (what: string) =>
  new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: `${what} 정보를 찾을 수 없어요` });

/**
 * 녹음 노트의 재생 정보(GET /materials/:id/recording). 원본 녹음의 읽기 주소(SAS 1시간) · 크기에,
 * 정리가 끝났으면 녹음 정리 작업(recording_summary) 결과의 길이 · 대본 · 슬라이드를 붙인다.
 * 결과는 ai_jobs 에만 있어(recordings 컬렉션에 쓰는 곳 없음) 조회할 때마다 바꿔 담는다. 입 모양(visemeUrl)은
 * 만드는 곳이 없어 null. 남의 노트 · 지운 노트 · 없는 노트 · 녹음이 아닌 노트 · 원본이 없는 노트는 404
 */
@Injectable()
export class RecordingService {
  constructor(
    @InjectModel(Material.name) private readonly materials: Model<Material>,
    private readonly notes: MaterialsService,
    private readonly jobs: AiJobsService,
    private readonly blobs: BlobStorageService,
  ) {}

  async findMine(userId: string, id: string): Promise<Recording> {
    const row = await this.materials
      .findOne({
        _id: objectId(id),
        ownerId: new Types.ObjectId(userId),
        deletedAt: null,
        kind: 'recording',
      })
      .lean<MaterialRow>();
    if (!row) throw notFound('녹음');
    // 노트 조회처럼 끝난 작업의 상태 · 요약을 먼저 옮긴다(그 사이 지웠으면 null)
    const synced = await this.notes.sync(userId, row);
    if (!synced) throw notFound('녹음');
    const source = synced.blobUrls?.[0];
    if (!source) throw notFound('원본 녹음');
    let audio: { readUrl: string; sizeBytes?: number };
    try {
      audio = await this.blobs.createReadAccess(source, APP_READ_SAS_MS, {
        prefix: `uploads/audio/${userId.toLowerCase()}/`,
      });
    } catch (e) {
      // 저장된 주소가 맞지 않거나 원본이 지워졌다. 저장소 장애(503)는 그대로
      if (e instanceof BadRequestException) throw notFound('원본 녹음');
      throw e;
    }
    const job = await this.findJob(userId, synced.processing.jobId);
    const playback = job?.status === 'succeeded' ? playbackFromResult(job.result) : EMPTY_PLAYBACK;
    return {
      // 재생 정보는 노트마다 하나라 노트 id 를 쓴다(recordings 문서가 없다)
      _id: synced._id.toString(),
      materialId: synced._id.toString(),
      audioUrl: audio.readUrl,
      audioSizeBytes: audio.sizeBytes ?? 0,
      ...playback,
      visemeUrl: null,
    };
  }

  private async findJob(
    userId: string,
    jobId: Types.ObjectId | null | undefined,
  ): Promise<AppAiJob | null> {
    if (!jobId) return null;
    try {
      return await this.jobs.findMine(userId, jobId.toString());
    } catch (e) {
      if (e instanceof NotFoundException) return null;
      throw e;
    }
  }
}
