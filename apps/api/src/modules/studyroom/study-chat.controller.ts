import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { IsMongoId, IsOptional } from 'class-validator';
import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { StudyChatService } from './study-chat.service.js';

class MessageHistoryQuery {
  @IsOptional()
  @IsMongoId()
  before?: string;
}

@Controller('chat-rooms')
@UseGuards(JwtAuthGuard)
export class StudyChatController {
  constructor(private readonly chat: StudyChatService) {}

  @Get(':id/messages')
  async history(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: MessageHistoryQuery,
  ) {
    return { data: await this.chat.history(id, requireUserId(req), query.before) };
  }
}
