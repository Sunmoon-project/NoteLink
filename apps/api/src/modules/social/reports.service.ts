import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';
import { StudyChatService } from '../studyroom/study-chat.service.js';
import { CreateReportDto } from './dto/create-report.dto.js';
import { Report } from './schemas/report.schema.js';
import { REPORT_STATUS } from './report.constants.js';
import { BlobStorageService } from '../upload/blob-storage.service.js';

@Injectable()
export class ReportsService {
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
    // 신고 ID를 먼저 정해 사진 복사본을 그 신고 아래에 둔다. 저장이 실패해도 여기서 지우지 않는다:
    // 오류만으로는 저장 여부를 확정할 수 없어, 정리 작업이 나중에 신고 문서를 보고 판단한다
    const reportId = new Types.ObjectId();
    const imageUrls = await this.storage.keepReportImages(
      String(new Types.ObjectId(reporterId)),
      input.imageUrls ?? [],
      String(reportId),
    );
    const report = await this.reports.create({
      _id: reportId,
      roomId: new Types.ObjectId(input.roomId),
      reporterId: new Types.ObjectId(reporterId),
      targetUserId: targetId,
      reportType: input.reportType,
      details: input.details,
      imageUrls,
      status: REPORT_STATUS.PENDING,
    });
    await this.storage.confirmReportImages(imageUrls);
    return { _id: String(report._id), status: report.status };
  }
}
