import type { ApiError } from './api-error.js';
import type { AiJob, AiJobStatus, Message, RoomMember, TimerRule } from './schemas.js';

// 앱 ↔ NestJS 메인 API 계약. 주소는 README 규칙대로 /api/v1/kebab-case,
// 성공 응답은 { data }, 오류는 { code, message } 이다.

export const API_PREFIX = '/api/v1';
export const DAY_RESET_HOUR = 0; // 서울 기준 자정에 하루가 바뀐다

export type ApiOk<T> = { data: T };
export type ApiErr = ApiError;

/** 앱이 처리하는 대표 오류 코드 (p.96~102 예외 처리) */
export const ERROR_CODES = {
  TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  MAINTENANCE: 'SERVER_MAINTENANCE',
  AI_MAINTENANCE: 'AI_MAINTENANCE',
  AI_CREDIT_EXHAUSTED: 'AI_CREDIT_EXHAUSTED',
  /** 노트 정리 실패: 올린 자료가 모두 합쳐 MATERIAL_MAX_FILES(50)쪽을 넘음 */
  TOO_MANY_PAGES: 'TOO_MANY_PAGES',
  POINTS_INSUFFICIENT: 'POINTS_INSUFFICIENT',
  ALREADY_OWNED: 'ITEM_ALREADY_OWNED',
  FILE_NOT_ALLOWED: 'FILE_NOT_ALLOWED',
  ROOM_CODE_INVALID: 'ROOM_CODE_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  /** 아직 정리되지 않았거나 글이 없는 노트라 아바타가 설명할 수 없다 (409) */
  NOTE_NOT_READY: 'NOTE_NOT_READY',
  /** 같은 Idempotency-Key로 다른 내용을 보냈거나, 그 키로 만든 자료를 이미 지웠다 (409) */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  /** 입력 형식 오류 (이메일 · 필수 값 등) */
  VALIDATION: 'VALIDATION_FAILED',
  EMAIL_TAKEN: 'EMAIL_TAKEN',
  /** 이미 쓰는 아이디 (409) */
  LOGIN_ID_TAKEN: 'LOGIN_ID_TAKEN',
  // 이메일 가입 · 로그인 (서버 apps/api/src/modules/auth/app-login/app-login-errors.ts 와 같은 값)
  /** 너무 빨리 다시 요청했거나 한도를 넘었다. 본문의 retryAfterSeconds 뒤에 다시 시도한다 (429) */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 인증번호가 틀렸거나 없거나 만료됐거나 이미 썼다. 틀린 경우에만 attemptsLeft(남은 횟수)가 함께 온다 (400) */
  EMAIL_CODE_INVALID: 'EMAIL_CODE_INVALID',
  /** 인증번호를 틀리게 입력할 수 있는 횟수를 모두 썼다. 인증번호를 다시 받아야 한다 (429) */
  EMAIL_CODE_LOCKED: 'EMAIL_CODE_LOCKED',
  /** 이메일 인증 후 가입을 끝내기까지의 시간(10분)이 지났다. 이메일 인증을 다시 한다 (401) */
  EMAIL_PROOF_EXPIRED: 'EMAIL_PROOF_EXPIRED',
  /** 이메일 인증 증표를 쓸 수 없다(위조 · 이미 사용 · 인증번호를 다시 받아 무효). 이메일 인증을 다시 한다 (401) */
  EMAIL_PROOF_INVALID: 'EMAIL_PROOF_INVALID',
  /** 파일 저장소가 설정되지 않아 올릴 주소를 만들지 못했다 (503) */
  UPLOAD_UNAVAILABLE: 'UPLOAD_UNAVAILABLE',
  /** 인증 메일을 보내지 못했다 (503) */
  MAIL_UNAVAILABLE: 'MAIL_UNAVAILABLE',
  /** 이메일 또는 비밀번호가 맞지 않다. 어느 쪽이 틀렸는지 · 가입 여부는 알려 주지 않는다 (401, 토큰 갱신을 시도하지 않는다) */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** 로그인을 너무 많이 시도해 잠겼다. 본문의 retryAfterSeconds 뒤에 다시 시도한다 (429) */
  LOGIN_LOCKED: 'LOGIN_LOCKED',
} as const;

/** 업로드 허용 규칙 — 앱이 올리기 전에 먼저 검사한다 (p.102) */
export const UPLOAD_RULES = {
  image: {
    types: ['image/jpeg', 'image/png', 'image/heic'],
    exts: ['jpg', 'jpeg', 'png', 'heic'],
    maxBytes: 20 * 1024 * 1024,
  },
  document: {
    types: ['application/pdf', 'image/jpeg', 'image/png'],
    exts: ['pdf', 'jpg', 'jpeg', 'png'],
    maxBytes: 50 * 1024 * 1024,
  },
  audio: {
    types: ['audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav'],
    exts: ['mp3', 'm4a', 'wav'],
    maxBytes: 500 * 1024 * 1024,
  },
} as const;

/** 노트 하나에 올릴 수 있는 파일 수(POST /materials). 노트 정리 처리기의 업로드 수 상한(NOTE_MAX_PAGES)과 같다 */
export const MATERIAL_MAX_FILES = 50;
/**
 * 사진 검사(POST /images/check) 요청 한 번에 보낼 수 있는 사진 수. AI 서버 판정(apps/ai images.py MAX_FILES)과 같다.
 * 앱은 이보다 많으면 나눠서 보낸다
 */
export const IMAGE_CHECK_MAX_FILES = 20;

/** 경로 조각 인코딩 — id에 '/'나 '..'가 들어와도 다른 경로로 새지 않게 한다 */
const seg = (v: string) => encodeURIComponent(v);

/** REST 경로 모음 (API_PREFIX 뒤에 붙는다) */
export const PATHS = {
  // 인증 · 회원
  socialLogin: (provider: string) => `/auth/social/${seg(provider)}`,
  socialStart: (provider: string) => `/auth/social/${seg(provider)}/start`,
  /** 가입용 인증번호를 메일로 보낸다. 응답 204. 가입한 이메일이어도 응답은 같다 */
  emailSendCode: '/auth/email/send-code',
  /** 인증번호를 확인하고 가입 증표를 받는다. 응답 { data: { verificationToken, expiresInSeconds } } */
  emailVerifyCode: '/auth/email/verify-code',
  emailLogin: '/auth/email/login',
  /** 가입 { verificationToken, loginId, password } → 204. 아이디가 이미 있으면 409 LOGIN_ID_TAKEN */
  emailSignup: '/auth/email/signup',
  /** 아이디를 쓸 수 있는지 { loginId } → { data: { available } } */
  loginIdAvailable: '/auth/email/login-id-available',
  refresh: '/auth/refresh',
  logout: '/auth/logout',
  terms: '/auth/terms',
  /** 아이디 찾기 · 비밀번호 재설정 인증번호 받기 { email } → 204. 가입하지 않은 이메일이어도 응답은 같다 */
  recoverySendCode: '/auth/recovery/send-code',
  /** 아이디 찾기 { email, code } → { data: { id } } (그 이메일로 가입한 아이디. 없거나 간편 로그인 계정이면 null) */
  findId: '/auth/find-id',
  /** 비밀번호 재설정 { id, email, code, password } → 204. 모든 기기 로그인을 끊는다 */
  passwordReset: '/auth/password/reset',
  me: '/users/me',
  myStatus: '/users/me/status',
  myDevices: '/users/me/devices',
  mySubscription: '/users/me/subscription',
  userSearch: '/users/search',
  // 업로드 (Blob SAS 주소 발급)
  uploadSas: '/uploads/sas',
  // 학습 기록 · 목표
  studyToday: '/study/today',
  studyItems: '/study/items',
  studySessions: '/study-sessions',
  studySession: (id: string) => `/study-sessions/${seg(id)}`,
  studySessionAction: (id: string, action: 'pause' | 'resume' | 'heartbeat' | 'end') =>
    `/study-sessions/${seg(id)}/${action}`,
  studyMonth: '/study/month',
  subjects: '/subjects',
  studyWeekly: '/study/weekly',
  studyStats: '/study/stats',
  weeklyGoal: '/goals/weekly',
  weeklyGoalAcknowledge: '/goals/weekly/acknowledge',
  recurringGoals: '/goals/recurring',
  recurringGoal: (id: string) => `/goals/recurring/${seg(id)}`,
  // 일정 · 캘린더 · 시간표
  todos: '/todos',
  todo: (id: string) => `/todos/${seg(id)}`,
  ddays: '/ddays',
  holidays: '/holidays',
  holiday: (date: string) => `/holidays/${seg(date)}`,
  customHolidays: '/holidays/custom',
  customHoliday: (id: string) => `/holidays/custom/${seg(id)}`,
  calendarShares: '/calendar-shares',
  calendarShare: (id: string) => `/calendar-shares/${seg(id)}`,
  calendarSharesReceived: '/calendar-shares/received',
  calendarShareSubscribe: (id: string) => `/calendar-shares/${seg(id)}/subscribe`,
  timetable: '/timetable',
  timetableClasses: '/timetable/classes',
  timetableClass: (id: string) => `/timetable/classes/${seg(id)}`,
  timetableShares: '/timetable/shares',
  // 소셜 · 채팅
  friends: '/friends',
  friend: (userId: string) => `/friends/${seg(userId)}`,
  friendRequests: '/friend-requests',
  friendRequestsReceived: '/friend-requests/received',
  friendRequestAction: (id: string, action: 'accept' | 'reject') =>
    `/friend-requests/${seg(id)}/${action}`,
  directChat: '/chat-rooms/direct',
  chatMessages: (chatRoomId: string) => `/chat-rooms/${seg(chatRoomId)}/messages`,
  // 노트
  folders: '/folders',
  folder: (id: string) => `/folders/${seg(id)}`,
  folderMaterials: (id: string) => `/folders/${seg(id)}/materials`,
  materials: '/materials',
  material: (id: string) => `/materials/${seg(id)}`,
  materialRecording: (id: string) => `/materials/${seg(id)}/recording`,
  materialBookmarks: (id: string) => `/materials/${seg(id)}/bookmarks`,
  materialDownloadUrl: (id: string) => `/materials/${seg(id)}/download-url`,
  materialShare: '/materials/share',
  /** 아바타에게 노트 묻기 → note_ask 작업(AiJob)을 돌려준다. 답은 aiJob으로 받아 result(NoteAskResult)에서 읽는다 */
  materialAsk: (id: string) => `/materials/${seg(id)}/ask`,
  imageCheck: '/images/check',
  // AI 작업
  aiJob: (id: string) => `/ai-jobs/${seg(id)}`,
  aiJobCancel: (id: string) => `/ai-jobs/${seg(id)}/cancel`,
  aiJobRetry: (id: string) => `/ai-jobs/${seg(id)}/retry`,
  // 퀴즈
  quizSets: '/quiz-sets',
  quizSet: (id: string) => `/quiz-sets/${seg(id)}`,
  similarQuiz: (id: string) => `/quiz-sets/${seg(id)}/similar`,
  /** 오늘의 복습: GET 오늘 만든 세트(없으면 null) · POST 만들기(하루 한 번, 만드는 중이면 세트 조회로 기다림) */
  todayReview: '/quiz-sets/today',
  quizAttempts: '/quiz-attempts',
  attemptAnswer: (id: string) => `/quiz-attempts/${seg(id)}/answers`,
  attemptFinish: (id: string) => `/quiz-attempts/${seg(id)}/finish`,
  explanation: (questionId: string) => `/questions/${seg(questionId)}/explanation`,
  quizBox: '/quiz-box',
  flashcards: '/flashcards',
  flashcardsDelete: '/flashcards/delete',
  // 스터디룸
  studyRooms: '/study-rooms',
  studyRoom: (id: string) => `/study-rooms/${seg(id)}`,
  joinRoom: '/study-rooms/join',
  leaveRoom: (id: string) => `/study-rooms/${seg(id)}/leave`,
  roomTimer: (id: string) => `/study-rooms/${seg(id)}/timer-rule`,
  roomSchedule: (id: string) => `/study-rooms/${seg(id)}/schedule`,
  roomInvites: (id: string) => `/study-rooms/${seg(id)}/invites`,
  roomShared: (id: string) => `/study-rooms/${seg(id)}/shared-items`,
  livekitToken: (id: string) => `/study-rooms/${seg(id)}/livekit-token`,
  roomChatRoom: (id: string) => `/study-rooms/${seg(id)}/chat-room`,
  reports: '/reports',
  // 상점 · 포인트
  shopItems: '/shop/items',
  wish: (itemId: string) => `/shop/items/${seg(itemId)}/wish`,
  purchases: '/shop/purchases',
  myItems: '/users/me/items',
  equip: (itemId: string) => `/users/me/items/${seg(itemId)}/equip`,
  pointLedger: '/points/ledger',
  // 아바타 · 프로필 생성
} as const;

/* ── Socket.IO 이벤트 (NestJS realtime 게이트웨이) ──── */

export type ServerToClient = {
  /** AI 작업 진행률 (p.20: queued → running → succeeded | failed | canceled) */
  'ai:progress': (p: {
    jobId: string;
    status: AiJobStatus;
    progress: number;
    step?: string;
  }) => void;
  'ai:done': (p: { jobId: string; job: AiJob }) => void;
  'chat:message': (m: Message) => void;
  'room:presence': (p: { roomId: string; members: RoomMember[] }) => void;
  'room:members-changed': (payload: { roomId: string }) => void;
  'room:timer': (p: {
    roomId: string;
    rule: TimerRule | null;
    phase: 'focus' | 'break' | 'period';
    endsAt: string | null;
  }) => void;
  'friend:status': (p: { userId: string; status: string }) => void;
  notification: (p: { title: string; body: string; data?: Record<string, unknown> }) => void;
};

export type ClientToServer = {
  'chat:join': (
    p: { chatRoomId: string },
    ack?: (r: { ok: boolean; missed?: Message[] }) => void,
  ) => void;
  'chat:leave': (p: { chatRoomId: string }) => void;
  'room:join': (
    p: { roomId: string },
    ack?: (r: { ok: boolean; missed?: Message[] }) => void,
  ) => void;
  'room:leave': (p: { roomId: string }) => void;
  'room:state': (p: { roomId: string; micOn: boolean; camOn: boolean; todaySec: number }) => void;
  /** 글은 text, 사진 · 파일은 채팅 경로에 먼저 올린 뒤 attachment로 보낸다 */
  'chat:send': (
    p: {
      chatRoomId: string;
      clientId: string;
      text?: string;
      attachment?: { blobUrl: string; kind: 'image' | 'file'; name: string };
    },
    ack?: (m: Message) => void,
  ) => void;
  'chat:read': (p: { chatRoomId: string }) => void;
  'ai:subscribe': (p: { jobId: string }) => void;
  /** 화면을 떠나면 그 작업의 진행률을 그만 받는다 */
  'ai:unsubscribe': (p: { jobId: string }) => void;
};

/**
 * 로그인 아이디: 영문 소문자로 시작하는 4~20자 · 영문 소문자 · 숫자 · 밑줄(_).
 * 이메일과 따로 정한다(이메일은 인증 · 계정 찾기에만 쓴다). 서버와 앱이 같은 규칙을 쓴다
 */
export const LOGIN_ID_PATTERN = /^[a-z][a-z0-9_]{3,19}$/;
