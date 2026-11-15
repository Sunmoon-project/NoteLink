import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** 한 번에 검사하는 사진 수 상한. 노트 한 개에 올릴 수 있는 수(materials CreateMaterialDto MATERIAL_MAX_FILES)와 같다 */
export const IMAGE_CHECK_MAX_FILES = 50;

/** 검사할 사진 하나 */
export class ImageCheckFileDto {
  /** 앱이 결과를 맞추는 이름(앱은 `<순서>-<기기 파일 이름>`을 보낸다). 기기 파일 이름이 길어도 받도록 넉넉히 */
  @IsString() @MinLength(1) @MaxLength(1024) name: string;

  /** 앱이 아는 크기(모르면 0). 서버는 저장소의 실제 크기로 보므로 쓰지 않는다 */
  @IsOptional() @IsNumber() @Min(0) sizeBytes?: number;

  /** 앱이 올린 파일의 blob 주소(SAS 없음, POST /uploads/sas 의 blobUrl) */
  @IsString() @MinLength(1) @MaxLength(2048) uri: string;
}

/** POST /images/check 본문 (packages/shared PATHS.imageCheck · 앱 api.content.checkImages) */
export class CheckImagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(IMAGE_CHECK_MAX_FILES)
  @ValidateNested({ each: true })
  @Type(() => ImageCheckFileDto)
  files: ImageCheckFileDto[];
}
