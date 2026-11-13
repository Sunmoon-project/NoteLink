import { IsIn, IsString, Matches } from 'class-validator';

export const STATS_RANGES = ['all', '90d', '30d'] as const;
export type StatsRange = (typeof STATS_RANGES)[number];

/** GET /study/month?ym=2026-11 */
export class MonthQueryDto {
    @IsString()
    @Matches(/^\d{4}-(0[1-9]|1[0-2])$/)
    ym!: string;
}

/** GET /study/stats?range=all|90d|30d */
export class StatsQueryDto {
    @IsIn(STATS_RANGES)
    range!: StatsRange;
}
