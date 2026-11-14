import { IsIn, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** PATCH /users/me/status — 친구 목록 · 스터디룸에 보이는 내 상태 */
export class UpdateStatusDto {
  @IsIn(['active', 'busy', 'resting', 'offline'])
  status!: 'active' | 'busy' | 'resting' | 'offline';
}

/** POST /users/me/devices — 푸시 알림을 받을 기기 */
export class RegisterDeviceDto {
  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';

  // Expo · FCM · APNs 토큰. 길이만 묶어 엉뚱한 값이 쌓이지 않게 한다
  @IsString()
  @MinLength(10)
  @MaxLength(512)
  pushToken!: string;

  // 예: ko-KR, en-US
  @IsString()
  @Matches(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/)
  @MaxLength(35)
  locale!: string;
}

/** PATCH /users/me/subscription — 요금제 */
export class ChangePlanDto {
  @IsIn(['free', 'pro', 'max'])
  tier!: 'free' | 'pro' | 'max';
}
