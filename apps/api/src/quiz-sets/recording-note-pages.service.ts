import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, type Types } from 'mongoose';

import { AiJob, type AiJobDocument } from '../modules/quiz/schemas/ai-job.schema.js';
import { textPages, type NotePageRow, type WorkerNotePage } from './note-pages.js';
import {
  loadRecordingTranscript,
  transcriptToPages,
  type RecordingPage,
} from './recording-pages.js';

/**
 * 노트의 퀴즈 입력 쪽을 만든다(FR-38). 맞춤 퀴즈(QuizSetsService)와 유사 퀴즈(SimilarQuizService)가 모두 이 서비스의
 * notePages 하나로 노트 글을 만든다(두 곳에 따로 두지 않는다).
 * 녹음 노트는 대본에서, 나머지는 쪽 글에서 만든다.
 *
 * 녹음 노트의 퀴즈 입력 쪽을 만든다(FR-38). 녹음 노트는 pages 가 없어 대본(녹음 정리 작업 결과)을 읽어
 * 처리기 입력의 쪽으로 바꾼다. 노트가 가리키는 작업(processing.jobId)이 성공일 때만 돌려주고,
 * 아직 정리 중이거나 실패했으면 []: 호출하는 쪽이 글이 없는 노트로 다룬다
 */
@Injectable()
export class RecordingNotePagesService {
  constructor(@InjectModel(AiJob.name) private readonly jobs: Model<AiJobDocument>) {}

  /**
   * 처리기 입력에 넣는 노트 글. 녹음 노트는 대본(녹음 정리 작업 결과)을 쪽으로 바꾸고(정리가 안 끝났거나 실패했으면 []),
   * 나머지(필기 · 문서 · 종류가 없는 옛 노트)는 글이 있는 쪽 그대로다
   */
  async notePages(
    ownerId: Types.ObjectId,
    note: {
      kind?: string;
      pages?: NotePageRow[];
      processing?: { jobId?: Types.ObjectId | null };
    },
  ): Promise<WorkerNotePage[]> {
    return note.kind === 'recording' ? this.pages(ownerId, note) : textPages(note.pages);
  }

  async pages(
    ownerId: Types.ObjectId,
    note: { processing?: { jobId?: Types.ObjectId | null } },
  ): Promise<RecordingPage[]> {
    const transcript = await loadRecordingTranscript(this.jobs, ownerId, note.processing?.jobId);
    return transcript ? transcriptToPages(transcript) : [];
  }
}
