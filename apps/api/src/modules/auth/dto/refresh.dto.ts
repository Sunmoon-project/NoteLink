// apps/api/src/modules/auth/dto/refresh.dto.ts

import { IsJWT } from 'class-validator';

export class RefreshDto {
  @IsJWT()
  refreshToken: string;
}
