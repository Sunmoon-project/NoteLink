import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72) // bcrypt는 72바이트까지만 반영합니다.
  password: string;

  @IsString()
  @MinLength(1)
  @MaxLength(20)
  nickname: string;
}
