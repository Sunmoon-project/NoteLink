import { BadRequestException, NotFoundException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { REPORT_STATUS } from './report.constants.js';
import { Report } from './schemas/report.schema.js';
import { SocialService } from './social.service.js';
import { StudyRoom } from '../studyroom/schemas/study-room.schema.js';

function createReportModelMock() {
  const model = vi.fn();
  return Object.assign(model, {
    create: vi.fn(),
    find: vi.fn(),
    findById: vi.fn(),
  });
}

describe('SocialService', () => {
  let service: SocialService;
  let reportModel: ReturnType<typeof createReportModelMock>;
  let studyRoomModel: { findById: ReturnType<typeof vi.fn> };

  const reporterId = new Types.ObjectId().toString();
  const targetId = new Types.ObjectId().toString();
  const roomId = new Types.ObjectId().toString();

  beforeEach(async () => {
    reportModel = createReportModelMock();
    studyRoomModel = { findById: vi.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SocialService,
        { provide: getModelToken(Report.name), useValue: reportModel },
        { provide: getModelToken(StudyRoom.name), useValue: studyRoomModel },
      ],
    }).compile();

    service = moduleRef.get(SocialService);
  });

  // joined 멤버 2명(신고자, 대상)이 있는 방을 흉내 냅니다.
  function roomWithBoth() {
    return {
      _id: new Types.ObjectId(roomId),
      closedAt: undefined,
      members: [
        { userId: new Types.ObjectId(reporterId), status: 'joined' },
        { userId: new Types.ObjectId(targetId), status: 'joined' },
      ],
    };
  }

  describe('createReport', () => {
    it('자기 자신을 신고하면 CANNOT_REPORT_SELF', async () => {
      await expect(
        service.createReport(reporterId, {
          roomId,
          targetUserId: reporterId, // 동일인
          reportType: 'chat',
          details: 'x',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('없는 방이면 ROOM_NOT_FOUND', async () => {
      studyRoomModel.findById.mockResolvedValue(null);
      await expect(
        service.createReport(reporterId, {
          roomId,
          targetUserId: targetId,
          reportType: 'chat',
          details: 'x',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('신고 대상이 방 멤버가 아니면 TARGET_NOT_IN_ROOM', async () => {
      studyRoomModel.findById.mockResolvedValue({
        _id: new Types.ObjectId(roomId),
        closedAt: undefined,
        members: [
          { userId: new Types.ObjectId(reporterId), status: 'joined' },
          // 대상 없음
        ],
      });
      await expect(
        service.createReport(reporterId, {
          roomId,
          targetUserId: targetId,
          reportType: 'chat',
          details: 'x',
        }),
      ).rejects.toMatchObject({ response: { code: 'TARGET_NOT_IN_ROOM' } });
    });

    it('정상 신고하면 pending 상태로 저장된다', async () => {
      studyRoomModel.findById.mockResolvedValue(roomWithBoth());
      reportModel.create.mockImplementation((doc: Record<string, unknown>) =>
        Promise.resolve({ _id: new Types.ObjectId(), ...doc }),
      );

      const result = await service.createReport(reporterId, {
        roomId,
        targetUserId: targetId,
        reportType: 'behavior',
        details: '부적절한 언행',
      });

      const createArg = reportModel.create.mock.calls[0]?.[0] as {
        status: string;
        roomId: Types.ObjectId;
      };
      expect(createArg.status).toBe(REPORT_STATUS.PENDING);
      expect(createArg.roomId).toBeDefined(); // roomId 저장 확인
      expect(result.status).toBe('pending');
    });
  });

  describe('listReports', () => {
    function mockFindChain(result: unknown[]) {
      const chain = {
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(result),
      };
      reportModel.find.mockReturnValue(chain);
      return chain;
    }

    it('status 필터를 적용해 조회한다', async () => {
      mockFindChain([]);
      await service.listReports({ status: 'pending' });
      expect(reportModel.find).toHaveBeenCalledWith({ status: 'pending' });
    });

    it('status 없으면 전체 조회', async () => {
      mockFindChain([]);
      await service.listReports({});
      expect(reportModel.find).toHaveBeenCalledWith({});
    });
  });

  describe('updateReportStatus', () => {
    it('없는 신고면 REPORT_NOT_FOUND', async () => {
      reportModel.findById.mockResolvedValue(null);
      await expect(
        service.updateReportStatus(new Types.ObjectId().toString(), 'resolved'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('resolved로 바꾸면 endAt이 기록된다', async () => {
      const save = vi.fn().mockResolvedValue(undefined);
      reportModel.findById.mockResolvedValue({
        _id: new Types.ObjectId(),
        roomId: new Types.ObjectId(),
        reporterId: new Types.ObjectId(),
        targetUserId: new Types.ObjectId(),
        reportType: 'chat',
        details: 'x',
        imageUrls: [],
        status: 'pending',
        endAt: undefined,
        save,
        get: () => new Date(),
      });

      const result = await service.updateReportStatus(
        new Types.ObjectId().toString(),
        'resolved',
      );
      expect(save).toHaveBeenCalledOnce();
      expect(result.status).toBe('resolved');
    });
  });

  describe('deleteReport', () => {
    it('없는 신고면 REPORT_NOT_FOUND', async () => {
      reportModel.findById.mockResolvedValue(null);
      await expect(
        service.deleteReport(new Types.ObjectId().toString()),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('있으면 deleteOne 호출', async () => {
      const deleteOne = vi.fn().mockResolvedValue(undefined);
      reportModel.findById.mockResolvedValue({ deleteOne });
      await service.deleteReport(new Types.ObjectId().toString());
      expect(deleteOne).toHaveBeenCalledOnce();
    });
  });
});
