import {
    Controller,
    Get,
    HttpCode,
    NotFoundException,
    Param,
    Post,
    Query,
    Req,
    UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import type { AuthenticatedRequest } from '../../auth/jwt-auth.guard.js';
import { ListShopItemsDto } from '../dto/list-shop-items.dto.js';
import { ShopService, type ShopItemView } from './shop.service.js';
import { requireUserId } from '../../../common/request-user.js';

@Controller('shop/items')
export class ShopController {
    constructor(private readonly shop: ShopService) { }

    /** GET /api/v1/shop/items?category=&sort= */
    @Get()
    async list(@Query() query: ListShopItemsDto): Promise<{ data: ShopItemView[] }> {
        return { data: await this.shop.listItems(query.category, query.sort) };
    }

    /** POST /api/v1/shop/items/:itemId/wish (로그인 필요) */
    @Post(':itemId/wish')
    @HttpCode(200)
    @UseGuards(JwtAuthGuard) // 찜은 "누가" 눌렀는지 알아야 해서 로그인 필요
    async wish(
        @Req() req: AuthenticatedRequest,
        @Param('itemId') itemId: string,
    ): Promise<{ data: { isWished: boolean } }> {
        // userId는 앱이 보내는 값이 아니라, 토큰에서 꺼낸 "로그인한 사용자"
        const result = await this.shop.toggleWish(requireUserId(req), itemId);
        if (!result) {
            throw new NotFoundException({ code: 'NOT_FOUND', message: '존재하지 않는 아이템입니다.' });
        }
        return { data: result };
    }
}