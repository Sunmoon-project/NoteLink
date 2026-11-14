import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { CreateStudyRoomDto } from './dto/create-study-room.dto.js';
import { JoinStudyRoomDto } from './dto/join-study-room.dto.js';
import { ListStudyRoomsDto } from './dto/list-study-rooms.dto.js';
import { StudyRoomsService } from './study-rooms.service.js';
import { StudyChatService } from './study-chat.service.js';
import { StudyChatGateway } from './study-chat.gateway.js';
import { StudyLiveService } from './study-live.service.js';
import { InviteStudyRoomDto } from './dto/invite-study-room.dto.js';

@Controller('study-rooms')
@UseGuards(JwtAuthGuard)
export class StudyRoomsController {
  constructor(
    private readonly rooms: StudyRoomsService,
    private readonly chat: StudyChatService,
    private readonly gateway: StudyChatGateway,
    private readonly live: StudyLiveService,
  ) {}

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: CreateStudyRoomDto) {
    return { data: await this.rooms.create(requireUserId(req), body) };
  }

  @Post('join')
  async join(@Req() req: AuthenticatedRequest, @Body() body: JoinStudyRoomDto) {
    const room = await this.rooms.joinRoom(requireUserId(req), body.inviteCode);

    this.gateway.notifyMembersChanged(room._id);

    return { data: room };
  }

  @Get()
  async list(@Req() req: AuthenticatedRequest, @Query() query: ListStudyRoomsDto) {
    const mine = query.mine === 'true';
    const recommended = query.recommended === 'true';
    if (mine === recommended)
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '목록 종류를 하나 선택해 주세요.',
      });
    return {
      data: await this.rooms.list(requireUserId(req), mine ? 'mine' : 'recommended', query.limit),
    };
  }

  @Get(':id')
  async get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return { data: await this.rooms.getRoom(requireUserId(req), id) };
  }

  @Post(':id/invites')
  async invite(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: InviteStudyRoomDto,
  ) {
    const invitation = await this.rooms.invite(requireUserId(req), id, body.userIds);
    const messages = await Promise.all(
      invitation.targetUserIds.map((targetUserId) =>
        this.chat.sendRoomInvite(requireUserId(req), targetUserId, invitation.room),
      ),
    );
    messages.forEach((message) => this.gateway.notifyDirectMessage(message));
    return { data: null };
  }

  @Post(':id/leave')
  async leave(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const userId = requireUserId(req);
    await this.rooms.leaveRoom(userId, id);
    await this.gateway.evict(id, userId);

    // 남아 있는 참가자에게 목록이 변경됐다고 알림
    this.gateway.notifyMembersChanged(id);

    await this.live.disconnect(id, userId);

    return { data: null };
  }

  @Post(':id/members/:userId/kick')
  async kick(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    await this.rooms.kickMember(requireUserId(req), id, userId);
    await this.gateway.evict(id, userId);

    // 남아 있는 참가자에게 목록이 변경됐다고 알림
    this.gateway.notifyMembersChanged(id);

    await this.live.disconnect(id, userId);
    return { data: null };
  }

  @Get(':id/chat-room')
  async getChatRoom(@Req() req: AuthenticatedRequest, @Param('id') roomId: string) {
    const chatRoom = await this.chat.getChat(roomId, requireUserId(req));

    return {
      data: {
        chatRoomId: String(chatRoom._id),
      },
    };
  }

  @Post(':id/livekit-token')
  async livekitToken(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return { data: await this.live.issueToken(id, requireUserId(req)) };
  }
}
