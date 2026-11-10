import {
    ArrayUnique,
    IsArray,
    IsIn,
    IsMongoId,
    IsString,
    Matches,
    MaxLength,
    MinLength
} from 'class-validator';

const LEARNER_TYPES = ['middle_high', 'university', 'worker'] as const;

export class UpdateProfileDto {
    @IsString()
    @MinLength(2)
    @MaxLength(10)
    @Matches(/^[가-힣a-zA-Z0-9]+$/, {
        message: '닉네임은 한글, 영문, 숫자만 사용할 수 있습니다.',
    })
    nickname: string;

    @IsIn(LEARNER_TYPES)
    learnerType: (typeof LEARNER_TYPES)[number];

    @IsArray()
    @ArrayUnique()
    @IsMongoId({ each: true })
    interestCategoryIds: string[];
}
