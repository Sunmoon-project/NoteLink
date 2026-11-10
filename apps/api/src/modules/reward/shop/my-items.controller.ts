import {
    Controller,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Post,
    Req,
    UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../../auth/jwt-auth.guard.js';
import { ShopService, type UserItemView } from './shop.service.js';
import { requireUserId } from '../../../common/request-user.js';

// 주소는 /api/v1/users/me/items — "내" 아이템이라 전부 로그인 필요
@Controller('users/me/items')
@UseGuards(JwtAuthGuard)
export class MyItemsController {
    constructor(private readonly shop: ShopService) { }

    /** GET /api/v1/users/me/items */
    @Get()
    async list(@Req() req: AuthenticatedRequest): Promise<{ data: UserItemView[] }> {
        return { data: await this.shop.listMyItems(requireUserId(req)) };
    }

    /** POST /api/v1/users/me/items/:itemId/equip */
    @Post(':itemId/equip')
    @HttpCode(204)
    async equip(@Req() req: AuthenticatedRequest, @Param('itemId') itemId: string): Promise<void> {
        const ok = await this.shop.equip(requireUserId(req), itemId);
        if (!ok) {
            throw new NotFoundException({ code: 'NOT_FOUND', message: '보유하지 않은 아이템입니다.' });
        }
    }
}