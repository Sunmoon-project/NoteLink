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
    // 임시 경로의 사진을 확인해 보관 경로로 복사하고, 복사한 주소를 저장한다
    const imageUrls = await this.storage.keepReportImages(
      String(new Types.ObjectId(reporterId)),
      input.imageUrls ?? [],
    );
    const report = await this.reports.create({
      roomId: new Types.ObjectId(input.roomId),
      reporterId: new Types.ObjectId(reporterId),
      targetUserId: targetId,
      reportType: input.reportType,
      details: input.details,
      imageUrls,
      status: REPORT_STATUS.PENDING,
    });
    return { _id: String(report._id), status: report.status };
  }
}
