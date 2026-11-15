import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { MATERIAL_MAX_FILES } from '../../content/materials/dto/create-material.dto.js';

/** 검사할 사진 하나. sizeBytes 는 앱이 아는 크기(모르면 0) — 서버는 저장소의 실제 크기로 본다 */
export class ImageCheckFileDto {
  @IsString() @MinLength(1) @MaxLength(255) name: string;

  @IsInt() @Min(0) sizeBytes: number;

  /** 앱이 올린 파일의 blob 주소(SAS 없음, POST /uploads/sas 의 blobUrl) */
  @IsString() @MinLength(1) @MaxLength(2048) uri: string;
}

/** POST /images/check 본문 (packages/shared PATHS.imageCheck · 앱 api.content.checkImages). 노트 한 개에 올릴 수 있는 만큼까지 */
export class CheckImagesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MATERIAL_MAX_FILES)
  @ValidateNested({ each: true })
  @Type(() => ImageCheckFileDto)
  files: ImageCheckFileDto[];
}
