import { IsBoolean, IsInt } from 'class-validator';

// PUT /goals/weekly { targetMin, notify80 }
// targetMin은 서비스에서 0 ~ 7일(10,080분)로 맞춘다 (앱 mock과 같은 동작)
export class SetWeeklyGoalDto {
    @IsInt()
    targetMin!: number;

    @IsBoolean()
    notify80!: boolean;
}
