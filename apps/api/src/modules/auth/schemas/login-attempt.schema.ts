import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

export type LoginAttemptDocument = HydratedDocument<LoginAttempt>;

/**
 * 이메일 로그인 시도 횟수. 이메일마다 문서 하나를 두고, 마지막 시도로부터 일정 시간이 지나면 MongoDB가 알아서 지운다.
 * 계정이 있는지와 상관없이 이메일 기준으로 센다: 존재하는 계정만 잠기면 잠금 여부로 가입 여부가 드러난다.
 */
@Schema({ collection: 'login_attempts', timestamps: true })
export class LoginAttempt {
  /** 저장 형식(소문자 · 공백 제거)의 이메일 */
  @Prop({ required: true, type: String, lowercase: true, trim: true, unique: true })
  email: string;

  /** 한도에 닿기 전까지 쓴 시도 횟수(비밀번호를 확인하기 전에 먼저 센다) */
  @Prop({ required: true, type: Number, default: 1, min: 1 })
  attempts: number;

  /** 마지막으로 시도를 쓴 시각. 한도에 닿은 뒤로는 갱신하지 않는다(갱신하면 잠금이 끝없이 늘어난다) */
  @Prop({ required: true, type: Date })
  lastAttemptAt: Date;

  /** 이 시각이 지나면 MongoDB가 문서를 지운다 */
  @Prop({ required: true, type: Date })
  expiresAt: Date;
}

export const LoginAttemptSchema = SchemaFactory.createForClass(LoginAttempt);

// 만료 시각이 지나면 MongoDB가 문서를 지운다(삭제는 최대 1분쯤 늦을 수 있어, 구간이 끝났는지는 코드에서도 확인한다)
LoginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
