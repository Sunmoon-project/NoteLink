import { IsString, Length } from 'class-validator';

/**
 * 서버가 생성한 6자리 inviteCode를 받아서 해당 방에 참여합니다.
 */
export class JoinStudyRoomDto {
  @IsString()
  @Length(6, 6)
  inviteCode: string;
}
