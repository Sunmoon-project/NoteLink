import { IsMongoId } from 'class-validator';

// POST /shop/purchases { itemId }
export class CreatePurchaseDto {
    @IsMongoId()
    itemId!: string;
}
