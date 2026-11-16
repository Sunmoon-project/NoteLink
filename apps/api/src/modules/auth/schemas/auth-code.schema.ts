import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument } from 'mongoose';

/** 인증번호를 받는 목적. 같은 이메일이라도 목적이 다르면 서로 다른 인증번호다 */
/** signup: 가입 · recovery: 아이디 찾기 · 비밀번호 재설정 */
export const AUTH_CODE_PURPOSES = ['signup', 'recovery'] as const;
export type AuthCodePurpose = (typeof AUTH_CODE_PURPOSES)[number];

export type AuthCodeDocument = HydratedDocument<AuthCode>;

/**
 * 이메일로 보낸 6자리 인증번호의 상태. 이메일 + 목적당 문서 하나를 두고, 다시 보낼 때마다 같은 문서를 덮어쓴다.
 * 발송 횟수 제한도 이 문서에 함께 기록한다(인증번호가 만료돼도 제한은 유지되어야 하기 때문이다).
 */
@Schema({ collection: 'auth_codes', timestamps: true })
export class AuthCode {
  /** 저장 형식(소문자 · 공백 제거)의 이메일 */
  @Prop({ required: true, type: String, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true, type: String, enum: AUTH_CODE_PURPOSES })
  purpose: AuthCodePurpose;

  /**
   * 인증번호의 HMAC-SHA256(서버 비밀값으로 서명). 원문은 저장하지 않는다.
   * 6자리는 경우의 수가 100만뿐이라 단순 해시는 유출 즉시 역산되므로, 비밀값 없이는 계산할 수 없게 한다.
   */
  @Prop({ required: true, type: String })
  codeHash: string;

  /** 틀리게 입력한 횟수. 한도에 닿으면 이 인증번호는 더 이상 시도할 수 없다 */
  @Prop({ required: true, type: Number, default: 0, min: 0 })
  attempts: number;

  /** 이 시각이 지나면 인증번호를 쓸 수 없다 */
  @Prop({ required: true, type: Date })
  expiresAt: Date;

  /** 검증에 성공해 쓴 시각. 채워지면 같은 인증번호를 다시 쓸 수 없다. 새로 보내면 다시 null이 된다 */
  @Prop({ type: Date, default: null })
  usedAt: Date | null;

  /**
   * 인증을 마친 이메일로 가입을 끝낸(증표를 쓴) 시각. 채워지면 같은 증표로 다시 가입할 수 없다.
   * 새로 보내면 다시 null이 된다.
   */
  @Prop({ type: Date, default: null })
  consumedAt: Date | null;

  /** 마지막으로 보낸 시각. 너무 빨리 다시 보내는 것을 막는 데 쓴다 */
  @Prop({ required: true, type: Date })
  lastSentAt: Date;

  /** 현재 제한 구간에서 보낸 횟수 */
  @Prop({ required: true, type: Number, default: 1, min: 1 })
  sendCount: number;

  /** 이 시각까지가 현재 제한 구간이다. 지나면 횟수를 처음부터 센다. 문서를 지우는 기준이 아니다(`retainUntil` 참고) */
  @Prop({ required: true, type: Date })
  windowEndsAt: Date;

  /**
   * 발송(발급)마다 새로 정해지는 식별자. 확인이 "이 발급의 번호를 썼다"고 표시할 때 조건으로 걸어,
   * 비교하는 사이에 재발급된 새 번호를 이전 번호의 확인이 쓴 것으로 만들지 못하게 한다.
   */
  @Prop({ required: true, type: String })
  issueId: string;

  /**
   * 이 시각이 지나면 MongoDB가 문서를 지운다(TTL 인덱스). 발송 제한 구간 끝(`windowEndsAt`), 인증번호 만료(`expiresAt`),
   * 인증 성공 후 증표 수명 중 가장 늦은 때와 같거나 늦어야 한다. 제한 구간만 기준으로 삼으면
   * 구간 끝 무렵에 재발급한 번호가 유효 시간이 남았는데도 지워진다.
   */
  @Prop({ required: true, type: Date })
  retainUntil: Date;
}

export const AuthCodeSchema = SchemaFactory.createForClass(AuthCode);

// 이메일 + 목적당 하나. 동시에 처음 보내는 요청이 문서를 둘 만들지 못하게 하는 마지막 방어선이다
AuthCodeSchema.index({ email: 1, purpose: 1 }, { unique: true });

// 보관 기한이 지나면 MongoDB가 문서를 지운다(삭제는 최대 1분쯤 늦을 수 있어, 만료 · 구간 종료는 코드에서도 확인한다)
AuthCodeSchema.index({ retainUntil: 1 }, { expireAfterSeconds: 0 });
