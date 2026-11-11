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

@Controller('study-rooms')
@UseGuards(JwtAuthGuard)
export class StudyRoomsController {
  constructor(
    private readonly rooms: StudyRoomsService,
    private readonly chat: StudyChatService,
    private readonly gateway: StudyChatGateway,
  ) {}

  @Post()
  async create(@Req() req: AuthenticatedRequest, @Body() body: CreateStudyRoomDto) {
    return { data: await this.rooms.create(requireUserId(req), body) };
  }

  @Post('join')
  async join(@Req() req: AuthenticatedRequest, @Body() body: JoinStudyRoomDto) {
    return { data: await this.rooms.joinRoom(requireUserId(req), body.inviteCode) };
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

  @Post(':id/leave')
  async leave(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const userId = requireUserId(req);
    await this.rooms.leaveRoom(userId, id);
    await this.gateway.evict(id, userId);
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
}
