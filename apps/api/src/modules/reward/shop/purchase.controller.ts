import { Body, Controller, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../../auth/jwt-auth.guard.js';
import { CreatePurchaseDto } from '../dto/create-purchase.dto.js';
import { ShopService } from './shop.service.js';
import { requireUserId } from '../../../common/request-user.js';

// 주소는 /api/v1/shop/purchases — 누가 사는지 알아야 해서 로그인 필요
@Controller('shop/purchases')
@UseGuards(JwtAuthGuard)
export class PurchaseController {
    constructor(private readonly shop: ShopService) { }

    /** POST /api/v1/shop/purchases { itemId } → { data: { balance } } */
    @Post()
    async purchase(
        @Req() req: AuthenticatedRequest,
        @Body() body: CreatePurchaseDto,
    ): Promise<{ data: { balance: number } }> {
        const result = await this.shop.purchase(requireUserId(req), body.itemId);
        if (!result) {
            throw new NotFoundException({ code: 'NOT_FOUND', message: '존재하지 않는 아이템입니다.' });
        }
        return { data: result };
    }
}
