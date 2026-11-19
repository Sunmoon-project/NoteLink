import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsMongoId,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * 스터디룸 만들기 요청 (발표자료 p.75 "3. 스터디룸 만들기")
 * 사용자 입력: 이름(title) · 카테고리(categoryIds, 관심 분야 id 최대 3개) · 공개여부(isPublic)
 * categoryName(이름 하나)은 구 앱 호환용으로 한 버전만 더 받는다. 둘 다 오면 categoryIds를 쓴다.
 * hostId·inviteCode·memberCount 등은 서버가 채웁니다.
 */
export class CreateStudyRoomDto {
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  title: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsMongoId({ each: true })
  categoryIds?: string[];

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  categoryName?: string;

  @IsBoolean()
  isPublic: boolean;

  // 최대 인원(선택). 안 보내면 스키마 기본값 6명.
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(50)
  maxCapacity?: number;
}
