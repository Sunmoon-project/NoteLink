import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';

import { AiJob, type AiJobDocument } from '../modules/quiz/schemas/ai-job.schema.js';
import {
  loadRecordingTranscript,
  transcriptToPages,
  type RecordingPage,
} from './recording-pages.js';

/**
 * 녹음 노트의 퀴즈 입력 쪽을 만든다(FR-38). 녹음 노트는 pages 가 없어 대본(녹음 정리 작업 결과)을 읽어
 * 처리기 입력의 쪽으로 바꾼다. 노트가 가리키는 작업(processing.jobId)이 성공일 때만 돌려주고,
 * 아직 정리 중이거나 실패했으면 []: 호출하는 쪽이 글이 없는 노트로 다룬다
 */
@Injectable()
export class RecordingNotePagesService {
  constructor(@InjectModel(AiJob.name) private readonly jobs: Model<AiJobDocument>) {}

  async pages(
    ownerId: Types.ObjectId,
    note: { processing?: { jobId?: Types.ObjectId | null } },
  ): Promise<RecordingPage[]> {
    const transcript = await loadRecordingTranscript(this.jobs, ownerId, note.processing?.jobId);
    return transcript ? transcriptToPages(transcript) : [];
  }
}
