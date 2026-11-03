import {
  IsBoolean,
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
 * 사용자 입력: 이름(title) · 카테고리(categoryName) · 공개여부(isPublic)
 * hostId·inviteCode·memberCount 등은 서버가 채웁니다.
 */
export class CreateStudyRoomDto {
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  title: string;

  // 앱의 카테고리 이름 (packages/shared Api.rooms.create)
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  categoryName: string;

  @IsBoolean()
  isPublic: boolean;

  // 최대 인원(선택). 안 보내면 스키마 기본값 6명.
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(50)
  maxCapacity?: number;
}
