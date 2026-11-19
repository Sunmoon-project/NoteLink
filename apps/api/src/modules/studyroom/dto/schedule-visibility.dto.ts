import { IsBoolean } from 'class-validator';

/** PATCH /study-rooms/:id/schedule/visibility — true면 이 방 시간표에서 내 수업 시간을 숨긴다 */
export class ScheduleVisibilityDto {
  @IsBoolean()
  hidden: boolean;
}
