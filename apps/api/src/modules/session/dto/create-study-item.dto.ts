import { IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

// POST /study/items { title, subjectName, goalMin }
export class CreateStudyItemDto {
    @IsString()
    @MinLength(1)
    @MaxLength(100) // 앱에는 제목 길이 제한이 없어서, 앱이 보낸 글을 막지 않도록 넉넉하게
    title!: string;

    // 과목 이름. 목록에 없거나 비어 있으면 과목 없이 만든다
    @IsString()
    @MaxLength(20)
    subjectName!: string;

    // 목표 분. 없거나 null이면 목표 없음. 앱과 같이 1분 ~ 24시간 (FR-06-23)
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(24 * 60)
    goalMin?: number | null;
}
