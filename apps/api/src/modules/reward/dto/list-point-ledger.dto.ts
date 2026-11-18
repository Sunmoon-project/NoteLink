import { IsIn, IsMongoId, IsNumberString, IsOptional } from 'class-validator';

export const LEDGER_TYPES = ['earn', 'spend'] as const;
export type LedgerType = (typeof LEDGER_TYPES)[number];

// GET /points/ledger?type=earn&limit=20&cursor=<마지막 항목의 _id>
export class ListPointLedgerDto {
    @IsOptional()
    @IsIn(LEDGER_TYPES)
    type?: LedgerType;

    // 앞 페이지의 마지막 항목 _id. 이보다 오래된 내역부터 돌려준다
    @IsOptional()
    @IsMongoId()
    cursor?: string;

    // 주소의 값은 글자라서 "숫자 모양의 글자"만 검사하고, 숫자로 바꾸는 건 서비스에서 한다
    @IsOptional()
    @IsNumberString({ no_symbols: true })
    limit?: string;
}