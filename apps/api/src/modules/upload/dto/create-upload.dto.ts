import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateUploadDto {
  @IsIn(['image', 'document', 'audio']) kind: 'image' | 'document' | 'audio';
  @IsString() @MinLength(1) @MaxLength(255) fileName: string;
  @IsString() @MinLength(1) @MaxLength(100) contentType: string;
  @IsInt() @Min(1) @Max(500 * 1024 * 1024) sizeBytes: number;
  @IsOptional() @IsIn(['report']) purpose?: 'report';
}
