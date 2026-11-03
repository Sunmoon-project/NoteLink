import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { StudyRoom, StudyRoomDocument } from '../studyroom/schemas/study-room.schema.js';
import { ROOM_MEMBER_STATUS } from '../studyroom/study-room.constants.js';
import { REPORT_STATUS, ReportStatus } from './report.constants.js';
import { Report, ReportDocument } from './schemas/report.schema.js';

export interface ReportView {
  id: string;
  status: string;
}

export interface ReportDetailView {
  id: string;
  roomId?: string;
  reporterId: string;
  targetUserId: string;
  reportType: string;
  details: string;
  imageUrls: string[];
  status: string;
  createdAt: string;
}

@Injectable()
export class SocialService {
  constructor(
    @InjectModel(Report.name)
    private readonly reportModel: Model<ReportDocument>,
    @InjectModel(StudyRoom.name)
    private readonly studyRoomModel: Model<StudyRoomDocument>,
  ) {}

  /**
   * 스터디룸 안의 사용자를 신고합니다. (발표자료 p.78)
   * - 자기 자신은 신고할 수 없음
   * - 신고자/대상 모두 그 방의 참여 멤버여야 함
   */
  async createReport(
    reporterId: string,
    input: {
      roomId: string;
      targetUserId: string;
      reportType: string;
      details: string;
      imageUrls?: string[];
    },
  ): Promise<ReportView> {
    // 자기 자신 신고 금지
    if (reporterId === input.targetUserId) {
      throw new BadRequestException({
        code: 'CANNOT_REPORT_SELF',
        message: '자기 자신은 신고할 수 없습니다.',
      });
    }

    const room = await this.studyRoomModel.findById(input.roomId);
    if (!room || room.closedAt) {
      throw new NotFoundException({
        code: 'ROOM_NOT_FOUND',
        message: '존재하지 않는 스터디룸입니다.',
      });
    }

    const reporterObjectId = new Types.ObjectId(reporterId);
    const targetObjectId = new Types.ObjectId(input.targetUserId);

    const isMember = (id: Types.ObjectId): boolean =>
      room.members.some((m) => m.userId.equals(id) && m.status === ROOM_MEMBER_STATUS.JOINED);

    // 신고자 본인이 그 방 멤버여야 함
    if (!isMember(reporterObjectId)) {
      throw new BadRequestException({
        code: 'NOT_A_MEMBER',
        message: '참여 중인 스터디룸에서만 신고할 수 있습니다.',
      });
    }

    // 신고 대상도 그 방 멤버여야 함
    if (!isMember(targetObjectId)) {
      throw new BadRequestException({
        code: 'TARGET_NOT_IN_ROOM',
        message: '신고 대상이 해당 스터디룸에 없습니다.',
      });
    }

    const report = await this.reportModel.create({
      roomId: room._id,
      reporterId: reporterObjectId,
      targetUserId: targetObjectId,
      reportType: input.reportType,
      details: input.details,
      imageUrls: input.imageUrls ?? [],
      status: REPORT_STATUS.PENDING,
    });

    return { id: report._id.toString(), status: report.status };
  }

  // ===== 관리자(admin) 전용 =====

  /** 신고 목록을 조회합니다. status로 필터 가능. 미처리(pending) 우선 최신순. */
  async listReports(
    options: {
      status?: string;
      limit?: number;
    } = {},
  ): Promise<ReportDetailView[]> {
    const safeLimit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const filter: Record<string, unknown> = {};
    if (options.status) {
      filter.status = options.status;
    }

    const docs = await this.reportModel
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .exec();

    return docs.map((r) => this.toDetailView(r));
  }

  /** 신고 상태를 변경합니다 (예: pending → resolved). */
  async updateReportStatus(reportId: string, status: ReportStatus): Promise<ReportDetailView> {
    const report = await this.findReportOr404(reportId);
    report.status = status;
    // 처리 완료 상태면 종료 시각을 기록합니다.
    if (status === REPORT_STATUS.RESOLVED || status === REPORT_STATUS.DISMISSED) {
      report.endAt = new Date();
    }
    await report.save();
    return this.toDetailView(report);
  }

  /** 신고를 삭제합니다. */
  async deleteReport(reportId: string): Promise<void> {
    const report = await this.findReportOr404(reportId);
    await report.deleteOne();
  }

  private async findReportOr404(reportId: string): Promise<ReportDocument> {
    if (!Types.ObjectId.isValid(reportId)) {
      throw new NotFoundException({
        code: 'REPORT_NOT_FOUND',
        message: '존재하지 않는 신고입니다.',
      });
    }
    const report = await this.reportModel.findById(reportId);
    if (!report) {
      throw new NotFoundException({
        code: 'REPORT_NOT_FOUND',
        message: '존재하지 않는 신고입니다.',
      });
    }
    return report;
  }

  private toDetailView(r: ReportDocument): ReportDetailView {
    return {
      id: r._id.toString(),
      roomId: r.roomId?.toString(),
      reporterId: r.reporterId.toString(),
      targetUserId: r.targetUserId.toString(),
      reportType: r.reportType,
      details: r.details,
      imageUrls: r.imageUrls,
      status: r.status,
      createdAt: (r.get('createdAt') as Date).toISOString(),
    };
  }
}
