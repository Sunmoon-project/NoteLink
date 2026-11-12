import { PATHS as P } from '@notelink/shared';
import { ApiError, http } from './http';
import { useAuth } from '@/stores/auth';
import type { Api } from './types';

// 실서버(NestJS 메인 API) 구현. 경로와 응답 형태는 @notelink/shared 계약을 따른다.

type MaterialRequest = Parameters<Api['content']['createMaterial']>[0];
type MaterialResponse = Awaited<ReturnType<Api['content']['createMaterial']>>;
const registrations = new Map<
  string,
  { fingerprint: string; promise: Promise<MaterialResponse> }
>();

// 서버의 헤더 지원 여부와 무관하게 같은 등록은 실제 HTTP 요청을 한 번만 보낸다.
// 결과가 불명확한 실패는 보존하고, 재전송 대신 목록 확인을 안내한다.
async function registerMaterial({
  requestId,
  ...payload
}: MaterialRequest): Promise<MaterialResponse> {
  if (!requestId) return http.post(P.materials, payload);
  const key = JSON.stringify([useAuth.getState().userId, requestId]);
  const fingerprint = JSON.stringify(payload);
  const previous = registrations.get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new ApiError('IDEMPOTENCY_CONFLICT', '같은 등록 키에 다른 자료를 보낼 수 없어요', 409);
    return JSON.parse(JSON.stringify(await previous.promise));
  }
  const pending: Promise<MaterialResponse> = http
    .post<MaterialResponse>(P.materials, payload, { idempotencyKey: requestId })
    .then((result) => {
      if (!result?.material?._id || !result?.job?._id)
        throw new Error('등록 결과 응답이 누락됐어요');
      return result;
    })
    .catch((error: unknown) => {
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        if (registrations.get(key)?.promise === pending) registrations.delete(key);
        throw error;
      }
      throw new ApiError(
        'MATERIAL_REGISTRATION_UNCERTAIN',
        '등록 결과를 확인할 수 없어요. 학습자료 목록에서 확인해 주세요',
        0,
      );
    });
  registrations.set(key, { fingerprint, promise: pending });
  return JSON.parse(JSON.stringify(await pending));
}

export const httpApi: Api = {
  auth: {
    socialLogin: (provider, proof) => http.post(P.socialLogin(provider), proof),
    emailLogin: (email, password) => http.post(P.emailLogin, { email, password }),
    emailSendCode: (email) => http.post(P.emailSendCode, { email }),
    emailVerifyCode: (email, code) => http.post(P.emailVerifyCode, { email, code }),
    emailSignup: (verificationToken, password) =>
      http.post(P.emailSignup, { verificationToken, password }),
    // ponytail: 아이디 · 비밀번호 찾기 경로는 서버 · 공용 계약(@notelink/shared PATHS)에 아직 없다.
    // 서버 담당이 만들면 PATHS로 옮긴다. 그 전에는 404가 와서 화면이 '준비 중'으로 안내한다
    recoverySendCode: (email) => http.post('/auth/recovery/send-code', { email }),
    findId: (email, code) => http.post('/auth/find-id', { email, code }),
    passwordReset: (id, email, code, password) =>
      http.post('/auth/password/reset', { id, email, code, password }),
    agreeTerms: (termCodes) => http.post(P.terms, { termCodes }),
    // 서버가 폐기할 토큰. 토큰 갱신 뒤 재시도하면 그때의 토큰을 보낸다
    logout: () =>
      http.post(P.logout, () => ({ refreshToken: useAuth.getState().tokens?.refreshToken })),
  },
  me: {
    get: () => http.get(P.me),
    update: (patch) => http.patch(P.me, patch),
    setStatus: (status) => http.patch(P.myStatus, { status }),
    registerDevice: (d) => http.post(P.myDevices, d),
    changePlan: (tier) => http.patch(P.mySubscription, { tier }),
    withdraw: () => http.del(P.me),
    generateProfile: (p) => http.post(P.profileAvatar, p),
    saveAvatar: (p) => http.post(P.avatars, p),
  },
  upload: { getSas: (p) => http.post(P.uploadSas, p) },
  study: {
    today: () => http.get(P.studyToday),
    addItem: (p) => http.post(P.studyItems, p),
    startSession: (p) => http.post(P.studySessions, p),
    pauseSession: (id) => http.post(P.studySessionAction(id, 'pause')),
    resumeSession: (id) => http.post(P.studySessionAction(id, 'resume')),
    endSession: (id, p) => http.post(P.studySessionAction(id, 'end'), p),
    weekly: () => http.get(P.studyWeekly),
    month: (ym) => http.get(P.studyMonth, { ym }),
    stats: (range) => http.get(P.studyStats, { range }),
    weeklyGoal: () => http.get(P.weeklyGoal),
    setWeeklyGoal: (p) => http.put(P.weeklyGoal, p),
    recurringGoals: () => http.get(P.recurringGoals),
    saveRecurringGoal: (g) =>
      g._id ? http.patch(P.recurringGoal(g._id), g) : http.post(P.recurringGoals, g),
    deleteRecurringGoal: (id) => http.del(P.recurringGoal(id)),
    subjects: () => http.get(P.subjects),
  },
  calendar: {
    todos: (date) => http.get(P.todos, { date }),
    addTodo: (p) => http.post(P.todos, p),
    toggleTodo: (id, done) => http.patch(P.todo(id), { done }),
    ddays: () => http.get(P.ddays),
    addDday: (p) => http.post(P.ddays, p),
    holidays: (year) => http.get(P.holidays, { year }),
    setHolidayHidden: (date, hidden) => http.patch(P.holiday(date), { hidden }),
    customHolidays: () => http.get(P.customHolidays),
    addCustomHoliday: (p) => http.post(P.customHolidays, p),
    removeCustomHoliday: (id) => http.del(P.customHoliday(id)),
    shares: () => http.get(P.calendarShares),
    createShare: (p) => http.post(P.calendarShares, p),
    revokeShare: (id) => http.del(P.calendarShare(id)),
    received: () => http.get(P.calendarSharesReceived),
    subscribe: (id) => http.post(P.calendarShareSubscribe(id)),
  },
  timetable: {
    get: () => http.get(P.timetable),
    addClass: (c) => http.post(P.timetableClasses, c),
    removeClass: (id) => http.del(P.timetableClass(id)),
    share: (p) => http.post(P.timetableShares, p),
    shares: () => http.get(P.timetableShares),
  },
  social: {
    friends: () => http.get(P.friends),
    search: (nickname) => http.get(P.userSearch, { nickname }),
    sendRequest: (userId) => http.post(P.friendRequests, { userId }),
    received: () => http.get(P.friendRequestsReceived),
    respond: (id, accept) => http.post(P.friendRequestAction(id, accept ? 'accept' : 'reject')),
    remove: (userId) => http.del(P.friend(userId)),
    openDirect: (userId) => http.post(P.directChat, { userId }),
    messages: (chatRoomId) => http.get(P.chatMessages(chatRoomId)),
  },
  content: {
    folders: () => http.get(P.folders),
    createFolder: (p) => http.post(P.folders, p),
    deleteFolder: (id) => http.del(P.folder(id)),
    materials: (folderId) => http.get(P.folderMaterials(folderId)),
    createMaterial: registerMaterial,
    material: (id) => http.get(P.material(id)),
    saveMaterial: (id) => http.patch(P.material(id), { saved: true }),
    updateSummary: (id, sections) => http.patch(P.material(id), { summary: { sections } }),
    deleteMaterial: (id) => http.del(P.material(id)),
    recording: (id) => http.get(P.materialRecording(id)),
    addBookmark: (id, atSec) => http.post(P.materialBookmarks(id), { atSec }),
    downloadUrl: (id) => http.get(P.materialDownloadUrl(id)),
    share: (p) => http.post(P.materialShare, p),
    checkImages: (files) => http.post(P.imageCheck, { files }),
    ask: (id, body) => http.post(P.materialAsk(id), body),
  },
  ai: {
    job: (id) => http.get(P.aiJob(id)),
    cancel: (id) => http.post(P.aiJobCancel(id)),
    retry: (id) => http.post(P.aiJobRetry(id)),
  },
  quiz: {
    sets: () => http.get(P.quizSets),
    createSet: (materialId) => http.post(P.quizSets, { materialId }),
    set: (id) => http.get(P.quizSet(id)),
    startAttempt: (quizSetId) => http.post(P.quizAttempts, { quizSetId }),
    answer: (attemptId, questionId, answer) =>
      http.post(P.attemptAnswer(attemptId), { questionId, answer }),
    finish: (attemptId) => http.post(P.attemptFinish(attemptId)),
    explanation: (questionId) => http.get(P.explanation(questionId)),
    similar: (id) => http.post(P.similarQuiz(id)),
    box: () => http.get(P.quizBox),
    saveToBox: (questionIds) => http.post(P.quizBox, { questionIds }),
    deleteFromBox: (questionIds) => http.post(`${P.quizBox}/delete`, { questionIds }),
    flashcards: () => http.get(P.flashcards),
    saveFlashcard: (p) => http.post(P.flashcards, p),
    deleteFlashcards: (ids) => http.post(P.flashcardsDelete, { ids }),
  },
  rooms: {
    recommended: () => http.get(P.studyRooms, { recommended: true }),
    mine: () => http.get(P.studyRooms, { mine: true }),
    create: (p) => http.post(P.studyRooms, p),
    join: (inviteCode) => http.post(P.joinRoom, { inviteCode }),
    get: (id) => http.get(P.studyRoom(id)),
    leave: (id) => http.post(P.leaveRoom(id)),
    setTimer: (id, rule) => http.put(P.roomTimer(id), rule),
    schedule: (id) => http.get(P.roomSchedule(id)),
    invite: (id, userIds) => http.post(P.roomInvites(id), { userIds }),
    shared: (id) => http.get(P.roomShared(id)),
    livekitToken: (id) => http.post(P.livekitToken(id)),
    report: (p) => http.post(P.reports, p),
    chatRoomId: async (id) =>
      (await http.get<{ chatRoomId: string }>(P.roomChatRoom(id))).chatRoomId,
  },
  shop: {
    items: (p) => http.get(P.shopItems, p),
    myItems: () => http.get(P.myItems),
    wish: async (itemId) => (await http.post<{ isWished: boolean }>(P.wish(itemId))).isWished,
    purchase: (itemId) => http.post(P.purchases, { itemId }),
    equip: (itemId) => http.post(P.equip(itemId)),
    ledger: (type) => http.get(P.pointLedger, { type }),
  },
};
