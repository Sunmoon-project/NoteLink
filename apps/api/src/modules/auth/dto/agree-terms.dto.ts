import { ArrayUnique, IsArray, IsIn } from 'class-validator';

import { TERM_CODES } from '../terms/terms.constants.js';

/** POST /auth/terms 요청. 동의한 약관 코드만 보낸다 */
export class AgreeTermsDto {
  @IsArray()
  @ArrayUnique()
  @IsIn(TERM_CODES, { each: true })
  termCodes: string[];
}
