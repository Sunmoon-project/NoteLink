import { IsString, Matches } from 'class-validator';

/**
 * 서버가 생성한 6자리 inviteCode를 받아서 해당 방에 참여합니다.
 */
export class JoinStudyRoomDto {
  @IsString()
  @Matches(/^[A-Z0-9]{6}$/, {
    message: '초대 코드는 영문 대문자와 숫자 6자리여야 합니다.',
  })
  inviteCode: string;
}
