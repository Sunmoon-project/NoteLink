import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import mongoose, { Types, type Model } from 'mongoose';
import { StudyChatService } from '../studyroom/study-chat.service.js';
import { CreateReportDto } from './dto/create-report.dto.js';
import { Report } from './schemas/report.schema.js';
import { REPORT_STATUS } from './report.constants.js';
import { BlobStorageService } from '../upload/blob-storage.service.js';

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectModel(Report.name) private readonly reports: Model<Report>,
    private readonly chat: StudyChatService,
    private readonly storage: BlobStorageService,
  ) {}

  async create(reporterId: string, input: CreateReportDto) {
    const room = await this.chat.requireMember(input.roomId, reporterId);
    const targetId = new Types.ObjectId(input.targetUserId);
    if (targetId.equals(reporterId)) {
      throw new BadRequestException({ code: 'BAD_REQUEST', message: '자신을 신고할 수 없습니다.' });
    }
    const target = room.members.some(
      (member) => targetId.equals(member.userId) && member.status === 'joined',
    );
    if (!target) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: '신고할 참여자를 찾을 수 없습니다.',
      });
    }
    // 임시 경로의 사진을 확인해 보관 경로로 복사하고, 복사한 주소를 저장한다
    const imageUrls = await this.storage.keepReportImages(
      String(new Types.ObjectId(reporterId)),
      input.imageUrls ?? [],
    );
    let report;
    try {
      report = await this.reports.create({
        roomId: new Types.ObjectId(input.roomId),
        reporterId: new Types.ObjectId(reporterId),
        targetUserId: targetId,
        reportType: input.reportType,
        details: input.details,
        imageUrls,
        status: REPORT_STATUS.PENDING,
      });
    } catch (error) {
      // 저장되지 않은 것이 확실할 때만 복사본을 지운다. 결과가 불명확하면(쓰기 확인 시간 초과 ·
      // 연결 오류) 신고가 저장됐을 수 있어 남긴다
      if (surelyNotSaved(error)) await this.storage.discardReportImages(imageUrls);
      else if (imageUrls.length)
        this.logger.warn('신고 저장 결과가 불명확해 사진 복사본을 남깁니다');
      throw error;
    }
    return { _id: String(report._id), status: report.status };
  }
}

/** 신고 문서가 저장되지 않은 것이 확실한 오류: 보내기 전 검증 실패, 서버가 거절한 쓰기 */
export function surelyNotSaved(error: unknown): boolean {
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError)
    return true;
  const { MongoServerError, MongoWriteConcernError } = mongoose.mongo;
  if (!(error instanceof MongoServerError) || error instanceof MongoWriteConcernError) return false;
  // 쓰기는 됐고 복제 확인만 실패한 응답 · 다시 보낸 쓰기는 결과가 불명확
  return !error.errorResponse?.writeConcernError && !error.hasErrorLabel('RetryableWriteError');
}
