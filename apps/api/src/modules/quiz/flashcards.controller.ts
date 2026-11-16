import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';

import { requireUserId } from '../../common/request-user.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../auth/jwt-auth.guard.js';
import { DeleteFlashcardsDto, SaveFlashcardDto } from './dto/flashcard.dto.js';
import { FlashcardsService, type AppFlashcard } from './flashcards.service.js';

// 주소는 /api/v1/flashcards... (packages/shared PATHS.flashcards · flashcardsDelete). 내 카드라 로그인 필요
@Controller('flashcards')
@UseGuards(JwtAuthGuard)
export class FlashcardsController {
  constructor(private readonly flashcards: FlashcardsService) {}

  /** GET /api/v1/flashcards → 200 { data: Flashcard[] } */
  @Get()
  async list(@Req() req: AuthenticatedRequest): Promise<{ data: AppFlashcard[] }> {
    return { data: await this.flashcards.list(requireUserId(req)) };
  }

  /** POST /api/v1/flashcards { front, back, sourceQuestionId? } → 201 { data: Flashcard } */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async save(@Req() req: AuthenticatedRequest, @Body() body: SaveFlashcardDto): Promise<{ data: AppFlashcard }> {
    return { data: await this.flashcards.save(requireUserId(req), body) };
  }

  /** POST /api/v1/flashcards/delete { ids } → 204 */
  @Post('delete')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() req: AuthenticatedRequest, @Body() body: DeleteFlashcardsDto): Promise<void> {
    await this.flashcards.remove(requireUserId(req), body.ids);
  }
}
