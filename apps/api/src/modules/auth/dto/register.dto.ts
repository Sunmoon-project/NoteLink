// apps/api/src/modules/auth/dto/register.dto.ts

import { Transform } from 'class-transformer';
import { IsByteLength, IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  // 스키마가 소문자·공백 제거로 저장하므로 검증 전에 같은 모양으로 맞춘다.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @IsByteLength(8, 72) // bcrypt는 72바이트까지만 반영합니다. 한글은 글자당 3바이트라 글자 수로는 못 막습니다.
  password: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  nickname: string;
}
