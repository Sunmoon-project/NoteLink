import type { Types } from 'mongoose';

/** 앱이 읽는 설정의 기본값. 앱의 로컬 모드 기본값(apps/mobile/src/lib/local/api.ts newDb)과 같게 맞춘다 */
const DEFAULT_SETTINGS = {
  resumePlayback: true,
  keepScreenOnWhileRecording: true,
  subtitleLanguage: '한국어',
  pageTurn: 'swipe',
  offlineCache: false,
  theme: 'light',
  doubleTapEraser: true,
  leftHanded: false,
} as const;

/** 앱이 정해 둔 상태 값(packages/shared User.status) */
const STATUSES = ['active', 'busy', 'resting', 'offline'] as const;
const LEARNER_TYPES = ['middle_high', 'university', 'worker'] as const;
type Status = (typeof STATUSES)[number];
type LearnerType = (typeof LEARNER_TYPES)[number];

/**
 * 가입 직후에는 학습자 유형이 정해지지 않았다(DB에서는 null). 앱의 타입은 필수라서 기본값을 보내고,
 * 사용자는 프로필 설정 화면에서 직접 고른다(앱 로컬 모드의 기본값과 같다).
 */
const DEFAULT_LEARNER_TYPE: LearnerType = 'university';

/** 응답에 쓰는 사용자의 DB 문서에서 필요한 부분(Mongoose 문서든 lean 객체든 받을 수 있게 느슨하게 둔다) */
export interface UserSource {
  _id: Types.ObjectId;
  email?: string | null;
  nickname: string;
  role?: string;
  learnerType?: string | null;
  pointBalance?: number;
  settings?: Record<string, unknown>;
  status?: string;
  interestCategoryIds?: Types.ObjectId[];
  subscription?: { tier?: string; status?: string; currentPeriodEnd?: Date | null } | null;
  createdAt?: Date;
}

const PLAN_TIERS = ['free', 'pro', 'max'] as const;

/** `packages/shared` 의 `User` 모양. 서버는 이 패키지에 의존하지 않아 필요한 부분을 여기에 둔다 */
export interface AppUser {
  _id: string;
  email: string | null;
  nickname: string;
  role: string;
  learnerType: LearnerType;
  pointBalance: number;
  settings: typeof DEFAULT_SETTINGS & Record<string, unknown>;
  status: Status;
  interestCategoryIds: string[];
  streakDays: number;
  /** 요금제(packages/shared User.subscription). 기록이 없으면 보내지 않는다(앱은 Free로 본다) */
  subscription?: { tier: (typeof PLAN_TIERS)[number]; status: string; currentPeriodEnd?: string };
  createdAt: string;
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/**
 * DB의 사용자 문서를 앱이 기대하는 `User` 모양으로 바꾼다. 비밀번호 해시 · 소셜 연동 정보 등 앱에 필요 없는 값은 내보내지 않는다.
 * 허용 목록에 있는 필드만 골라 담는 방식이라, 스키마에 필드가 늘어도 자동으로 새어 나가지 않는다.
 */
export function toAppUser(user: UserSource, streakDays = 0): AppUser {
  return {
    _id: String(user._id),
    email: user.email ?? null,
    nickname: user.nickname,
    role: user.role ?? 'user',
    learnerType: oneOf(LEARNER_TYPES, user.learnerType, DEFAULT_LEARNER_TYPE),
    pointBalance: Number.isInteger(user.pointBalance) ? (user.pointBalance as number) : 0,
    // 사용자가 바꾼 값을 우선하되, 앱이 읽는 8개 필드는 항상 채워서 내려보낸다
    settings: { ...DEFAULT_SETTINGS, ...(user.settings ?? {}) },
    status: oneOf(STATUSES, user.status, 'active'),
    interestCategoryIds: (user.interestCategoryIds ?? []).map(String),
    // 연속 학습일은 학습 기록(ProgressService.streakDays)에서 서울 자정 기준으로 계산해 넘겨받는다. 안 넘기면 0이다
    streakDays,
    ...(user.subscription?.tier
      ? {
          subscription: {
            tier: oneOf(PLAN_TIERS, user.subscription.tier, 'free'),
            status: user.subscription.status ?? 'active',
            ...(user.subscription.currentPeriodEnd
              ? { currentPeriodEnd: user.subscription.currentPeriodEnd.toISOString() }
              : {}),
          },
        }
      : {}),
    createdAt: (user.createdAt ?? new Date()).toISOString(),
  };
}
