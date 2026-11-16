import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsObject,
  ValidateNested,
} from 'class-validator';

/** 한 번에 공유할 수 있는 노트 수 */
export const SHARE_MAX_MATERIALS = 20;

export class ShareTargetDto {
  @IsIn(['room', 'friend']) type: 'room' | 'friend';

  @IsMongoId() id: string;
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
