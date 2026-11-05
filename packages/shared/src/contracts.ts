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
  POINTS_INSUFFICIENT: 'POINTS_INSUFFICIENT',
  ALREADY_OWNED: 'ITEM_ALREADY_OWNED',
  FILE_NOT_ALLOWED: 'FILE_NOT_ALLOWED',
  ROOM_CODE_INVALID: 'ROOM_CODE_INVALID',
  NOT_FOUND: 'NOT_FOUND',
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

/** 경로 조각 인코딩 — id에 '/'나 '..'가 들어와도 다른 경로로 새지 않게 한다 */
const seg = (v: string) => encodeURIComponent(v);

/** REST 경로 모음 (API_PREFIX 뒤에 붙는다) */
export const PATHS = {
  // 인증 · 회원
  socialLogin: (provider: string) => `/auth/social/${seg(provider)}`,
  socialStart: (provider: string) => `/auth/social/${seg(provider)}/start`,
  emailLogin: '/auth/email/login',
  refresh: '/auth/refresh',
  logout: '/auth/logout',
  terms: '/auth/terms',
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
  studySessionAction: (id: string, action: 'pause' | 'resume' | 'end') =>
    `/study-sessions/${seg(id)}/${action}`,
  studyMonth: '/study/month',
  subjects: '/subjects',
  studyWeekly: '/study/weekly',
  studyStats: '/study/stats',
  weeklyGoal: '/goals/weekly',
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
  imageCheck: '/images/check',
  // AI 작업
  aiJob: (id: string) => `/ai-jobs/${seg(id)}`,
  aiJobCancel: (id: string) => `/ai-jobs/${seg(id)}/cancel`,
  aiJobRetry: (id: string) => `/ai-jobs/${seg(id)}/retry`,
  // 퀴즈
  quizSets: '/quiz-sets',
  quizSet: (id: string) => `/quiz-sets/${seg(id)}`,
  similarQuiz: (id: string) => `/quiz-sets/${seg(id)}/similar`,
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
  profileAvatar: '/avatars/profile',
  avatars: '/avatars',
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
  'room:join': (
    p: { roomId: string },
    ack?: (r: { ok: boolean; missed?: Message[] }) => void,
  ) => void;
  'room:leave': (p: { roomId: string }) => void;
  'room:state': (p: { roomId: string; micOn: boolean; camOn: boolean; todaySec: number }) => void;
  'chat:send': (
    p: { chatRoomId: string; text: string; clientId: string },
    ack?: (m: Message) => void,
  ) => void;
  'chat:read': (p: { chatRoomId: string }) => void;
  'ai:subscribe': (p: { jobId: string }) => void;
};
