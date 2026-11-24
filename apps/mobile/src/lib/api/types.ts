import type {
  AiJob,
  AiJobCancelBody,
  NoteAskBody,
  AuthTokens,
  CalendarShare,
  ChatRoom,
  DDay,
  DailyRecord,
  Flashcard,
  Folder,
  Friend,
  FriendRequest,
  FriendShare,
  Material,
  SummaryFormat,
  MaterialKind,
  MaterialSource,
  Message,
  Notification,
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
  SharedTimetable,
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
  /** id · blocks는 멤버별 일정을 주는 서버부터 온다. blocks.day 0 = 월요일, title은 공개하지 않았으면 null */
  members: {
    id?: string;
    nickname: string;
    emoji: string;
    /** 이 방에서 수업 시간을 숨긴 멤버(blocks는 빈 배열, 격자 · 추천 계산에서도 빠진다) */
    hidden?: boolean;
    blocks?: { day: number; start: string; end: string; title: string | null }[];
  }[];
  /** [시간대][요일] 0 비어있음 · 1 바쁨 · 2 공통 가능 */
  grid: number[][];
  startHour: number;
  matches: { day: string; label: string; start: string; end: string; best?: boolean }[];
};

export interface Api {
  auth: {
    /** 서버가 돌려준 1회용 코드와 PKCE 검증값을 보내 토큰으로 바꾼다 */
    socialLogin(
      provider: SocialProvider,
      proof: { token: string; codeVerifier: string },
    ): Promise<AuthTokens>;
    /** 아이디(아이디를 두기 전 계정은 가입 이메일)와 비밀번호로 로그인한다 */
    emailLogin(id: string, password: string): Promise<AuthTokens>;
    /** 가입 ① 인증번호를 메일로 보낸다. 가입한 이메일이어도 응답은 같다. 너무 빨리 다시 보내면 429 RATE_LIMITED */
    emailSendCode(email: string): Promise<void>;
    /** 가입 ② 인증번호를 확인하고 가입 증표를 받는다. 틀리면 400 EMAIL_CODE_INVALID, 횟수를 다 쓰면 429 EMAIL_CODE_LOCKED */
    emailVerifyCode(
      email: string,
      code: string,
    ): Promise<{ verificationToken: string; expiresInSeconds: number }>;
    /**
     * 가입 ③ 증표 · 아이디 · 비밀번호로 계정을 만든다(이메일은 증표 안의 값). 토큰은 주지 않고 로그인으로 이어진다.
     * 이메일이 이미 있으면 409 EMAIL_TAKEN, 아이디가 이미 있으면 409 LOGIN_ID_TAKEN
     */
    emailSignup(verificationToken: string, loginId: string, password: string): Promise<void>;
    /** 아이디를 쓸 수 있는지(가입 화면에서 인증번호를 받기 전에 확인한다) */
    loginIdAvailable(loginId: string): Promise<boolean>;
    /** 아이디 · 비밀번호 찾기 ① 이메일로 인증번호를 보낸다. 가입하지 않은 이메일이어도 응답은 같다 */
    recoverySendCode(email: string): Promise<void>;
    /** 아이디 찾기 ② 이메일과 인증번호가 맞으면 그 이메일로 가입한 아이디(없으면 null). 틀리면 400 EMAIL_CODE_INVALID */
    findId(email: string, code: string): Promise<{ id: string | null }>;
    /**
     * 비밀번호 찾기 ② 인증번호가 맞고 아이디가 그 이메일로 가입한 아이디면 새 비밀번호로 바꾼다.
     * 아이디가 맞지 않으면 400 VALIDATION(그 인증번호는 쓴 것이 된다), 인증번호가 틀리면 400 EMAIL_CODE_INVALID
     */
    passwordReset(id: string, email: string, code: string, password: string): Promise<void>;
    agreeTerms(termCodes: string[]): Promise<void>;
    logout(): Promise<void>;
  };
  me: {
    interestCategories(): Promise<{ _id: string; name: string; parentId: string | null }[]>;
    get(): Promise<User>;
    update(
      patch: Partial<
        Pick<
          User,
          'nickname' | 'learnerType' | 'interestCategoryIds' | 'school' | 'grade' | 'toured'
        >
      > & { settings?: Partial<User['settings']> },
    ): Promise<User>;
    setStatus(status: User['status']): Promise<void>;
    /** 앱이 앞에 있다는 신호(true) · 나감(false) */
    presence(active: boolean, device?: string): Promise<void>;
    registerDevice(d: {
      platform: 'ios' | 'android';
      pushToken: string;
      locale: string;
    }): Promise<void>;
    changePlan(tier: PlanTier): Promise<User>;
    withdraw(): Promise<void>;
    /** 계정 이메일로 본인 인증번호를 보낸다. 이메일이 없으면 400 NO_EMAIL */
    emailSendCode(): Promise<void>;
    /** 본인 인증번호를 확인한다 → 인증된 내 정보(emailVerified: true) */
    emailVerifyCode(code: string): Promise<User>;
  };
  /** 앱 안 알림함(#560). 최근 것부터, before(알림 id) 이전 것을 한 쪽씩 */
  notifications: {
    list(before?: string): Promise<{ items: Notification[]; nextCursor: string | null }>;
    unreadCount(): Promise<number>;
    markRead(id: string): Promise<void>;
    readAll(): Promise<void>;
    remove(id: string): Promise<void>;
    /** 고른 알림 여러 개 지우기(최대 100개) */
    removeMany(ids: string[]): Promise<void>;
    /** 알림함 모두 비우기 */
    removeAll(): Promise<void>;
  };
  upload: {
    getSas(p: {
      kind: 'image' | 'document' | 'audio';
      fileName: string;
      contentType: string;
      sizeBytes: number;
      purpose?: 'report' | 'chat';
    }): Promise<UploadTarget>;
  };
  study: {
    today(): Promise<DailyRecord>;
    addItem(p: { title: string; subjectName: string; goalMin: number | null }): Promise<StudyItem>;
    /**
     * 오늘 목록에서 공부 항목을 지운다(HOME-002). 서버는 기록(쌓인 시간 · 통계)을 남기고 목록에서만 숨긴다.
     * 이미 지운 항목도 성공, 측정 중(일시정지 포함)이면 409 STUDY_ITEM_IN_SESSION
     */
    removeItem(id: string): Promise<void>;
    startSession(p: { studyItemId: string; mode: StudySession['mode'] }): Promise<StudySession>;
    pauseSession(id: string): Promise<void>;
    resumeSession(id: string): Promise<void>;
    /** 세션이 열려 있는 동안 서버에 "앱이 살아 있다"고 알린다(1분마다 · 앞으로 올 때). 실패해도 화면에는 영향이 없다 */
    heartbeatSession(id: string): Promise<void>;
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
    acknowledgeWeeklyGoal(weekStart: string): Promise<void>;
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
    /** 과제 · 시험에서 온 D-day는 목록에서만 빠지고 할 일은 남는다 */
    removeDday(id: string): Promise<void>;
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
    /** 나에게 공유된 친구 시간표(SOC-009 주간 보기에 겹쳐 그림). 빈 시간만 공유면 과목명 없이 바쁜 시간만 */
    shared(): Promise<SharedTimetable[]>;
  };
  social: {
    friends(): Promise<Friend[]>;
    search(nickname: string): Promise<Friend[]>;
    sendRequest(userId: string): Promise<void>;
    received(): Promise<FriendRequest[]>;
    /** 내가 보내고 아직 대기 중인 요청의 상대 userId(「요청 보냄」 표시) */
    sent(): Promise<string[]>;
    respond(requestId: string, accept: boolean): Promise<void>;
    remove(userId: string): Promise<void>;
    openDirect(userId: string): Promise<ChatRoom>;
    messages(chatRoomId: string, before?: string): Promise<Message[]>;
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
      /** 정리 양식(FR-19). 없으면 서버가 points. 녹음은 보내지 않는다 */
      format?: SummaryFormat;
    }): Promise<{ material: Material; job: AiJob }>;
    material(id: string): Promise<Material>;
    saveMaterial(id: string): Promise<void>;
    updateSummary(id: string, sections: { heading: string; body: string }[]): Promise<Material>;
    deleteMaterial(id: string): Promise<void>;
    recording(materialId: string): Promise<Recording>;
    addBookmark(materialId: string, atSec: number): Promise<void>;
    downloadUrl(materialId: string): Promise<{ url: string; fileName: string }>;
    /** 정리 결과 다시 만들기. 새 작업이 성공할 때까지 노트는 지금 결과 그대로 */
    regenerate(
      materialId: string,
      format?: SummaryFormat,
    ): Promise<{ material: Material; job: AiJob }>;
    /** 스터디룸 하나(id) 또는 친구 여러 명(ids, 50명까지)에게 노트를 보낸다(#554) */
    share(p: {
      materialIds: string[];
      target: { type: 'room'; id: string } | { type: 'friend'; ids: string[] };
    }): Promise<void>;
    /** 친구에게 보낸 노트(1:1 채팅 공유 카드). 끝난 공유는 active: false, 친구를 끊었으면 404 */
    friendShare(id: string): Promise<FriendShare>;
    /** 보낸 사람이 공유를 끝낸다 */
    revokeFriendShare(id: string): Promise<void>;
    /** 받은 노트를 내 노트로 복사(정리 끝난 노트만). 폴더를 안 주면 최근에 쓴 내 폴더 */
    copyFriendShare(id: string, folderId?: string): Promise<{ _id: string; folderId: string }>;
    /** 공유받은 남의 노트(방 · 친구)를 고른 내 폴더로 가져온다 */
    copyMaterial(id: string, folderId: string): Promise<{ _id: string; folderId: string }>;
    checkImages(
      files: { name: string; sizeBytes: number; uri: string }[],
    ): Promise<{ name: string; verdict: ImageVerdict }[]>;
    /** 아바타에게 노트 묻기 → note_ask 작업. 답은 ai.job으로 기다려 result(NoteAskResult)에서 읽는다 */
    ask(materialId: string, body: NoteAskBody): Promise<AiJob>;
  };
  ai: {
    job(id: string): Promise<AiJob>;
    /** body.quizSetId: 퀴즈 세트를 만들던 작업이면 그 세트 번호. 서버는 그 세트만 정리한다(#642) */
    cancel(id: string, body?: AiJobCancelBody): Promise<void>;
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
    /** scheduled · nextReviewDay: 이번에 복습 일정에 넣은 문제 수 · 그 날짜(서울 YYYY-MM-DD, FR-37). 옛 서버 · 기기 저장은 없음 */
    finish(attemptId: string): Promise<{
      pointsEarned: number;
      balance: number;
      scheduled?: number;
      nextReviewDay?: string | null;
    }>;
    explanation(questionId: string): Promise<{ text: string }>;
    similar(quizSetId: string): Promise<QuizSet>;
    /** 고른 문제로 유사 퀴즈(#605, 한 노트의 문제 SIMILAR_PICK_MAX개까지). 처음엔 만드는 중(generating) */
    similarPick(questionIds: string[]): Promise<QuizSet>;
    /** 오늘의 복습 세트(오늘 만든 것, 없으면 null) */
    today(): Promise<QuizSet | null>;
    /** 오늘의 복습 만들기(하루 한 번). 처음엔 만드는 중(generating) */
    startToday(): Promise<QuizSet>;
    /** 보관한 문제(담은 순서). folderId를 주면 그 학습 폴더에서 만든 퀴즈의 문제만(#601) */
    box(folderId?: string): Promise<Question[]>;
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
    /** categoryIds: 관심 분야와 같은 공용 카테고리 1~3개, 첫 번째가 대표 */
    create(p: { title: string; categoryIds: string[]; isPublic: boolean }): Promise<StudyRoom>;
    join(inviteCode: string): Promise<StudyRoom>;
    get(id: string): Promise<StudyRoom>;
    leave(id: string): Promise<void>;
    setTimer(id: string, rule: TimerRule): Promise<StudyRoom>;
    schedule(id: string): Promise<RoomSchedule>;
    /** 이 방 시간표에서 내 수업 시간을 숨기거나 다시 보인다 */
    setScheduleHidden(id: string, hidden: boolean): Promise<{ hidden: boolean }>;
    invite(id: string, userIds: string[]): Promise<void>;
    shared(id: string): Promise<{ items: RoomSharedItem[]; flashcards: Flashcard[] }>;
    /** 내 퀴즈 하나 또는 고른 플래시카드들을 방에 공유(방 채팅에 자료 카드가 올라간다, #481) */
    shareStudyItem(
      id: string,
      body: { kind: 'quiz'; quizSetId: string } | { kind: 'flashcards'; flashcardIds: string[] },
    ): Promise<void>;
    /** 방에 공유된 퀴즈(문제 · 정답) · 플래시카드 묶음 열기. 방 멤버만 */
    sharedItem(
      id: string,
      itemId: string,
    ): Promise<{ item: RoomSharedItem; quiz: QuizSet | null; flashcards: Flashcard[] }>;
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
      category?: ShopItem['category'];
      sort?: 'latest' | 'price' | 'popular';
    }): Promise<ShopItem[]>;
    myItems(): Promise<UserItem[]>;
    wish(itemId: string): Promise<boolean>;
    purchase(itemId: string): Promise<{ balance: number }>;
    equip(itemId: string): Promise<void>;
    /** 벗기(치장 · 테마). 보유하면 이미 벗었어도 성공, 보유 안 하면 NOT_FOUND */
    unequip(itemId: string): Promise<void>;
    ledger(type?: 'earn' | 'spend'): Promise<PointLedger[]>;
  };
}
