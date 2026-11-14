import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsMongoId, IsOptional, IsString } from 'class-validator';
import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard, type AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { StudyChatService } from './study-chat.service.js';

class MessageHistoryQuery {
  @IsOptional()
  @IsMongoId()
  before?: string;
}

class OpenDirectChatDto {
  @IsString()
  @IsMongoId()
  userId: string;
}

@Controller('chat-rooms')
@UseGuards(JwtAuthGuard)
export class StudyChatController {
  constructor(private readonly chat: StudyChatService) {}

  @Post('direct')
  async direct(@Req() req: AuthenticatedRequest, @Body() body: OpenDirectChatDto) {
    const chat = await this.chat.getDirectChat(requireUserId(req), body.userId);
    return { data: { _id: String(chat._id) } };
  }

  @Get(':id/messages')
  async history(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Query() query: MessageHistoryQuery,
  ) {
    return { data: await this.chat.history(id, requireUserId(req), query.before) };
  }
}
