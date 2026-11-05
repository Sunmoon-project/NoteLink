import type {
  AiJob,
  AuthTokens,
  CalendarShare,
  ChatRoom,
  DDay,
  DailyRecord,
  Flashcard,
  Folder,
  Friend,
  FriendRequest,
  Material,
  MaterialKind,
  MaterialSource,
  Message,
  PlanTier,
  PointLedger,
  PublicHoliday,
  Question,
  QuizAttempt,
  QuizSet,
  RecurringGoal,
  Recording,
  ReportType,
  RoomSharedItem,
  ShopItem,
  SocialProvider,
  StudyItem,
  StudyRoom,
  StudySession,
  StudyStats,
  Subject,
  TimerRule,
  Timetable,
  TimetableClass,
  TimetableShare,
  Todo,
  TodoType,
  UploadTarget,
  User,
  UserItem,
  WeeklyGoal,
  WeeklySummary,
} from '@notelink/shared';

// 화면이 쓰는 API 전체. http-api.ts(실서버)와 local/api.ts(기기 저장)가 같은 모양으로 구현한다.

export type MonthDay = { studyDate: string; level: number; hasTodo: boolean };
export type ImageVerdict = 'ok' | 'not_allowed' | 'not_handwriting' | 'blurry';
export type RoomSchedule = {
  members: { nickname: string; emoji: string }[];
  /** [시간대][요일] 0 비어있음 · 1 바쁨 · 2 공통 가능 */
  grid: number[][];
  startHour: number;
  matches: { day: string; label: string; start: string; end: string; best?: boolean }[];
};

export interface Api {
  auth: {
    /** providerToken: 카카오 · 네이버 · Google SDK가 준 토큰. 서버가 서명 · 대상 · 만료를 검증한 뒤 자체 토큰을 발급한다 */
    socialLogin(
      provider: SocialProvider,
      proof: { token: string; codeVerifier: string },
    ): Promise<AuthTokens>;
    emailLogin(email: string, password: string): Promise<AuthTokens>;
    /** 이메일을 아이디로 가입한다. 토큰은 주지 않고 로그인으로 이어진다. 이미 있으면 409 EMAIL_TAKEN */
    emailSignup(email: string, password: string): Promise<void>;
    agreeTerms(termCodes: string[]): Promise<void>;
    logout(): Promise<void>;
  };
  me: {
    get(): Promise<User>;
    update(
      patch: Partial<
        Pick<User, 'nickname' | 'learnerType' | 'interestCategoryIds' | 'school' | 'grade'>
      > & { settings?: Partial<User['settings']> },
    ): Promise<User>;
    setStatus(status: User['status']): Promise<void>;
    registerDevice(d: {
      platform: 'ios' | 'android';
      pushToken: string;
      locale: string;
    }): Promise<void>;
    changePlan(tier: PlanTier): Promise<User>;
    withdraw(): Promise<void>;
    generateProfile(p: {
      photoBlobUrl: string;
      prompt: string;
      style: string | null;
    }): Promise<AiJob>;
    saveAvatar(p: { style: string; gender: 'male' | 'female'; color: string }): Promise<void>;
  };
  upload: {
    getSas(p: {
      kind: 'image' | 'document' | 'audio';
      fileName: string;
      contentType: string;
      sizeBytes: number;
    }): Promise<UploadTarget>;
  };
  study: {
    today(): Promise<DailyRecord>;
    addItem(p: { title: string; subjectName: string; goalMin: number | null }): Promise<StudyItem>;
    startSession(p: { studyItemId: string; mode: StudySession['mode'] }): Promise<StudySession>;
    pauseSession(id: string): Promise<void>;
    resumeSession(id: string): Promise<void>;
    /** 시간 · 포인트는 서버가 startedAt · pause/resume 기록으로 계산한다. clientDurationSec는 표시 비교용 참고값일 뿐 */
    endSession(
      id: string,
      p: { clientDurationSec: number; endReason: string },
    ): Promise<{ durationSec: number; pointsEarned: number }>;
    weekly(): Promise<WeeklySummary>;
    month(ym: string): Promise<MonthDay[]>;
    stats(range: 'all' | '90d' | '30d'): Promise<StudyStats>;
    weeklyGoal(): Promise<WeeklyGoal>;
    setWeeklyGoal(p: { targetMin: number; notify80: boolean }): Promise<WeeklyGoal>;
    recurringGoals(): Promise<RecurringGoal[]>;
    saveRecurringGoal(g: Partial<RecurringGoal> & { name: string }): Promise<RecurringGoal>;
    deleteRecurringGoal(id: string): Promise<void>;
    subjects(): Promise<Subject[]>;
  };
  calendar: {
    todos(date: string): Promise<Todo[]>;
    addTodo(p: {
      content: string;
      todoType: TodoType;
      dueDate: string;
      timeSlot: Todo['timeSlot'];
      dueTime?: string;
      subjectName: string | null;
    }): Promise<Todo>;
    toggleTodo(id: string, done: boolean): Promise<void>;
    ddays(): Promise<DDay[]>;
    addDday(p: { title: string; date: string }): Promise<DDay>;
    holidays(year: number): Promise<PublicHoliday[]>;
    setHolidayHidden(date: string, hidden: boolean): Promise<void>;
    customHolidays(): Promise<{ _id: string; name: string; date: string }[]>;
    addCustomHoliday(p: { name: string; date: string }): Promise<void>;
    removeCustomHoliday(id: string): Promise<void>;
    shares(): Promise<CalendarShare[]>;
    createShare(p: {
      rangeStart: string;
      rangeEnd: string;
      expiresInDays: number | null;
    }): Promise<CalendarShare & { url: string }>;
    revokeShare(id: string): Promise<void>;
    received(): Promise<(CalendarShare & { days: string[] })[]>;
    subscribe(shareId: string): Promise<void>;
  };
  timetable: {
    get(): Promise<Timetable>;
    addClass(c: Omit<TimetableClass, '_id' | 'source'>): Promise<TimetableClass>;
    removeClass(id: string): Promise<void>;
    share(p: { friendIds: string[]; mode: 'full' | 'free_only' }): Promise<void>;
    /** 내가 시간표를 공유 중인 친구들 (FR-14-05 '공유 중' 표시) */
    shares(): Promise<TimetableShare[]>;
  };
  social: {
    friends(): Promise<Friend[]>;
    search(nickname: string): Promise<Friend[]>;
    sendRequest(userId: string): Promise<void>;
    received(): Promise<FriendRequest[]>;
    respond(requestId: string, accept: boolean): Promise<void>;
    remove(userId: string): Promise<void>;
    openDirect(userId: string): Promise<ChatRoom>;
    messages(chatRoomId: string): Promise<Message[]>;
  };
  content: {
    folders(): Promise<(Folder & { materialCount: number })[]>;
    createFolder(p: { title: string; subjectName: string }): Promise<Folder>;
    deleteFolder(id: string): Promise<void>;
    materials(folderId: string): Promise<Material[]>;
    createMaterial(p: {
      /** 같은 등록의 실서버 HTTP 요청은 한 번만 보내고 불명확한 응답은 재전송하지 않는다. */
      requestId?: string;
      folderId: string;
      kind: MaterialKind;
      source: MaterialSource;
      title: string;
      description?: string;
      blobUrls: string[];
      avatarItemId?: string | null;
    }): Promise<{ material: Material; job: AiJob }>;
    material(id: string): Promise<Material>;
    saveMaterial(id: string): Promise<void>;
    updateSummary(id: string, sections: { heading: string; body: string }[]): Promise<Material>;
    deleteMaterial(id: string): Promise<void>;
    recording(materialId: string): Promise<Recording>;
    addBookmark(materialId: string, atSec: number): Promise<void>;
    downloadUrl(materialId: string): Promise<{ url: string; fileName: string }>;
    share(p: {
      materialIds: string[];
      target: { type: 'room' | 'friend'; id: string };
    }): Promise<void>;
    checkImages(
      files: { name: string; sizeBytes: number; uri: string }[],
    ): Promise<{ name: string; verdict: ImageVerdict }[]>;
  };
  ai: {
    job(id: string): Promise<AiJob>;
    cancel(id: string): Promise<void>;
    retry(id: string): Promise<AiJob>;
  };
  quiz: {
    sets(): Promise<QuizSet[]>;
    createSet(materialId: string): Promise<{ quizSet: QuizSet; job: AiJob }>;
    set(id: string): Promise<QuizSet>;
    startAttempt(quizSetId: string): Promise<QuizAttempt>;
    answer(
      attemptId: string,
      questionId: string,
      answer: string,
    ): Promise<{ correct: boolean; correctAnswer: string }>;
    finish(attemptId: string): Promise<{ pointsEarned: number; balance: number }>;
    explanation(questionId: string): Promise<{ text: string }>;
    similar(quizSetId: string): Promise<QuizSet>;
    box(): Promise<Question[]>;
    /** 같은 문제 ID를 여러 번 저장해도 보관함에 한 번만 남긴다. */
    saveToBox(questionIds: string[]): Promise<Question[]>;
    deleteFromBox(questionIds: string[]): Promise<void>;
    flashcards(): Promise<Flashcard[]>;
    saveFlashcard(p: {
      front: string;
      back: string;
      sourceQuestionId?: string;
    }): Promise<Flashcard>;
    deleteFlashcards(ids: string[]): Promise<void>;
  };
  rooms: {
    recommended(): Promise<StudyRoom[]>;
    mine(): Promise<StudyRoom[]>;
    create(p: { title: string; categoryName: string; isPublic: boolean }): Promise<StudyRoom>;
    join(inviteCode: string): Promise<StudyRoom>;
    get(id: string): Promise<StudyRoom>;
    leave(id: string): Promise<void>;
    setTimer(id: string, rule: TimerRule): Promise<StudyRoom>;
    schedule(id: string): Promise<RoomSchedule>;
    invite(id: string, userIds: string[]): Promise<void>;
    shared(id: string): Promise<{ items: RoomSharedItem[]; flashcards: Flashcard[] }>;
    livekitToken(id: string): Promise<{ token: string; url: string }>;
    report(p: {
      roomId: string;
      targetUserId: string;
      reportType: ReportType;
      details: string;
      imageUrls: string[];
    }): Promise<void>;
    chatRoomId(id: string): Promise<string>;
  };
  shop: {
    items(p: {
      category?: 'avatar' | 'theme';
      sort?: 'latest' | 'price' | 'popular';
    }): Promise<ShopItem[]>;
    myItems(): Promise<UserItem[]>;
    wish(itemId: string): Promise<boolean>;
    purchase(itemId: string): Promise<{ balance: number }>;
    equip(itemId: string): Promise<void>;
    ledger(type?: 'earn' | 'spend'): Promise<PointLedger[]>;
  };
}
