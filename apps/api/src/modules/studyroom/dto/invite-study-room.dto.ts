import { ArrayMaxSize, ArrayMinSize, IsArray, IsMongoId } from 'class-validator';

export class InviteStudyRoomDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsMongoId({ each: true })
  userIds: string[];
}
