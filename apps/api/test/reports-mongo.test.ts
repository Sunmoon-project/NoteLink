import { randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Report, ReportSchema } from '../src/modules/social/schemas/report.schema.js';
import { ReportsService } from '../src/modules/social/reports.service.js';
import { StudyRoom, StudyRoomSchema } from '../src/modules/studyroom/schemas/study-room.schema.js';
import { StudyChatService } from '../src/modules/studyroom/study-chat.service.js';

const uri = process.env.STUDYROOM_TEST_MONGO_URI;
const local = uri && /^mongodb:\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(uri);

describe.skipIf(!local)('스터디룸 신고 MongoDB 저장', () => {
  const suffix = randomBytes(8).toString('hex');
  const roomCollection = `test_report_rooms_${suffix}`;
  const reportCollection = `test_reports_${suffix}`;
  const reporter = new Types.ObjectId();
  const target = new Types.ObjectId();
  let connection: mongoose.Connection;
  let rooms: mongoose.Model<StudyRoom>;
  let reports: mongoose.Model<Report>;
  let service: ReportsService;

  beforeAll(async () => {
    connection = await mongoose
      .createConnection(uri!, { serverSelectionTimeoutMS: 5000 })
      .asPromise();
    rooms = connection.model(StudyRoom.name, StudyRoomSchema, roomCollection);
    reports = connection.model(Report.name, ReportSchema, reportCollection);
    const chat = new StudyChatService(rooms, {} as never, {} as never, {} as never);
    service = new ReportsService(reports, chat, {
      keepReportImages: async (_: string, urls: string[]) => urls,
    } as never);
  });
  afterAll(async () => {
    if (!connection) return;
    await connection.dropCollection(reportCollection).catch(() => {});
    await connection.dropCollection(roomCollection).catch(() => {});
    await connection.close();
  });

  it('참여자를 신고하면 식별자와 첨부 URL을 저장하고 방에서 나간 신고자는 거절한다', async () => {
    const room = await rooms.create({
      title: '신고 테스트',
      categoryId: new Types.ObjectId(),
      hostId: reporter,
      inviteCode: 'REP001',
      isPublic: true,
      memberCount: 2,
      members: [
        { userId: reporter, role: 'host', status: 'joined' },
        { userId: target, role: 'member', status: 'joined' },
      ],
    });
    const input = {
      roomId: String(room._id),
      targetUserId: String(target),
      reportType: 'spam' as const,
      details: '반복적으로 광고 메시지를 보냅니다',
      imageUrls: ['https://blob.example.com/report.jpg'],
    };
    const result = await service.create(String(reporter), input);
    const stored = await reports.findById(result._id).lean().orFail();
    expect(stored).toMatchObject({
      roomId: room._id,
      reporterId: reporter,
      targetUserId: target,
      reportType: 'spam',
      details: input.details,
      imageUrls: input.imageUrls,
      status: 'pending',
    });
    expect((stored as typeof stored & { createdAt: Date }).createdAt).toBeInstanceOf(Date);
    await rooms.updateOne(
      { _id: room._id, 'members.userId': reporter },
      { $set: { 'members.$.status': 'left' } },
    );
    await expect(service.create(String(reporter), input)).rejects.toMatchObject({ status: 404 });
    expect(await reports.countDocuments()).toBe(1);
  });
});
