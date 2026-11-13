import { z } from 'zod';

// 발표 자료 p.23~28 MongoDB 스키마를 API 응답 형태로 옮긴 것.
// ObjectId·Date는 JSON으로 오가므로 string(ISO)으로 표현한다.

const id = z.string();
const date = z.iso.datetime(); // ISO 8601 (UTC, 끝이 Z)
const ymd = z.iso.date(); // 'YYYY-MM-DD' (서울 기준 날짜)

/* ── 1. 회원 · 인증 ─────────────────────────────── */

export const LearnerType = z.enum(['middle_high', 'university', 'worker']);
export const PlanTier = z.enum(['free', 'pro', 'max']);

export const UserSettings = z.object({
  resumePlayback: z.boolean(),
  keepScreenOnWhileRecording: z.boolean(),
  subtitleLanguage: z.string(),
  pageTurn: z.enum(['swipe', 'scroll', 'tap']),
  offlineCache: z.boolean(),
  theme: z.enum(['light', 'dark']),
  doubleTapEraser: z.boolean(),
  leftHanded: z.boolean(),
});

export const User = z.object({
  _id: id,
  email: z.string().nullable(),
  nickname: z.string(),
  role: z.string(),
  learnerType: LearnerType,
  pointBalance: z.number().int(),
  settings: UserSettings,
  status: z.enum(['active', 'busy', 'resting', 'offline']),
  interestCategoryIds: z.array(id),
  school: z.string().optional(),
  grade: z.string().optional(),
  phone: z.string().optional(),
  avatarUrl: z.string().optional(),
  /** 지금까지 이어진 연속 학습일 (서울 자정 기준, 서버 계산 · FR-09-08) */
  streakDays: z.number().int().nonnegative(),
  subscription: z
    .object({ tier: PlanTier, status: z.string(), currentPeriodEnd: date.optional() })
    .optional(),
  usage: z
    .object({
      storageBytes: z.number(),
      storageLimitBytes: z.number(),
      aiCredits: z.number(),
      aiCreditLimit: z.number(),
    })
    .optional(),
  createdAt: date,
});

export const AuthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: User,
});
export const SocialProvider = z.enum(['kakao', 'naver', 'google']);

export const Category = z.object({
  _id: id,
  parentId: id.nullable(),
  name: z.string(),
  sortOrder: z.number(),
  isActive: z.boolean(),
});

export const Notification = z.object({
  _id: id,
  type: z.string(),
  title: z.string(),
  body: z.string(),
  data: z.record(z.string(), z.unknown()).nullable(),
  readAt: date.nullable(),
  createdAt: date,
});

/* ── 2. 상점 · 포인트 ───────────────────────────── */

export const ShopItem = z.object({
  _id: id,
  category: z.enum(['avatar', 'theme']),
  name: z.string(),
  description: z.string().nullable(),
  price: z.number().int(),
  avatarStyle: z.string().nullable(),
  thumbnailUrl: z.string().nullable(),
  assetUrl: z.string(),
  purchaseCount: z.number().int(),
  isActive: z.boolean(),
  isDefault: z.boolean(),
  badge: z.enum(['NEW', 'BEST']).nullable().optional(),
});

export const UserItem = z.object({
  _id: id,
  itemId: id,
  itemCategory: z.string(),
  isOwned: z.boolean(),
  isWished: z.boolean(),
  isEquipped: z.boolean(),
  acquiredAt: date.nullable(),
});

export const PointLedger = z.object({
  _id: id,
  amount: z.number().int(),
  balanceAfter: z.number().int(),
  reasonType: z.enum([
    'session_complete',
    'quiz_correct',
    'review_complete',
    'session_abuse',
    'purchase',
    'mission',
    'admin',
  ]),
  description: z.string().nullable(),
  createdAt: date,
});

/* ── 3. 노트 · 퀴즈 · AI ────────────────────────── */

export const Folder = z.object({
  _id: id,
  title: z.string(),
  subjectId: id,
  subjectName: z.string().optional(),
  createdAt: date,
  updatedAt: date,
});

export const MaterialKind = z.enum(['handwriting', 'recording', 'document']);
export const MaterialSource = z.enum([
  'camera',
  'gallery',
  'file',
  'scan',
  'live_recording',
  'audio_file',
]);

export const MaterialPage = z.object({
  pageNo: z.number().int(),
  imageUrl: z.string(),
  sizeBytes: z.number(),
  ocrText: z.string().nullable(),
  takenAt: date.nullable(),
});

export const Bookmark = z.object({ atSec: z.number(), label: z.string().optional() });

export const Material = z.object({
  _id: id,
  folderId: id,
  kind: MaterialKind,
  source: MaterialSource,
  title: z.string(),
  description: z.string().nullable(),
  avatarItemId: id.nullable(),
  processing: z.object({
    status: z.enum(['uploading', 'queued', 'processing', 'done', 'failed']),
    progress: z.number(),
    jobId: id.nullable(),
  }),
  summary: z
    .object({
      sections: z.array(z.object({ heading: z.string(), body: z.string() })),
      points: z.array(z.string()),
    })
    .nullable(),
  keywords: z.array(z.string()),
  bookmarks: z.array(Bookmark),
  pages: z.array(MaterialPage).optional(),
  createdAt: date,
});

export const Slide = z.object({
  index: z.number(),
  title: z.string(),
  bullets: z.array(z.string()),
  startSec: z.number(),
  endSec: z.number(),
});

export const Recording = z.object({
  _id: id,
  materialId: id,
  audioUrl: z.string(),
  audioSizeBytes: z.number(),
  durationSec: z.number(),
  transcript: z.object({
    text: z.string(),
    segments: z.array(z.object({ startSec: z.number(), endSec: z.number(), text: z.string() })),
  }),
  slides: z.array(Slide),
  visemeUrl: z.string().nullable(), // Rhubarb 입 모양 9종(A–H, X) 타임라인 (p.35)
});

export const QuestionType = z.enum(['multiple_choice', 'short_answer', 'ox']);
// 문제 난이도(#268). 처리기가 문제 유형으로 정한 처음 값(정의 · 빈칸 하, 특징 · 부정설명 중, 조합 상)이고
// 사용자의 정답률이 쌓이면 고친다. 난이도를 붙이기 전에 만든 문제 · 직접 만든 문제는 없다(null)
export const QuestionDifficulty = z.enum(['하', '중', '상']);
export const Question = z.object({
  _id: id,
  order: z.number(),
  type: QuestionType,
  prompt: z.string(),
  choices: z.array(z.string()).nullable(),
  answer: z.string(),
  explanation: z.string().nullable(),
  conceptTags: z.array(z.string()),
  difficulty: QuestionDifficulty.nullable().optional(),
});

export const QuizSet = z.object({
  _id: id,
  materialId: id,
  folderId: id,
  sourceSetId: id.nullable(),
  title: z.string(),
  status: z.enum(['generating', 'ready', 'failed']),
  progress: z.number(),
  questionCount: z.number(),
  questions: z.array(Question),
  createdAt: date,
});

export const AttemptAnswer = z.object({
  questionId: id,
  answer: z.string().nullable(),
  correct: z.boolean(),
  tries: z.number(),
});
export const QuizAttempt = z.object({
  _id: id,
  quizSetId: id,
  correctCount: z.number(),
  total: z.number(),
  pointsEarned: z.number(),
  answers: z.array(AttemptAnswer),
  startedAt: date,
  finishedAt: date.nullable(),
});

export const Flashcard = z.object({
  _id: id,
  materialId: id.nullable(),
  folderId: id,
  front: z.string(),
  back: z.string(),
  sourceQuizSetId: id.nullable(),
  sourceQuestionId: id.nullable(),
  lastResult: z.string().nullable(),
  createdAt: date,
});

export const AiJobType = z.enum([
  'handwriting_summary',
  'recording_summary',
  'document_summary',
  'quiz_generate',
  'quiz_pregen',
  'similar_quiz',
  'today_review',
  'explain',
  'image_check',
  'note_ask',
]);
export const AiJobStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']);
export const AiJob = z.object({
  _id: id,
  type: AiJobType,
  status: AiJobStatus,
  targetType: z.string(),
  targetId: id,
  progress: z.number(),
  attempts: z.number(),
  step: z.string().optional(),
  // 미리 해 두는 작업(quiz_pregen)을 사용자가 이어받으면 NestJS가 true로(처리기가 우선 처리)
  awaited: z.boolean().optional(),
  result: z.record(z.string(), z.unknown()).nullable(),
  error: z.string().nullable(),
  createdAt: date,
  updatedAt: date,
});

/** 아바타 노트 묻고 답하기 — POST /materials/:id/ask 본문. history는 앞선 대화(오래된 순) */
export const NoteAskTurn = z.object({
  role: z.enum(['user', 'avatar']),
  text: z.string().max(600),
});
export const NoteAskBody = z.object({
  question: z.string().trim().min(1).max(500),
  history: z.array(NoteAskTurn).max(20).default([]),
});
/**
 * note_ask 작업이 끝나면 AiJob.result에 담긴다. answerable이 false면 answer는 정해 둔 안내:
 * off_topic(학습 자료에 없는 질문) · unsafe(해킹 · 보안 공격 같은 위험한 질문)
 */
export const NoteAskResult = z.object({
  answerable: z.boolean().default(true),
  reason: z.enum(['off_topic', 'unsafe']).nullable().default(null),
  answer: z.string(),
  refs: z.array(z.string()),
});

/* ── 4. 학습 기록 · 목표 ────────────────────────── */

export const Subject = z.object({
  _id: id,
  categoryId: id.nullable(),
  name: z.string(),
  color: z.string(),
  sortOrder: z.number(),
  isActive: z.boolean(),
});

export const StudyItem = z.object({
  _id: id,
  title: z.string(),
  subjectId: id.nullable(),
  subjectName: z.string().optional(),
  goalMin: z.number().nullable(),
  accumulatedSec: z.number(),
});

export const DailyRecord = z.object({
  _id: id,
  studyDate: ymd,
  totalSec: z.number(),
  personalSec: z.number(),
  roomSec: z.number(),
  streakOk: z.boolean(),
  items: z.array(StudyItem),
});

export const SessionMode = z.enum(['personal', 'room', 'auto_landscape']);
export const StudySession = z.object({
  _id: id,
  studyDate: ymd,
  studyItemId: id.nullable(),
  roomId: id.nullable(),
  mode: SessionMode,
  status: z.enum(['running', 'paused', 'ended']),
  startedAt: date,
  endedAt: date.nullable(),
  durationSec: z.number(),
  departureCount: z.number(),
  endReason: z.string().nullable(),
  isAbuse: z.boolean(),
  pauses: z.array(
    z.object({ startedAt: date, endedAt: date.nullable(), reason: z.string().nullable() }),
  ),
});

export const WeeklyGoal = z.object({
  _id: id,
  weekStart: ymd,
  targetMin: z.number(),
  notify80: z.boolean(),
  /** 최근 4주 평균 순공 분 — 목표를 정할 때 참고로 보여 준다 (서버 계산 · FR-06-24) */
  recentAvgMin: z.number().nonnegative(),
});

export const RecurringGoal = z.object({
  _id: id,
  name: z.string(),
  days: z.array(z.number().int().min(0).max(6)),
  targetMin: z.number(),
  subjectId: id.nullable(),
  remindEnabled: z.boolean(),
  remindTime: z.string().nullable(),
  pausedUntil: date.nullable(),
  streak: z.number(),
  isActive: z.boolean(),
});

export const WeeklySummary = z.object({
  weekStart: ymd,
  totalSec: z.number(),
  diffFromLastWeekSec: z.number(),
  goalMin: z.number(),
  days: z.array(z.object({ studyDate: ymd, totalSec: z.number() })),
});
export const StudyStats = z.object({
  totalSec: z.number(),
  studyDays: z.number(),
  longestStreak: z.number(),
  peakHour: z.number(),
  heatmap: z.array(z.object({ studyDate: ymd, level: z.number() })),
});

/* ── 5. 일정 · 캘린더 · 시간표 ──────────────────── */

export const TodoType = z.enum(['general', 'assignment', 'exam']);
export const Todo = z.object({
  _id: id,
  dueDate: ymd,
  content: z.string(),
  todoType: TodoType,
  isDday: z.boolean(),
  timeSlot: z.enum(['none', 'am', 'pm', 'custom']),
  dueTime: z.string().nullable(),
  subjectId: id.nullable(),
  subjectName: z.string().optional(),
  done: z.boolean(),
  doneAt: date.nullable(),
  createdAt: date,
});

export const DDay = z.object({
  _id: id,
  title: z.string(),
  date: ymd,
  source: z.enum(['todo', 'manual']),
  kind: z.string(),
  daysLeft: z.number(),
});

export const PublicHoliday = z.object({
  _id: ymd,
  name: z.string(),
  hidden: z.boolean().optional(),
});

export const CalendarShare = z.object({
  _id: id,
  token: z.string(),
  ownerId: id,
  ownerNickname: z.string().optional(),
  rangeStart: ymd,
  rangeEnd: ymd,
  scopes: z.array(z.string()),
  expiresAt: date.nullable(),
  revokedAt: date.nullable(),
  createdAt: date,
  subscribers: z.array(z.object({ userId: id, addedAt: date })),
});

export const TimetableClass = z.object({
  _id: id,
  subjectName: z.string(),
  days: z.array(z.number().int().min(0).max(6)),
  startTime: z.string(),
  endTime: z.string(),
  location: z.string(),
  color: z.string(),
  source: z.string(),
});
export const Timetable = z.object({ _id: id, updatedAt: date, classes: z.array(TimetableClass) });
export const TimetableShare = z.object({
  _id: id,
  friendId: id,
  mode: z.enum(['full', 'free_only']),
  sharedAt: date,
});

/* ── 6. 스터디룸 · 채팅 · 소셜 ──────────────────── */

export const TimerRule = z.object({
  enabled: z.boolean(),
  type: z.enum(['pomodoro', 'period']),
  focusMin: z.number(),
  breakMin: z.number(),
  repeat: z.number(),
  periods: z.array(z.object({ start: z.string(), end: z.string(), label: z.string() })),
});

export const RoomMember = z.object({
  userId: id,
  nickname: z.string(),
  avatarUrl: z.string().nullable().optional(),
  role: z.enum(['host', 'member']),
  status: z.enum(['invited', 'joined', 'left', 'kicked']),
  camOn: z.boolean().optional(),
  micOn: z.boolean().optional(),
  todaySec: z.number().optional(),
});

export const StudyRoom = z.object({
  _id: id,
  title: z.string(),
  categoryId: id,
  categoryName: z.string().optional(),
  hostId: id,
  isPublic: z.boolean(),
  inviteCode: z.string(),
  maxCapacity: z.number(),
  memberCount: z.number(),
  timerRule: TimerRule.nullable(),
  /** 서버가 계산한 현재 단계와 UTC 종료 시각. 입장·재연결 때 로컬에서 타이머를 새로 시작하지 않는다. */
  timerState: z
    .object({ phase: z.enum(['focus', 'break', 'period']), endsAt: date.nullable() })
    .nullable()
    .optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  members: z.array(RoomMember),
  createdAt: date,
  closedAt: date.nullable(),
});

export const RoomSharedItem = z.object({
  _id: id,
  roomId: id,
  sharedBy: id,
  sharedByNickname: z.string(),
  itemType: z.enum(['quiz', 'flashcards', 'material']),
  quizSetId: id.nullable(),
  folderId: id.nullable(),
  materialId: id.nullable(),
  questionIds: z.array(id),
  flashcardIds: z.array(id),
  title: z.string(),
  createdAt: date,
});

export const ReportType = z.enum(['abusive_language', 'spam', 'disturbing', 'obscene', 'other']);
export const Report = z.object({
  _id: id,
  roomId: id,
  targetUserId: id,
  reportType: ReportType,
  details: z.string(),
  imageUrls: z.array(z.string()),
  status: z.string(),
  createdAt: date,
});

export const ChatRoom = z.object({
  _id: id,
  type: z.enum(['direct', 'study_room']),
  studyRoomId: id.nullable(),
  lastMessage: z.object({ text: z.string(), senderId: id, createdAt: date }).nullable(),
  members: z.array(
    z.object({
      userId: id,
      joinedAt: date,
      lastReadAt: date.nullable(),
      muted: z.boolean(),
      leftAt: date.nullable(),
    }),
  ),
  updatedAt: date,
});

export const Message = z.object({
  _id: id,
  chatRoomId: id,
  senderId: id,
  senderNickname: z.string().optional(),
  type: z.enum(['text', 'shared_item', 'system']),
  text: z.string().nullable(),
  sharedItemId: id.nullable(),
  createdAt: date,
  clientId: z.string().optional(),
});

export const FriendStatus = z.enum(['pending', 'accepted', 'rejected', 'blocked']);
export const Friend = z.object({
  _id: id,
  userId: id,
  nickname: z.string(),
  handle: z.string().optional(),
  status: User.shape.status,
  avatarUrl: z.string().nullable().optional(),
  mutualCount: z.number().optional(),
});
export const FriendRequest = z.object({ _id: id, requester: Friend, requestedAt: date });

/* ── 공통 ────────────────────────────────────────── */

export const UploadTarget = z.object({
  uploadUrl: z.string(),
  blobUrl: z.string(),
  expiresAt: date,
  headers: z.record(z.string(), z.string()),
});

export type User = z.infer<typeof User>;
export type UserSettings = z.infer<typeof UserSettings>;
export type AuthTokens = z.infer<typeof AuthTokens>;
export type SocialProvider = z.infer<typeof SocialProvider>;
export type PlanTier = z.infer<typeof PlanTier>;
export type LearnerType = z.infer<typeof LearnerType>;
export type Category = z.infer<typeof Category>;
export type Notification = z.infer<typeof Notification>;
export type ShopItem = z.infer<typeof ShopItem>;
export type UserItem = z.infer<typeof UserItem>;
export type PointLedger = z.infer<typeof PointLedger>;
export type Folder = z.infer<typeof Folder>;
export type MaterialKind = z.infer<typeof MaterialKind>;
export type MaterialSource = z.infer<typeof MaterialSource>;
export type Material = z.infer<typeof Material>;
export type Recording = z.infer<typeof Recording>;
export type Slide = z.infer<typeof Slide>;
export type Question = z.infer<typeof Question>;
export type QuestionDifficulty = z.infer<typeof QuestionDifficulty>;
export type NoteAskTurn = z.infer<typeof NoteAskTurn>;
export type NoteAskBody = z.input<typeof NoteAskBody>;
export type NoteAskResult = z.infer<typeof NoteAskResult>;
export type QuizSet = z.infer<typeof QuizSet>;
export type QuizAttempt = z.infer<typeof QuizAttempt>;
export type Flashcard = z.infer<typeof Flashcard>;
export type AiJob = z.infer<typeof AiJob>;
export type AiJobType = z.infer<typeof AiJobType>;
export type AiJobStatus = z.infer<typeof AiJobStatus>;
export type Subject = z.infer<typeof Subject>;
export type StudyItem = z.infer<typeof StudyItem>;
export type DailyRecord = z.infer<typeof DailyRecord>;
export type StudySession = z.infer<typeof StudySession>;
export type WeeklyGoal = z.infer<typeof WeeklyGoal>;
export type RecurringGoal = z.infer<typeof RecurringGoal>;
export type WeeklySummary = z.infer<typeof WeeklySummary>;
export type StudyStats = z.infer<typeof StudyStats>;
export type Todo = z.infer<typeof Todo>;
export type TodoType = z.infer<typeof TodoType>;
export type DDay = z.infer<typeof DDay>;
export type PublicHoliday = z.infer<typeof PublicHoliday>;
export type CalendarShare = z.infer<typeof CalendarShare>;
export type TimetableClass = z.infer<typeof TimetableClass>;
export type Timetable = z.infer<typeof Timetable>;
export type TimetableShare = z.infer<typeof TimetableShare>;
export type TimerRule = z.infer<typeof TimerRule>;
export type RoomMember = z.infer<typeof RoomMember>;
export type StudyRoom = z.infer<typeof StudyRoom>;
export type RoomSharedItem = z.infer<typeof RoomSharedItem>;
export type ReportType = z.infer<typeof ReportType>;
export type Report = z.infer<typeof Report>;
export type ChatRoom = z.infer<typeof ChatRoom>;
export type Message = z.infer<typeof Message>;
export type Friend = z.infer<typeof Friend>;
export type FriendRequest = z.infer<typeof FriendRequest>;
export type UploadTarget = z.infer<typeof UploadTarget>;
