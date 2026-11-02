import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { ChatService, ChatMessageView } from './chat.service.js';
import { CreateStudyRoomDto } from './dto/create-study-room.dto.js';
import { JoinStudyRoomDto } from './dto/join-study-room.dto.js';
import { ListMessagesDto } from './dto/list-messages.dto.js';
import { ListStudyRoomsDto } from './dto/list-study-rooms.dto.js';
import { StudyroomService, StudyRoomView } from './studyroom.service.js';
import type { StudyRoomMemberView } from './studyroom.service.js';

// 주소는 /api/v1/study-rooms (kebab-case 복수형)
@Controller('study-rooms')
@UseGuards(JwtAuthGuard) // 스터디룸 기능은 모두 로그인 필요
export class StudyroomController {
  constructor(
    private readonly studyroomService: StudyroomService,
    private readonly chatService: ChatService,
  ) {}

  // POST /api/v1/study-rooms — 방 만들기 (p.75 "3. 스터디룸 만들기")
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CreateStudyRoomDto,
  ): Promise<{ data: StudyRoomView }> {
    // hostId는 앱이 보내는 값이 아니라, 토큰에서 꺼낸 "로그인한 사용자"입니다.
    const data = await this.studyroomService.create(req.user.userId, dto);
    return { data };
  }

  // GET /api/v1/study-rooms — 공개방 목록 (p.75 "1. 스터디룸 탭 최초 화면")
  @Get()
  async list(
    @Query() query: ListStudyRoomsDto,
  ): Promise<{ data: StudyRoomView[] }> {
    const data = await this.studyroomService.list(query.limit);
    return { data };
  }

  // POST /api/v1/study-rooms/join — 코드로 입장 (p.75 "2. 스터디룸 코드로 입장")
  @Post('join')
  @HttpCode(HttpStatus.OK)
  async join(
    @Req() req: AuthenticatedRequest,
    @Body() dto: JoinStudyRoomDto,
  ): Promise<{ data: StudyRoomView }> {
    const data = await this.studyroomService.joinByCode(
      req.user.userId,
      dto.inviteCode,
    );
    return { data };
  }

  // POST /api/v1/study-rooms/:id/leave — 방 나가기 (p.81 "20. 채팅방 나가기")
  @Post(':id/leave')
  @HttpCode(HttpStatus.OK)
  async leave(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: { closed: boolean } }> {
    const data = await this.studyroomService.leave(req.user.userId, id);
    return { data };
  }

  // GET /api/v1/study-rooms/:id/messages — 채팅 히스토리 (무한 스크롤)
  @Get(':id/messages')
  async messages(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: ListMessagesDto,
  ): Promise<{ data: ChatMessageView[] }> {
    // 그 방의 참여 멤버만 대화를 볼 수 있습니다(외부인 차단).
    await this.chatService.assertMember(req.user.userId, id);
    const data = await this.chatService.getHistory(id, {
      limit: query.limit,
      before: query.before,
    });
    return { data };
  }

  // GET /api/v1/study-rooms/:id/members — 참여 멤버 목록 (신고 대상 picker 등)
  @Get(':id/members')
  async members(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: StudyRoomMemberView[] }> {
    const data = await this.studyroomService.getMembers(req.user.userId, id);
    return { data };
  }
}
