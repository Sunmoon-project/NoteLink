import { MaterialKind, MaterialSource } from '@notelink/shared';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** 앞뒤 공백을 지운다(문자열이 아니면 그대로 두어 IsString 이 거절) */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** 노트 등록 상한. 노트 정리 처리기의 업로드 수 상한(NOTE_MAX_PAGES)과 같다 */
export const MATERIAL_MAX_FILES = 50;
export const MATERIAL_TITLE_MAX = 100;
export const MATERIAL_DESCRIPTION_MAX = 500;

/** POST /materials 본문 (packages/shared createMaterial 인자에서 requestId 를 뺀 것 — 키는 헤더로 온다) */
export class CreateMaterialDto {
  @IsMongoId() folderId: string;

  @IsIn(MaterialKind.options) kind: (typeof MaterialKind.options)[number];

  @IsIn(MaterialSource.options) source: (typeof MaterialSource.options)[number];

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MATERIAL_TITLE_MAX)
  title: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(MATERIAL_DESCRIPTION_MAX)
  description?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MATERIAL_MAX_FILES)
  @IsString({ each: true })
  @MaxLength(2048, { each: true })
  blobUrls: string[];

  @IsOptional() @IsMongoId() avatarItemId?: string | null;
}
