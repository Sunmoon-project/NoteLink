import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsObject,
  IsOptional,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

/** 한 번에 공유할 수 있는 노트 수 */
export const SHARE_MAX_MATERIALS = 20;

/** 한 번에 보낼 수 있는 친구 수(시간표 공유와 같다) */
export const SHARE_MAX_FRIENDS = 50;

/** 스터디룸은 id 하나, 친구는 ids 여러 명(#554) */
export class ShareTargetDto {
  @IsIn(['room', 'friend']) type: 'room' | 'friend';

  @ValidateIf((t: ShareTargetDto) => t.type === 'room')
  @IsMongoId()
  id?: string;

  @ValidateIf((t: ShareTargetDto) => t.type === 'friend')
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHARE_MAX_FRIENDS)
  @IsMongoId({ each: true })
  ids?: string[];
}

/** POST friend-shares/:id/copy 본문. 폴더를 안 주면 최근에 쓴 내 폴더 */
export class CopyFriendShareDto {
  @IsOptional() @IsMongoId() folderId?: string;
}

/** POST /materials/share 본문 (apps/mobile api.content.share 인자와 같다) */
export class ShareMaterialsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SHARE_MAX_MATERIALS)
  @IsMongoId({ each: true })
  materialIds: string[];

  @IsObject()
  @ValidateNested()
  @Type(() => ShareTargetDto)
  target: ShareTargetDto;
}
