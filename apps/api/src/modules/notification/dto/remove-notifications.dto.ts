import { ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId } from 'class-validator';

/** POST /notifications/delete — 고른 알림 여러 개 지우기(한 번에 최대 100개) */
export class RemoveNotificationsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  ids: string[];
}
