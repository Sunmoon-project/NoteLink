import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { type HydratedDocument, Types } from 'mongoose';

export const SOCIAL_PROVIDERS = ['google', 'kakao', 'naver'] as const;
export type SocialProviderName = (typeof SOCIAL_PROVIDERS)[number];

export type SocialLoginAttemptDocument = HydratedDocument<SocialLoginAttempt>;

/**
 * 소셜 로그인 한 번(시작 → 제공자 로그인 → 앱이 코드 교환)의 진행 상태.
 * 끝나면 지워지는 임시 문서이고, 만료 시각이 지나면 MongoDB가 알아서 지운다.
 */
@Schema({ timestamps: true, collection: 'social_login_attempts' })
export class SocialLoginAttempt {
  @Prop({ required: true, type: String, enum: SOCIAL_PROVIDERS })
  provider: SocialProviderName;

  /** 서버가 만들어 제공자(구글 등)에게 보내고 콜백에서 돌려받는 값. 이 로그인 시도를 찾는 열쇠이자 CSRF 방어 */
  @Prop({ required: true, type: String, unique: true })
  oauthState: string;

  /** 앱이 보낸 state. 앱으로 돌아갈 때 그대로 돌려줘서 앱이 자기 시도임을 확인하게 한다 */
  @Prop({ required: true, type: String })
  appState: string;

  /** 앱이 보낸 PKCE code_challenge(S256). 코드 교환 때 codeVerifier의 해시와 맞는지 본다 */
  @Prop({ required: true, type: String })
  codeChallenge: string;

  /** 제공자 인증이 끝나면 채운다. 그 전에는 null */
  @Prop({ type: Types.ObjectId, ref: 'User', default: null })
  userId: Types.ObjectId | null;

  /** 앱에 넘겨준 1회용 코드의 SHA-256 해시(원문은 저장하지 않는다). 제공자 인증이 끝나면 채운다 */
  @Prop({ type: String, default: null })
  codeHash: string | null;

  /** 이 시각이 지나면 쓸 수 없다. 시작 직후에는 길게, 코드를 내준 뒤에는 짧게 줄인다 */
  @Prop({ required: true, type: Date })
  expiresAt: Date;
}

export const SocialLoginAttemptSchema = SchemaFactory.createForClass(SocialLoginAttempt);

// 만료 시각이 지나면 MongoDB가 문서를 지운다(삭제는 최대 1분쯤 늦을 수 있으니 조회할 때도 expiresAt을 확인한다)
SocialLoginAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// 코드는 하나만 유효해야 한다. 아직 코드가 없는(null) 문서끼리는 겹쳐도 되므로 문자열인 문서만 검사한다
SocialLoginAttemptSchema.index(
  { codeHash: 1 },
  { unique: true, partialFilterExpression: { codeHash: { $type: 'string' } } },
);
