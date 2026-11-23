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
  // 알림 설정. 서버는 늘 채워 보내지만 옛 캐시에는 없을 수 있어 선택으로 둔다(없으면 켜짐 · 조용한 시간 없음)
  notifyFriend: z.boolean().optional(),
  notifyChat: z.boolean().optional(),
  notifyRoom: z.boolean().optional(),
  notifyStudy: z.boolean().optional(),
  notifyAi: z.boolean().optional(),
  /** 'HH:mm'(서울). 푸시만 멈추고 알림함에는 남는다 */
  quietHours: z.object({ start: z.string(), end: z.string() }).nullable().optional(),
  /** 알림을 끈 채팅방 id(1:1 · 스터디룸 채팅방) */
  mutedChatRoomIds: z.array(id).optional(),
});

export const User = z.object({
  _id: id,
  email: z.string().nullable(),
  /** 로그인 아이디. 간편 로그인 계정과 아이디를 따로 두기 전에 이메일로 가입한 계정은 null */
  loginId: z.string().nullable().optional(),
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
  /** 계정 이메일을 인증번호로 본인 인증했는지(서버 계산). 전화번호 인증은 아직 없다 */
  emailVerified: z.boolean().optional(),
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
  /** 약관 동의 · 프로필 설정을 마친 계정(서버가 계정 기준으로 계산). 기기를 바꿔도 같다 */
  onboarded: z.boolean().optional(),
  /** 처음 안내를 본 계정 */
  toured: z.boolean().optional(),
});

export const AuthTokens = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  user: User,
  /**
   * 간편 로그인이 이번에 계정을 새로 만들었는지. 탈퇴한 계정은 되살리지 않아서, 탈퇴 뒤 같은 소셜 계정으로
   * 들어오면 새 계정이 된다 — 앱은 이때 안내한다(PROF-013). 이메일 로그인 · 옛 서버는 보내지 않는다
   */
  isNewUser: z.boolean().optional(),
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
  // hat · glasses · scarf: 아바타 선생님 치장(종류마다 하나씩 장착)
  category: z.enum(['avatar', 'theme', 'hat', 'glasses', 'scarf']),
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
  /** 과목 목록(subjects)에 같은 이름이 없으면 null */
  subjectId: id.nullable(),
  subjectName: z.string().optional(),
  createdAt: date,
  updatedAt: date,
});
/** 학습 폴더 만들기 — POST /folders 본문. 과목은 이름으로 보낸다 */
export const FolderCreateBody = z.object({
  title: z.string().trim().min(1).max(50),
  subjectName: z.string().trim().min(1).max(30),
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

// 녹음 정리가 슬라이드마다 만드는 도식 구조(apps/ai services/recording/models.py Diagram). 그리는 것은 앱.
// relations 는 terms 안 위치(0부터) [from, to]. 받은 값은 diagramOf(diagram.ts)로 거른 뒤에 쓴다
export const DiagramKind = z.enum(['sequence', 'contrast', 'hierarchy', 'cause', 'list']);
export const Diagram = z.object({
  kind: DiagramKind,
  terms: z.array(z.string()),
  relations: z.array(z.tuple([z.number(), z.number()])),
});

// 필기 사진에서 찾은 도식(apps/ai services/note/diagrams.py). 앱이 정리본 본문에서 after 와 같은 줄 뒤에 그린다
// (after 가 null 이거나 그 줄을 못 찾으면 첫 소제목 앞 · 마지막 소제목 끝)
export const NoteDiagram = z.object({ after: z.string().nullable(), diagram: Diagram });

// 노트 정리 양식(FR-19): 위쪽 요약 칸의 모습. 본문(sections)은 양식과 상관없이 같다
export const SummaryFormat = z.enum(['points', 'qa', 'terms', 'brief']);
// 요약 항목: qa 는 head = 질문, terms 는 head = 용어, 그 밖은 head = null
export const SummaryItem = z.object({ head: z.string().nullable(), text: z.string() });

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
      // 양식을 보내기 전 서버 · 기기 저장 모드 · 녹음에는 없다(없으면 points 로 그린다)
      format: SummaryFormat.optional(),
      items: z.array(SummaryItem).optional(),
    })
    .nullable(),
  // 이 노트의 지금 양식(다시 만들기 시트가 이 값으로 열린다). 없으면 points
  summaryFormat: SummaryFormat.optional(),
  keywords: z.array(z.string()),
  bookmarks: z.array(Bookmark),
  pages: z.array(MaterialPage).optional(),
  // 도식이 없는 노트 · 도식을 보내기 전 서버 · 기기 저장 모드에는 없다
  diagrams: z.array(NoteDiagram).optional(),
  createdAt: date,
});

export const Slide = z.object({
  index: z.number(),
  title: z.string(),
  bullets: z.array(z.string()),
  startSec: z.number(),
  endSec: z.number(),
  // 도식이 맞지 않는 슬라이드는 null. 도식을 보내기 전 서버 · 기기 저장 모드에는 없다
  diagram: Diagram.nullable().optional(),
});

export const Recording = z.object({
  _id: id,
  materialId: id,
  audioUrl: z.string(),
  audioSizeBytes: z.number(),
  durationSec: z.number(),
  transcript: z.object({
    text: z.string(),
    segments: z.array(
      z.object({
        startSec: z.number(),
        endSec: z.number(),
        text: z.string(),
        // 단어별 시각(STT). 옛 결과 · 로컬 모드에는 없다 → 앱은 글자 비례로 대신한다
        words: z
          .array(z.object({ text: z.string(), startSec: z.number(), endSec: z.number() }))
          .optional(),
      }),
    ),
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
  // 세트를 끝까지 푼 풀이가 있으면 true. 세트 목록 · 오늘의 복습 응답만 채움(#561, 세트 하나 조회는 없음)
  completed: z.boolean().optional(),
  // 세트를 시작한 풀이가 있으면(풀기 화면에 들어갔으면, 끝내지 않았어도) true. 세트 목록 · 오늘의 복습 응답만 채움(#593).
  // 없는 옛 서버 응답은 「들어간 적 없음」으로 본다
  started: z.boolean().optional(),
  // 오늘의 복습 세트만: 그 복습 날짜(서울 YYYY-MM-DD). 다른 세트는 null(#561, 없는 옛 서버 응답도 같게 본다)
  reviewDay: z.string().nullable().optional(),
  // 끝낸 세트만: 마지막으로 끝낸 풀이에서 틀린 문제 id(무효 풀이 제외). 세트 목록 응답만 채움(#605, 유사 퀴즈 고르기의
  // 기본 체크). 없는 옛 서버 응답은 「틀린 문제 없음」으로 본다
  wrongQuestionIds: z.array(id).optional(),
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
  folderId: id.nullable(),
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
  // 맞춤 퀴즈 세트와 같은 범위의 개념 카드(#558). 세트가 ready가 되면 NestJS가 넣고, 앱은 보지 않는다
  'quiz_flashcards',
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

/**
 * AI 작업 취소 — POST /ai-jobs/:id/cancel 본문(선택). quizSetId: 퀴즈를 만들던 세트를 취소할 때 그 세트 번호.
 * 서버는 그 세트만 정리한다(같은 작업을 새로 이어받은 다른 세트는 건드리지 않음). 없으면(옛 앱 · 다른 작업) 작업 id로만 취소.
 * 세트 번호는 서버 id 형식(24자리 16진수)이어야 한다(아니면 400)
 */
export const AiJobCancelBody = z.object({
  quizSetId: z
    .string()
    .regex(/^[0-9a-f]{24}$/i)
    .optional(),
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
  notified80: z.boolean().optional(),
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
  /** 오늘(서울) 이 목표로 센 공부 분(내림) — 리마인드 알림의 "남은 분" 계산용. 오늘이 목표 요일이 아니거나 공휴일 · 제외일 · 일시 정지 · 쉬는 목표면 null (서버 계산) */
  todayMin: z.number().nullable(),
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
/**
 * 나에게 공유된 친구 시간표의 수업(GET /timetable/shared). 빈 시간만(free_only) 공유면 과목명 · 장소는 null이고,
 * 요일 하나씩 겹치거나 이어진 수업을 합친 바쁜 시간 덩어리다
 */
export const SharedTimetableClass = z.object({
  days: z.array(z.number().int().min(0).max(6)),
  startTime: z.string(),
  endTime: z.string(),
  subjectName: z.string().nullable(),
  location: z.string().nullable(),
});
/** 나에게 공유된 친구 시간표 한 건(지금 친구이고 지금 관계로 한 공유만, 공유한 순서) */
export const SharedTimetable = z.object({
  ownerId: id,
  nickname: z.string(),
  mode: z.enum(['full', 'free_only']),
  sharedAt: date,
  classes: z.array(SharedTimetableClass),
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
  /** 대표 카테고리(categoryIds의 첫 번째) */
  categoryId: id,
  categoryName: z.string().optional(),
  /** 관심 분야와 같은 공용 카테고리 최대 3개. 서버가 예전 방도 [categoryId]로 채워 준다. */
  categoryIds: z.array(id).optional(),
  categoryNames: z.array(z.string()).optional(),
  /** 대상: 방 만들 때 방장 프로필에서 복사. 방장이 정하지 않았으면 null */
  learnerType: LearnerType.nullable().optional(),
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

/**
 * 친구에게 보낸 노트 하나(#554, GET friend-shares/:id). 1:1 채팅 공유 카드(shared_item)의 sharedItemId 가 이 _id 다.
 * active 가 false 면(철회 · 친구 끊김 · 노트를 지움 · 보낸 사람 탈퇴) 받은 사람은 열 수 없고 앱은 「공유가 끝났어요」를 보인다
 */
export const FriendShare = z.object({
  _id: id,
  materialId: id,
  ownerId: id,
  ownerNickname: z.string(),
  friendId: id,
  /** 노트의 지금 제목 · 종류. 노트가 없어졌으면 빈 제목 · null */
  title: z.string(),
  kind: z.enum(['handwriting', 'recording', 'document']).nullable(),
  active: z.boolean(),
  /** 내가 보낸 공유인지(철회 버튼) */
  mine: z.boolean(),
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
  type: z.enum(['text', 'shared_item', 'system', 'study_room_invite', 'image', 'file']),
  text: z.string().nullable(),
  /** 사진 · 파일 메시지의 첨부. url은 잠깐(1시간) 읽을 수 있는 주소라 다시 받으면 새로 받는다 */
  attachment: z
    .object({
      kind: z.enum(['image', 'file']),
      name: z.string(),
      sizeBytes: z.number(),
      url: z.string(),
    })
    .optional(),
  sharedItemId: id.nullable(),
  /** 방 채팅 자료 카드(shared_item)의 종류. 없으면 노트(#481 전에 남긴 카드 포함) */
  sharedKind: z.enum(['quiz', 'flashcards']).optional(),
  studyRoomInvite: z
    .object({ roomId: id, title: z.string(), inviteCode: z.string() })
    .nullable()
    .optional(),
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

export const UploadKind = z.enum(['image', 'document', 'audio']);
/** 파일 올리기 주소 요청 — POST /uploads/sas 본문. 확장자 · 크기는 서버가 UPLOAD_RULES로 검사한다 */
export const UploadSasBody = z.object({
  kind: UploadKind,
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().trim().max(100),
  sizeBytes: z.number().int().positive(),
  /** 쓰는 곳. report: 스터디룸 신고 사진(이미지만) */
  /** report: 신고 사진(임시 경로) · chat: 채팅 첨부(사진은 image, 파일은 document) */
  purpose: z.enum(['report', 'chat']).optional(),
});

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
export type FolderCreateBody = z.infer<typeof FolderCreateBody>;
export type MaterialKind = z.infer<typeof MaterialKind>;
export type MaterialSource = z.infer<typeof MaterialSource>;
export type Material = z.infer<typeof Material>;
export type SummaryFormat = z.infer<typeof SummaryFormat>;
export type SummaryItem = z.infer<typeof SummaryItem>;
export type Recording = z.infer<typeof Recording>;
export type Slide = z.infer<typeof Slide>;
export type Diagram = z.infer<typeof Diagram>;
export type NoteDiagram = z.infer<typeof NoteDiagram>;
export type DiagramKind = z.infer<typeof DiagramKind>;
export type Question = z.infer<typeof Question>;
export type QuestionDifficulty = z.infer<typeof QuestionDifficulty>;
export type AiJobCancelBody = z.infer<typeof AiJobCancelBody>;
export type NoteAskTurn = z.infer<typeof NoteAskTurn>;
export type NoteAskBody = z.input<typeof NoteAskBody>;
export type NoteAskResult = z.infer<typeof NoteAskResult>;
export type UploadKind = z.infer<typeof UploadKind>;
export type UploadSasBody = z.infer<typeof UploadSasBody>;
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
export type SharedTimetableClass = z.infer<typeof SharedTimetableClass>;
export type SharedTimetable = z.infer<typeof SharedTimetable>;
export type TimerRule = z.infer<typeof TimerRule>;
export type RoomMember = z.infer<typeof RoomMember>;
export type StudyRoom = z.infer<typeof StudyRoom>;
export type RoomSharedItem = z.infer<typeof RoomSharedItem>;
export type FriendShare = z.infer<typeof FriendShare>;
export type ReportType = z.infer<typeof ReportType>;
export type Report = z.infer<typeof Report>;
export type ChatRoom = z.infer<typeof ChatRoom>;
export type Message = z.infer<typeof Message>;
export type Friend = z.infer<typeof Friend>;
export type FriendRequest = z.infer<typeof FriendRequest>;
export type UploadTarget = z.infer<typeof UploadTarget>;
