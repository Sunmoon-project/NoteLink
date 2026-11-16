import { IsNumber, IsString, MaxLength, Min } from 'class-validator';

// POST /study-sessions/:id/end { clientDurationSec, endReason }
export class EndStudySessionDto {
    // 앱이 잰 시간. 서버가 다시 계산하므로 참고용일 뿐이다
    @IsNumber()
    @Min(0)
    clientDurationSec!: number;

    @IsString()
    @MaxLength(50)
    endReason!: string;
}
