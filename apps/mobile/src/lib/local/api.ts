import {
  ERROR_CODES,
  type AiJob,
  type AiJobType,
  type CalendarShare,
  type DDay,
  type Flashcard,
  type Folder,
  type Material,
  type Message,
  type PointLedger,
  type Question,
  type QuizAttempt,
  type QuizSet,
  type RecurringGoal,
  type RoomSharedItem,
  type StudyItem,
  type StudyRoom,
  type StudySession,
  type Subject,
  type TimetableClass,
  type TimetableShare,
  type Todo,
  type User,
  type UserItem,
} from '@notelink/shared';
import { ApiError, NetworkError } from '../api/http';
import type { Api, MonthDay, RoomSchedule } from '../api/types';
import { addDays, daysBetween, parse, seoul, today, ymd } from '../dates';
import { localSocket } from '../socket';
import { useAuth } from '@/stores/auth';
import { useNet } from '@/stores/net';
import { BASE_AVATAR, DEFAULT_SUBJECTS, HOLIDAYS, SHOP } from './catalog';
import {
  ABUSE_SEC,
  DAILY_CAP_SEC,
  STREAK_MIN_SEC,
  currentStreak,
  dailyTotals,
  secondsBySeoulDay,
  levelOf,
  longestStreak,
  peakHour,
  sumRange,
  weekStart,
} from './stats';
import * as SecureStore from 'expo-secure-store';
import { roomTimerState } from './timer';
import {
  dropDb,
  dropFile,
  dropFiles,
  fileInfo,
  keptFilesIn,
  readDb,
  rememberOrphans,
  writeDb,
} from './storage';
import { avatarFace } from '../avatar-styles';
import { AI_WAITING_STEP, withTopic } from '../ai';
import { quizPoints, sessionPoints } from '../points';
import { localAnswer } from './tutor';

// 기기 저장 백엔드 — 서버(NestJS · MongoDB · Blob)가 붙기 전까지 실서버와 같은 Api를 기기 안에서 구현한다.
// 예시 데이터는 없다. 처음엔 비어 있고, 사용자가 만든 것만 계정별 파일(notelink-user-<id>.json)에 저장된다.
// AI가 필요한 일(요약 · 퀴즈 · 설명 · 프로필 생성)은 작업을 'queued'로 남겨 두고, 서버가 붙으면 처리한다.
// 다른 사용자가 필요한 일(친구 찾기 · 남의 방 들어가기 · 받은 공유)은 서버 연결 후에 된다.

type LocalFile = { uri: string; name: string; sizeBytes: number };
type LocalMaterial = Material & { files: LocalFile[] };
type Avatar = { style: string; gender: 'male' | 'female'; color: string };

type Db = {
  v: 1;
  user: User;
  terms: string[];
  subjects: Subject[];
  items: StudyItem[];
  sessions: StudySession[];
  weeklyGoal: { targetMin: number; notify80: boolean };
  recurring: RecurringGoal[];
  todos: Todo[];
  manualDdays: { _id: string; title: string; date: string; kind: string }[];
  hiddenHolidays: string[];
  customHolidays: { _id: string; name: string; date: string }[];
  calShares: CalendarShare[];
  classes: TimetableClass[];
  folders: Folder[];
  materials: LocalMaterial[];
  jobs: AiJob[];
  quizSets: QuizSet[];
  attempts: QuizAttempt[];
  quizBox: Question[];
  /** 끝난 세션의 정산 결과 (같은 종료 요청이 다시 와도 그대로 돌려준다) */
  settled?: Record<string, { durationSec: number; pointsEarned: number }>;
  /** 방 타이머를 켠 시각 (모든 참여자의 공통 기준) */
  timerStartedAt?: Record<string, number>;
  flashcards: Flashcard[];
  rooms: StudyRoom[];
  roomShared: RoomSharedItem[];
  messages: Record<string, Message[]>;
  userItems: UserItem[];
  ledger: PointLedger[];
  avatar: Avatar | null;
};

/* ── 저장 ─────────────────────────────────────────── */

const now = () => new Date().toISOString();
const uid = (p: string) =>
  `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/** 이 기기의 계정 목록: 이메일 → 사용자 id */
// 읽지 못했으면 null — 빈 목록으로 여기면 가입이 남은 계정 연결을 덮어쓰므로, 쓸 때 다시 읽는다
let accounts: Record<string, string> | null = readAccounts();
function readAccounts() {
  try {
    return (readDb('accounts') as Record<string, string> | null) ?? {};
  } catch {
    return null;
  }
}
/** 계정 목록. 읽지 못하면 가입 · 로그인을 멈춘다 (저장 오류) */
function accountsMap(): Record<string, string> {
  accounts ??= readAccounts();
  if (!accounts) throw storageError('기기의 계정 정보를 읽지 못했어요. 앱을 다시 켜 주세요');
  return accounts;
}
/** 파일은 있는데 읽지 못함 — 새로 시작하지 않고 멈춘다 */
const storageError = (message: string) => new ApiError('STORAGE_FAILED', message, 507);
/** 계정 DB 읽기. 파일이 없으면 null, 읽지 못하면 저장 오류 */
function readUserDb(id: string) {
  try {
    return readDb(`user-${id}`) as Db | null;
  } catch {
    throw storageError('기기에 저장된 기록을 읽지 못했어요. 앱을 다시 켜 주세요');
  }
}
// 지난 탈퇴 때 지우지 못한 파일을 앱을 켤 때 로그인 없이 다시 지운다
dropFiles();
const loaded = new Map<string, Db>();

function newDb(userId: string, email: string): Db {
  return {
    v: 1,
    user: {
      _id: userId,
      email,
      nickname: '',
      role: 'user',
      learnerType: 'university',
      pointBalance: 0,
      status: 'active',
      interestCategoryIds: [],
      streakDays: 0,
      settings: {
        resumePlayback: true,
        keepScreenOnWhileRecording: true,
        subtitleLanguage: '한국어',
        pageTurn: 'swipe',
        offlineCache: false,
        theme: 'light',
        doubleTapEraser: true,
        leftHanded: false,
      },
      subscription: { tier: 'free', status: 'active' },
      usage: {
        storageBytes: 0,
        storageLimitBytes: 2 * 1024 ** 3,
        aiCredits: 0,
        aiCreditLimit: 800,
      },
      createdAt: now(),
    },
    terms: [],
    subjects: [],
    items: [],
    sessions: [],
    weeklyGoal: { targetMin: 0, notify80: true },
    recurring: [],
    todos: [],
    manualDdays: [],
    hiddenHolidays: [],
    customHolidays: [],
    calShares: [],
    classes: [],
    folders: [],
    materials: [],
    jobs: [],
    quizSets: [],
    attempts: [],
    quizBox: [],
    flashcards: [],
    rooms: [],
    roomShared: [],
    messages: {},
    userItems: [],
    ledger: [],
    avatar: null,
  };
}

/** 지금 로그인한 계정의 DB. 로그인 전이면 401 */
function db(): Db {
  const id = useAuth.getState().userId;
  if (!id) throw new ApiError(ERROR_CODES.TOKEN_EXPIRED, '로그인이 필요해요', 401);
  let d = loaded.get(id);
  if (!d) {
    const read = readUserDb(id);
    if (!read) {
      // 이 기기에 계정 데이터가 없으면 서버의 토큰 만료처럼 다시 로그인하게 한다
      useAuth.getState().setExpired(true);
      throw new ApiError(ERROR_CODES.TOKEN_EXPIRED, '로그인이 필요해요', 401);
    }
    d = read;
    loaded.set(id, d);
  }
  return d;
}

// 마지막으로 파일에 쓴 내용. 바뀌지 않았으면(조회) 다시 쓰지 않는다
const savedJson = new Map<string, string>();
/** 바뀐 내용을 바로 파일에 쓴다. 성공 응답을 받은 변경은 곧바로 앱이 꺼져도 남는다 */
function save() {
  const id = useAuth.getState().userId;
  const d = id ? loaded.get(id) : undefined;
  if (!id || !d) return;
  const json = JSON.stringify(d);
  if (savedJson.get(id) === json) return;
  try {
    writeDb(`user-${id}`, d);
    savedJson.set(id, json);
  } catch {
    // 저장 못 한 변경을 메모리에 남기지 않는다. 다음 조회는 마지막 정상 파일을 읽는다
    loaded.delete(id);
    savedJson.delete(id);
    throw new ApiError(
      'STORAGE_FAILED',
      '기기에 저장하지 못했어요. 저장 공간을 확인해 주세요',
      507,
    );
  }
}

/** 응답: 바뀐 내용을 저장하고 복사본을 돌려준다(화면이 DB를 직접 바꾸지 못하게) */
/** 같은 등록 키로 다시 보내면 자료를 또 만들지 않는다. ponytail: 앱을 다시 켜면 비워진다, 서버는 DB로 보장 */
const createdMaterials = new Map<
  string,
  { payload: string; result: { material: Material; job: AiJob } }
>();

const creatingMaterials = new Map<
  string,
  { payload: string; promise: Promise<{ material: Material; job: AiJob }> }
>();

async function ok<T>(v: T): Promise<T> {
  // 오프라인이면 서버를 쓸 때와 같은 연결 오류를 낸다. 실패한 요청의 변경은 메모리에도 남기지 않는다
  if (useNet.getState().state === 'offline') {
    const id = useAuth.getState().userId;
    if (id) loaded.delete(id);
    throw new NetworkError('offline');
  }
  save();
  return v === undefined ? v : structuredClone(v);
}
const fail = (code: string, message: string, status = 400): Promise<never> =>
  Promise.reject(new ApiError(code, message, status));
/** 서버가 있어야 하는 기능 */
const needServer = (what: string) =>
  fail(ERROR_CODES.AI_MAINTENANCE, `${withTopic(what)} 서버 연결 후 쓸 수 있어요`, 503);

/* ── AI 작업: 서버가 붙을 때까지 대기열에 둔다 (FR-65-05 'AI 점검 중'과 같은 동작) ── */

function queueJob(type: AiJobType, targetType: string, targetId: string): AiJob {
  const job: AiJob = {
    _id: uid('job'),
    type,
    status: 'queued',
    targetType,
    targetId,
    progress: 0,
    attempts: 0,
    step: AI_WAITING_STEP,
    result: null,
    error: null,
    createdAt: now(),
    updatedAt: now(),
  };
  db().jobs.push(job);
  return job;
}

/* ── 계산 ─────────────────────────────────────────── */

const subjectsOf = (d: Db) => [...DEFAULT_SUBJECTS, ...d.subjects];

function subjectId(d: Db, name: string) {
  const found = subjectsOf(d).find((s) => s.name === name);
  if (found) return found._id;
  const s: Subject = {
    _id: uid('sub'),
    categoryId: null,
    name,
    color: '#c9b98f',
    sortOrder: subjectsOf(d).length,
    isActive: true,
  };
  d.subjects.push(s);
  return s._id;
}

function withStats(d: Db): User {
  const totals = dailyTotals(d.sessions);
  const storage = d.materials.reduce((a, m) => a + m.files.reduce((b, f) => b + f.sizeBytes, 0), 0);
  return {
    ...d.user,
    streakDays: currentStreak(totals),
    usage: { ...d.user.usage!, storageBytes: storage },
  };
}

function ddays(d: Db): DDay[] {
  return [
    ...d.todos
      .filter((t) => t.isDday && !t.done)
      .map((t) => ({
        _id: t._id,
        title: t.content,
        date: t.dueDate,
        source: 'todo' as const,
        kind: t.todoType === 'exam' ? '시험' : '과제',
        daysLeft: daysBetween(today(), t.dueDate),
      })),
    ...d.manualDdays.map((x) => ({
      _id: x._id,
      title: x.title,
      date: x.date,
      source: 'manual' as const,
      kind: x.kind,
      daysLeft: daysBetween(today(), x.date),
    })),
  ].sort((a, b) => (a.daysLeft < 0 ? 1 : b.daysLeft < 0 ? -1 : a.daysLeft - b.daysLeft));
}

/** 오늘(서울) 이 사유로 받은 포인트 내역 */
const paidToday = (d: Db, reasonType: string) =>
  d.ledger.filter(
    (l) =>
      l.reasonType === reasonType && l.amount > 0 && ymd(seoul(new Date(l.createdAt))) === today(),
  );

function addPoints(d: Db, amount: number, reasonType: string, description: string) {
  d.user.pointBalance += amount;
  d.ledger.unshift({
    _id: uid('pl'),
    amount,
    balanceAfter: d.user.pointBalance,
    reasonType,
    description,
    createdAt: now(),
  } as PointLedger);
}

const me = (d: Db) => ({
  userId: d.user._id,
  nickname: d.user.nickname || '나',
});

/** 끝나지 않은 세션까지 포함한 오늘 항목별 순공 초 */
function todayByItem(d: Db) {
  const t = today();
  const m = new Map<string, number>();
  for (const s of d.sessions)
    if (s.studyDate === t && s.status === 'ended' && !s.isAbuse && s.studyItemId)
      m.set(s.studyItemId, (m.get(s.studyItemId) ?? 0) + s.durationSec);
  return m;
}

/* ── 세션 · 로그인 ───────────────────────────────── */

const accountOf = (email: string) => {
  const id = accountsMap()[email.trim().toLowerCase()];
  return id && readUserDb(id) ? id : null;
};
// ponytail: 비밀번호는 기기 키체인에만 둔다. 서버가 붙으면 서버 인증으로 바뀐다
const pwKey = (id: string) => `notelink-pw-${id}`;

/** DB를 먼저 쓰고 계정 목록에 올린다. 어느 쪽이든 실패하면 계정은 없던 일이 된다 */
function createAccount(email: string, id: string) {
  const key = email.trim().toLowerCase();
  const d = newDb(id, key);
  writeDb(`user-${id}`, d);
  const next = { ...accountsMap(), [key]: id };
  try {
    writeDb('accounts', next);
  } catch (e) {
    dropDb(`user-${id}`);
    throw e;
  }
  accounts = next;
  loaded.set(id, d);
}

function signInAs(id: string) {
  const d = loaded.get(id) ?? readUserDb(id)!;
  loaded.set(id, d);
  // 기기 안에서만 쓰는 토큰 — 서버가 붙으면 서버가 발급한 토큰으로 바뀐다
  return { accessToken: `local-${id}`, refreshToken: `local-${id}`, user: withStats(d) };
}

const api: Api = {
  auth: {
    socialLogin: () => needServer('소셜 로그인'),
    emailLogin: async (email, password) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        return fail(ERROR_CODES.VALIDATION, '이메일 형식을 확인해 주세요');
      if (!password) return fail(ERROR_CODES.VALIDATION, '비밀번호를 입력해 주세요');
      const id = accountOf(email);
      if (!id || (await SecureStore.getItemAsync(pwKey(id))) !== password)
        return fail(ERROR_CODES.VALIDATION, '이메일 또는 비밀번호가 맞지 않아요');
      return signInAs(id);
    },
    // 기기 저장 모드는 메일을 보낼 수 없어, 인증번호는 6자리 숫자면 통과하고 증표 자리에 이메일을 그대로 쓴다
    emailSendCode: async (email) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        return fail(ERROR_CODES.VALIDATION, '이메일 형식을 확인해 주세요');
    },
    emailVerifyCode: async (email, code) => {
      if (!/^\d{6}$/.test(code))
        return fail(ERROR_CODES.EMAIL_CODE_INVALID, '인증번호가 맞지 않아요', 400);
      return { verificationToken: email.trim(), expiresInSeconds: 600 };
    },
    emailSignup: async (proof, password) => {
      const email = proof;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
        return fail(ERROR_CODES.VALIDATION, '이메일 형식을 확인해 주세요');
      if (password.length < 8)
        return fail(ERROR_CODES.VALIDATION, '비밀번호는 8자 이상이어야 해요');
      if (accountOf(email)) return fail(ERROR_CODES.EMAIL_TAKEN, '이미 가입한 이메일이에요', 409);
      const id = uid('user');
      try {
        await SecureStore.setItemAsync(pwKey(id), password);
        createAccount(email, id);
      } catch {
        // 비밀번호 없는 계정이나 계정 없는 비밀번호를 남기지 않아 같은 이메일로 다시 가입할 수 있다
        await SecureStore.deleteItemAsync(pwKey(id)).catch(() => {});
        return fail('STORAGE_FAILED', '가입 정보를 저장하지 못했어요. 다시 시도해 주세요', 507);
      }
    },
    agreeTerms: (codes) => {
      db().terms = codes;
      return ok(undefined);
    },
    logout: () => ok(undefined),
  },
  me: {
    interestCategories: () =>
      ok(
        ['자격증', '수능', '어학', '전공', '코딩', '공무원'].map((name, index) => ({
          _id: String(index + 1).padStart(24, '0'),
          name,
          parentId: null,
        })),
      ),
    get: () => {
      return ok(withStats(db()));
    },
    update: (patch) => {
      const d = db();
      Object.assign(d.user, { ...patch, settings: { ...d.user.settings, ...patch.settings } });
      return ok(withStats(d));
    },
    setStatus: (status) => ok(void (db().user.status = status)),
    registerDevice: () => ok(undefined),
    changePlan: (tier) => {
      const d = db();
      d.user.subscription = { tier, status: 'active' };
      d.user.usage!.storageLimitBytes = { free: 2, pro: 50, max: 200 }[tier] * 1024 ** 3;
      return ok(withStats(d));
    },
    withdraw: async () => {
      // 탈퇴: 이 계정의 기록과 기기에 복사해 둔 파일을 모두 지운다 (FR-03-08)
      const d = db();
      const id = d.user._id;
      const files = keptFilesIn(d);
      // 지울 파일 목록을 먼저 기기에 적고, DB(백업 포함)를 지운다.
      // 둘 중 하나라도 실패하면 계정이 그대로라 로그인한 채 다시 시도할 수 있다
      try {
        rememberOrphans(`user-${id}`, files);
        dropDb(`user-${id}`);
      } catch {
        return fail('STORAGE_FAILED', '탈퇴를 마치지 못했어요. 다시 시도해 주세요', 507);
      }
      loaded.delete(id);
      savedJson.delete(id);
      // DB가 없으면 로그인되지 않으므로 계정 목록 정리가 실패해도 남은 항목은 쓰이지 않는다
      try {
        const next = Object.fromEntries(Object.entries(accountsMap()).filter(([, v]) => v !== id));
        writeDb('accounts', next);
        accounts = next;
      } catch {
        // 다음 저장 · 실행 때 다시 읽는다
      }
      // 자료 원본 · 프로필 사진 등 이 계정이 기기에 복사해 둔 파일을 모두 지운다.
      // 계정이 없어져 재시도할 수 없으니, 못 지운 파일은 기기 목록에 남겨 다음 실행 때 다시 지운다
      dropFiles();
      // 계정이 이미 없어 재시도할 수 없으므로 비밀번호 삭제 실패로 탈퇴를 막지 않는다
      // (남은 비밀번호는 어떤 계정과도 이어지지 않는다)
      await SecureStore.deleteItemAsync(pwKey(id)).catch(() => {});
    },
    generateProfile: async (p) => {
      try {
        return await ok(queueJob('avatar_profile', 'user', p.photoBlobUrl));
      } catch (e) {
        // 요청이 실패하면 DB에 남지 않으므로 방금 복사한 사진도 지운다 (다시 시도하면 새로 복사한다)
        dropFile(p.photoBlobUrl);
        throw e;
      }
    },
    saveAvatar: (p) => {
      const d = db();
      d.avatar = p;
      // 프로필 · 친구 목록 · 스터디룸이 avatarUrl을 그린다 — 고른 스타일의 얼굴을 넣는다
      d.user.avatarUrl = avatarFace(p.style, p.gender);
      return ok(undefined);
    },
  },
  upload: {
    // 기기 저장 모드에서는 upload.ts가 파일을 앱 저장 공간에 바로 복사한다
    getSas: () => needServer('클라우드 업로드'),
  },
  study: {
    today: () => {
      const d = db();
      const by = todayByItem(d);
      const t = today();
      const todays = d.sessions.filter((s) => s.studyDate === t && s.status === 'ended');
      const sum = (f: (s: StudySession) => boolean) =>
        todays.filter((s) => !s.isAbuse && f(s)).reduce((a, s) => a + s.durationSec, 0);
      const totalSec = Math.min(
        DAILY_CAP_SEC,
        sum(() => true),
      );
      return ok({
        _id: `dr-${t}`,
        studyDate: t,
        totalSec,
        personalSec: sum((s) => s.mode !== 'room'),
        roomSec: sum((s) => s.mode === 'room'),
        streakOk: totalSec >= STREAK_MIN_SEC,
        items: d.items.map((i) => ({ ...i, accumulatedSec: by.get(i._id) ?? 0 })),
      });
    },
    addItem: (p) => {
      const d = db();
      const it: StudyItem = {
        _id: uid('item'),
        title: p.title,
        subjectId: subjectId(d, p.subjectName),
        subjectName: p.subjectName,
        goalMin: p.goalMin,
        accumulatedSec: 0,
      };
      d.items.push(it);
      return ok(it);
    },
    startSession: async (p) => {
      await ok(undefined);
      const s: StudySession = {
        _id: uid('ss'),
        studyDate: today(),
        studyItemId: p.studyItemId,
        roomId: null,
        mode: p.mode,
        status: 'running',
        startedAt: now(),
        endedAt: null,
        durationSec: 0,
        departureCount: 0,
        endReason: null,
        isAbuse: false,
        pauses: [],
      };
      db().sessions.push(s);
      return ok(s);
    },
    pauseSession: (id) => {
      const s = db().sessions.find((x) => x._id === id);
      s?.pauses.push({ startedAt: now(), endedAt: null, reason: 'manual' });
      return ok(undefined);
    },
    resumeSession: (id) => {
      const p = db()
        .sessions.find((x) => x._id === id)
        ?.pauses.at(-1);
      if (p && !p.endedAt) p.endedAt = now();
      return ok(undefined);
    },
    endSession: (id, p) => {
      const d = db();
      const s = d.sessions.find((x) => x._id === id);
      if (!s) return ok({ durationSec: 0, pointsEarned: 0 });
      // 이미 끝난 세션은 다시 정산하지 않고 처음 결과를 돌려준다
      const settled = d.settled?.[id];
      if (s.status === 'ended' && settled) return ok(settled);
      // 시간은 기기가 보낸 값이 아니라 저장된 시작 · 일시정지 시각으로 계산한다
      const endMs = Date.now();
      const days = secondsBySeoulDay(
        Date.parse(s.startedAt),
        endMs,
        s.pauses.map((x) => ({
          startMs: Date.parse(x.startedAt),
          endMs: x.endedAt ? Date.parse(x.endedAt) : endMs,
        })),
      );
      const isAbuse = [...days.values()].reduce((a, v) => a + v, 0) >= ABUSE_SEC;
      let durationSec = 0;
      // 자정을 넘긴 시간은 그 날짜에 쌓고, 하루 16시간을 넘는 부분은 세지 않는다 (FR-06-15)
      for (const [day, sec] of days) {
        const before = dailyTotals(d.sessions).get(day) ?? 0;
        const counted = Math.max(0, Math.min(sec, DAILY_CAP_SEC - before));
        durationSec += counted;
        const part = { status: 'ended', endedAt: now(), durationSec: counted, isAbuse };
        const reason = { endReason: p.endReason };
        if (day === s.studyDate) Object.assign(s, part, reason);
        else
          d.sessions.push({
            ...s,
            ...part,
            ...reason,
            _id: uid('ss'),
            studyDate: day,
            startedAt: new Date(Date.parse(`${day}T00:00:00+09:00`)).toISOString(),
            pauses: [],
          } as StudySession);
      }
      // 시작 날짜에 공부한 시간이 없어도(바로 일시정지 등) 세션은 끝낸다
      if (s.status !== 'ended')
        Object.assign(s, { status: 'ended', endedAt: now(), endReason: p.endReason, isAbuse });
      const pts = sessionPoints(
        !isAbuse && durationSec >= STREAK_MIN_SEC,
        paidToday(d, 'session_complete').length,
      );
      if (pts) addPoints(d, pts, 'session_complete', '순공 세션 완료');
      (d.settled ??= {})[id] = { durationSec, pointsEarned: pts };
      return ok({ durationSec, pointsEarned: pts });
    },
    weekly: () => {
      const d = db();
      const totals = dailyTotals(d.sessions);
      const start = weekStart();
      const passed = daysBetween(start, today()) + 1;
      const lastStart = ymd(addDays(parse(start), -7));
      return ok({
        weekStart: start,
        totalSec: sumRange(totals, start, 7),
        // 지난주 같은 요일까지와 비교한다
        diffFromLastWeekSec: sumRange(totals, start, passed) - sumRange(totals, lastStart, passed),
        goalMin: d.weeklyGoal.targetMin,
        days: Array.from({ length: 7 }, (_, i) => {
          const day = ymd(addDays(parse(start), i));
          return { studyDate: day, totalSec: totals.get(day) ?? 0 };
        }),
      });
    },
    month: (ym) => {
      const d = db();
      const totals = dailyTotals(d.sessions);
      const [y = 2026, m = 1] = ym.split('-').map(Number);
      const n = new Date(y, m, 0).getDate();
      const todoDays = new Set(d.todos.map((t) => t.dueDate));
      return ok(
        Array.from({ length: n }, (_, i): MonthDay => {
          const day = ymd(new Date(y, m - 1, i + 1));
          return {
            studyDate: day,
            level: levelOf(totals.get(day) ?? 0),
            hasTodo: todoDays.has(day),
          };
        }),
      );
    },
    stats: (range) => {
      const d = db();
      const totals = dailyTotals(d.sessions);
      const to = today();
      const first = [...totals.keys()].sort()[0] ?? to;
      const from = range === 'all' ? first : ymd(addDays(seoul(), range === '90d' ? -89 : -29));
      const inRange = [...totals.entries()].filter(([k]) => k >= from && k <= to);
      return ok({
        totalSec: inRange.reduce((a, [, v]) => a + v, 0),
        studyDays: inRange.filter(([, v]) => v >= STREAK_MIN_SEC).length,
        longestStreak: longestStreak(totals, from, to),
        peakHour: peakHour(d.sessions.filter((s) => s.studyDate >= from)) ?? -1,
        heatmap: Array.from({ length: 126 }, (_, i) => {
          const day = ymd(addDays(seoul(), i - 125));
          return { studyDate: day, level: levelOf(totals.get(day) ?? 0) };
        }),
      });
    },
    weeklyGoal: () => {
      const d = db();
      const totals = dailyTotals(d.sessions);
      const start = weekStart();
      // 최근 4주(이번 주 제외) 평균 (FR-06-24)
      const weeks = [1, 2, 3, 4].map((w) =>
        sumRange(totals, ymd(addDays(parse(start), -7 * w)), 7),
      );
      return ok({
        _id: `wg-${start}`,
        weekStart: start,
        ...d.weeklyGoal,
        recentAvgMin: Math.round(weeks.reduce((a, b) => a + b, 0) / 4 / 60),
      });
    },
    setWeeklyGoal: (p) => {
      const d = db();
      d.weeklyGoal = {
        targetMin: Math.max(0, Math.min(7 * 24 * 60, p.targetMin)),
        notify80: p.notify80,
      };
      return api.study.weeklyGoal();
    },
    recurringGoals: () => ok(db().recurring),
    saveRecurringGoal: (g) => {
      const d = db();
      const cur = d.recurring.find((x) => x._id === g._id);
      if (cur) return ok(Object.assign(cur, g));
      const n: RecurringGoal = {
        _id: uid('rg'),
        days: [],
        targetMin: 30,
        subjectId: null,
        remindEnabled: false,
        remindTime: null,
        pausedUntil: null,
        streak: 0,
        isActive: true,
        ...g,
      } as RecurringGoal;
      d.recurring.push(n);
      return ok(n);
    },
    deleteRecurringGoal: (id) => {
      const d = db();
      d.recurring = d.recurring.filter((g) => g._id !== id);
      return ok(undefined);
    },
    subjects: () => ok(subjectsOf(db())),
  },
  calendar: {
    todos: (date) => ok(db().todos.filter((t) => t.dueDate === date && !t.isDday)),
    addTodo: (p) => {
      const d = db();
      const t: Todo = {
        _id: uid('todo'),
        dueDate: p.dueDate,
        content: p.content,
        todoType: p.todoType,
        isDday: p.todoType !== 'general',
        timeSlot: p.timeSlot,
        dueTime: p.dueTime ?? null,
        subjectId: p.subjectName ? subjectId(d, p.subjectName) : null,
        subjectName: p.subjectName ?? undefined,
        done: false,
        doneAt: null,
        createdAt: now(),
      };
      d.todos.push(t);
      // 과제 · 시험은 D-day로도 올라가고 그날 할 일에도 남는다 (FR-10-10)
      if (t.isDday) d.todos.push({ ...t, _id: uid('todo'), isDday: false });
      return ok(t);
    },
    toggleTodo: (id, done) => {
      Object.assign(db().todos.find((t) => t._id === id) ?? {}, {
        done,
        doneAt: done ? now() : null,
      });
      return ok(undefined);
    },
    ddays: () => ok(ddays(db())),
    addDday: (p) => {
      const x = { _id: uid('dd'), title: p.title, date: p.date, kind: '목표일' };
      db().manualDdays.push(x);
      return ok({ ...x, source: 'manual' as const, daysLeft: daysBetween(today(), p.date) });
    },
    holidays: (year) => {
      const hidden = new Set(db().hiddenHolidays);
      return ok(
        HOLIDAYS.map(([md, name]) => ({ _id: `${year}-${md}`, name, hidden: hidden.has(md) })),
      );
    },
    setHolidayHidden: (date, hidden) => {
      const d = db();
      const md = date.slice(5);
      d.hiddenHolidays = hidden
        ? [...new Set([...d.hiddenHolidays, md])]
        : d.hiddenHolidays.filter((x) => x !== md);
      return ok(undefined);
    },
    customHolidays: () => ok(db().customHolidays),
    addCustomHoliday: (p) => ok(void db().customHolidays.push({ _id: uid('ch'), ...p })),
    removeCustomHoliday: (id) => {
      const d = db();
      d.customHolidays = d.customHolidays.filter((h) => h._id !== id);
      return ok(undefined);
    },
    shares: () => ok(db().calShares.filter((s) => !s.revokedAt)),
    // 다른 사람이 열 수 있는 링크는 서버가 있어야 만들 수 있다
    createShare: () => needServer('캘린더 공유'),
    revokeShare: (id) => {
      Object.assign(db().calShares.find((s) => s._id === id) ?? {}, { revokedAt: now() });
      return ok(undefined);
    },
    received: () => ok([]),
    subscribe: () => needServer('공유받은 캘린더 추가'),
  },
  timetable: {
    get: () => ok({ _id: 'tt', updatedAt: now(), classes: db().classes }),
    addClass: (c) => {
      const k: TimetableClass = { ...c, _id: uid('cls'), source: 'manual' };
      db().classes.push(k);
      return ok(k);
    },
    removeClass: (id) => {
      const d = db();
      d.classes = d.classes.filter((c) => c._id !== id);
      return ok(undefined);
    },
    share: () => needServer('시간표 공유'),
    shares: () => ok([] as TimetableShare[]),
  },
  social: {
    friends: () => ok([]),
    search: () => needServer('친구 찾기'),
    sendRequest: () => needServer('친구 요청'),
    received: () => ok([]),
    respond: () => needServer('친구 요청 응답'),
    remove: () => ok(undefined),
    openDirect: (userId) =>
      ok({
        _id: `dm-${userId}`,
        type: 'direct' as const,
        studyRoomId: null,
        lastMessage: null,
        members: [],
        updatedAt: now(),
      }),
    messages: (id, before) => {
      const items = db().messages[id] ?? [];
      const end = before
        ? Math.max(
            0,
            items.findIndex((item) => item._id === before),
          )
        : items.length;
      return ok(items.slice(Math.max(0, end - 50), end));
    },
  },
  content: {
    folders: () => {
      const d = db();
      return ok(
        d.folders.map((f) => ({
          ...f,
          materialCount: d.materials.filter((m) => m.folderId === f._id).length,
        })),
      );
    },
    createFolder: (p) => {
      const d = db();
      const f: Folder = {
        _id: uid('fo'),
        title: p.title,
        subjectId: subjectId(d, p.subjectName),
        subjectName: p.subjectName,
        createdAt: now(),
        updatedAt: now(),
      };
      d.folders.push(f);
      return ok(f);
    },
    deleteFolder: async (id) => {
      const d = db();
      const files = d.materials.filter((x) => x.folderId === id).flatMap((m) => m.files);
      d.materials = d.materials.filter((m) => m.folderId !== id);
      d.folders = d.folders.filter((f) => f._id !== id);
      // 기록을 저장한 뒤에 원본을 지운다. 저장이 실패하면 자료와 원본이 그대로 남는다
      await ok(undefined);
      for (const f of files) dropFile(f.uri);
    },
    materials: (folderId) =>
      ok(
        db()
          .materials.filter((m) => m.folderId === folderId)
          .map(({ files: _f, ...m }) => m),
      ),
    createMaterial: (p) => {
      const { requestId, ...payload } = p;
      const key = requestId ? `${useAuth.getState().userId}:${requestId}` : null;
      const fingerprint = JSON.stringify(payload);
      const conflict = () =>
        new ApiError('IDEMPOTENCY_CONFLICT', '같은 등록 키에 다른 자료를 보낼 수 없어요', 409);
      // 같은 키의 등록이 진행 중이면 새로 만들지 않고 그 결과를 함께 받는다
      const pending = key ? creatingMaterials.get(key) : undefined;
      if (pending) {
        if (pending.payload !== fingerprint) return Promise.reject(conflict());
        return pending.promise.then((r) => structuredClone(r));
      }
      const register = async () => {
        await ok(undefined);
        const previous = key ? createdMaterials.get(key) : undefined;
        if (previous) {
          if (previous.payload !== fingerprint) throw conflict();
          return structuredClone(previous.result);
        }
        const d = db();
        const files: LocalFile[] = p.blobUrls.map((uri) => {
          const info = fileInfo(uri);
          return { uri, name: info.name, sizeBytes: info.size };
        });
        const images = p.kind === 'handwriting' || p.source === 'scan';
        const type = (
          {
            handwriting: 'handwriting_summary',
            recording: 'recording_summary',
            document: 'document_summary',
          } as const
        )[p.kind];
        const m: LocalMaterial = {
          _id: uid('mat'),
          folderId: p.folderId,
          kind: p.kind,
          source: p.source,
          title: p.title,
          description: p.description ?? null,
          avatarItemId: p.avatarItemId ?? null,
          processing: { status: 'queued', progress: 0, jobId: null },
          summary: null,
          keywords: [],
          bookmarks: [],
          pages: images
            ? files.map((f, i) => ({
                pageNo: i + 1,
                imageUrl: f.uri,
                sizeBytes: f.sizeBytes,
                ocrText: null,
                takenAt: now(),
              }))
            : undefined,
          createdAt: now(),
          files,
        };
        d.materials.push(m);
        const job = queueJob(type, 'material', m._id);
        m.processing.jobId = job._id;
        Object.assign(d.folders.find((f) => f._id === p.folderId) ?? {}, { updatedAt: now() });
        const result = { material: { ...m, files: undefined } as unknown as Material, job };
        const saved = await ok(result);
        // 저장에 성공한 뒤에만 기억한다. 실패한 등록을 재시도하면 다시 만든다
        if (key)
          createdMaterials.set(key, { payload: fingerprint, result: structuredClone(saved) });
        return saved;
      };
      if (!key) return register();
      const promise = register().finally(() => creatingMaterials.delete(key));
      creatingMaterials.set(key, { payload: fingerprint, promise });
      return promise.then((r) => structuredClone(r));
    },
    material: (id) => {
      const m = db().materials.find((x) => x._id === id);
      if (!m) return fail(ERROR_CODES.NOT_FOUND, '자료를 찾을 수 없어요', 404);
      const { files: _f, ...rest } = m;
      return ok(rest as Material);
    },
    saveMaterial: () => ok(undefined),
    updateSummary: (id, sections) => {
      const m = db().materials.find((x) => x._id === id);
      if (!m) return fail(ERROR_CODES.NOT_FOUND, '자료를 찾을 수 없어요', 404);
      m.summary = { sections, points: m.summary?.points ?? [] };
      const { files: _f, ...rest } = m;
      return ok(rest as Material);
    },
    deleteMaterial: async (id) => {
      const d = db();
      const m = d.materials.find((x) => x._id === id);
      d.materials = d.materials.filter((x) => x._id !== id);
      d.jobs = d.jobs.filter((j) => j.targetId !== id);
      // 기록을 저장한 뒤에 원본을 지운다. 저장이 실패하면 자료와 원본이 그대로 남는다
      await ok(undefined);
      for (const f of m?.files ?? []) dropFile(f.uri);
    },
    recording: (id) => {
      const m = db().materials.find((x) => x._id === id);
      if (!m) return fail(ERROR_CODES.NOT_FOUND, '자료를 찾을 수 없어요', 404);
      // 대본 · 슬라이드는 AI(STT)가 만든다 — 그전까지는 원본 녹음만 재생한다
      return ok({
        _id: `rec-${id}`,
        materialId: id,
        audioUrl: m.files[0]?.uri ?? '',
        audioSizeBytes: m.files[0]?.sizeBytes ?? 0,
        durationSec: 0,
        transcript: { text: '', segments: [] },
        slides: [],
        visemeUrl: null,
      });
    },
    addBookmark: (id, atSec) => {
      db()
        .materials.find((m) => m._id === id)
        ?.bookmarks.push({ atSec });
      return ok(undefined);
    },
    downloadUrl: (id) => {
      const m = db().materials.find((x) => x._id === id);
      const f = m?.files[0];
      if (!m || !f) return fail(ERROR_CODES.NOT_FOUND, '원본 파일이 없어요', 404);
      return ok({ url: f.uri, fileName: f.name || m.title });
    },
    share: (p) => {
      const d = db();
      if (p.target.type !== 'room') return needServer('친구에게 자료 공유');
      for (const materialId of p.materialIds) {
        const m = d.materials.find((x) => x._id === materialId);
        if (!m) continue;
        d.roomShared.push({
          _id: uid('rs'),
          roomId: p.target.id,
          sharedBy: d.user._id,
          sharedByNickname: me(d).nickname,
          itemType: 'material',
          quizSetId: null,
          folderId: m.folderId,
          materialId,
          questionIds: [],
          flashcardIds: [],
          title: m.title,
          createdAt: now(),
        });
      }
      return ok(undefined);
    },
    // 필기 여부 · 흐림 판별은 AI 서버가 한다. 기기에서는 형식 · 용량만 확인하고 통과시킨다
    checkImages: (files) => ok(files.map((f) => ({ name: f.name, verdict: 'ok' as const }))),
    // 서버 AI 대신 노트에서 질문과 가장 많이 겹치는 부분을 골라 바로 답한다(완료된 작업으로)
    ask: (id, body) => {
      const m = db().materials.find((x) => x._id === id);
      if (!m) return fail(ERROR_CODES.NOT_FOUND, '노트를 찾을 수 없어요', 404);
      const result = localAnswer(m, body.question);
      if (!result)
        return fail(ERROR_CODES.NOTE_NOT_READY, '노트 정리가 끝나면 물어볼 수 있어요', 409);
      const job = queueJob('note_ask', 'material', id);
      Object.assign(job, { status: 'succeeded', progress: 100, step: undefined, result });
      // 답 하나는 LLM 요청 한 번: 서버처럼 AI 크레딧을 쓴다(요약 · 퀴즈는 서버가 처리할 때 쓴다)
      const usage = db().user.usage;
      if (usage) usage.aiCredits += 1;
      return ok(job);
    },
  },
  ai: {
    job: (id) => {
      const j = db().jobs.find((x) => x._id === id);
      return j ? ok(j) : fail(ERROR_CODES.NOT_FOUND, '작업을 찾을 수 없어요', 404);
    },
    cancel: (id) => {
      Object.assign(db().jobs.find((x) => x._id === id) ?? {}, {
        status: 'canceled',
        updatedAt: now(),
      });
      return ok(undefined);
    },
    retry: (id) => {
      const j = db().jobs.find((x) => x._id === id);
      if (!j) return fail(ERROR_CODES.NOT_FOUND, '작업을 찾을 수 없어요', 404);
      Object.assign(j, { status: 'queued', step: AI_WAITING_STEP, error: null, updatedAt: now() });
      return ok(j);
    },
  },
  quiz: {
    sets: () => ok(db().quizSets),
    createSet: (materialId) => {
      const d = db();
      const m = d.materials.find((x) => x._id === materialId);
      if (!m) return fail(ERROR_CODES.NOT_FOUND, '노트를 찾을 수 없어요', 404);
      const qs: QuizSet = {
        _id: uid('qs'),
        materialId,
        folderId: m.folderId,
        sourceSetId: null,
        title: m.title,
        status: 'generating',
        progress: 0,
        questionCount: 0,
        questions: [],
        createdAt: now(),
      };
      d.quizSets.unshift(qs);
      return ok({ quizSet: qs, job: queueJob('quiz_generate', 'quiz_set', qs._id) });
    },
    set: (id) => {
      const qs = db().quizSets.find((q) => q._id === id) ?? db().quizSets[0];
      return qs ? ok(qs) : fail(ERROR_CODES.NOT_FOUND, '퀴즈를 찾을 수 없어요', 404);
    },
    startAttempt: (quizSetId) => {
      const d = db();
      const qs = d.quizSets.find((q) => q._id === quizSetId);
      const a: QuizAttempt = {
        _id: uid('att'),
        quizSetId,
        correctCount: 0,
        total: qs?.questions.length ?? 0,
        pointsEarned: 0,
        answers: [],
        startedAt: now(),
        finishedAt: null,
      };
      d.attempts.push(a);
      return ok(a);
    },
    answer: async (attemptId, questionId, answer) => {
      await ok(undefined);
      const d = db();
      const a = d.attempts.find((x) => x._id === attemptId);
      const q = d.quizSets
        .find((s) => s._id === a?.quizSetId)
        ?.questions.find((x) => x._id === questionId);
      if (!a || !q) return fail(ERROR_CODES.NOT_FOUND, '문제를 찾을 수 없어요', 404);
      const correct = q.answer === answer;
      a.answers = [
        ...a.answers.filter((x) => x.questionId !== questionId),
        { questionId, answer, correct, tries: 1 },
      ];
      a.correctCount = a.answers.filter((x) => x.correct).length;
      return ok({ correct, correctAnswer: q.answer });
    },
    finish: (attemptId) => {
      const d = db();
      const a = d.attempts.find((x) => x._id === attemptId);
      if (!a) return fail(ERROR_CODES.NOT_FOUND, '풀이 기록이 없어요', 404);
      const quizToday = paidToday(d, 'quiz_correct').reduce((n, l) => n + l.amount, 0);
      const pts = a.finishedAt ? 0 : quizPoints(a.correctCount, quizToday);
      if (pts) addPoints(d, pts, 'quiz_correct', `퀴즈 정답 ${a.correctCount}개`);
      Object.assign(a, { finishedAt: a.finishedAt ?? now(), pointsEarned: a.pointsEarned || pts });
      return ok({ pointsEarned: pts, balance: d.user.pointBalance });
    },
    explanation: () => needServer('AI 설명'),
    similar: () => needServer('유사 퀴즈'),
    box: () => ok(db().quizBox),
    saveToBox: (questionIds) => {
      const d = db();
      const all = d.quizSets.flatMap((s) => s.questions);
      const selected = [...new Set(questionIds)].map((id) => all.find((q) => q._id === id));
      if (selected.some((q) => !q))
        return fail(ERROR_CODES.NOT_FOUND, '보관할 문제를 찾을 수 없어요', 404);
      for (const q of selected as Question[])
        if (!d.quizBox.some((x) => x._id === q._id)) d.quizBox.push(q);
      return ok(d.quizBox);
    },
    deleteFromBox: (questionIds) => {
      const d = db();
      d.quizBox = d.quizBox.filter((q) => !questionIds.includes(q._id));
      return ok(undefined);
    },
    flashcards: () => ok(db().flashcards),
    saveFlashcard: (p) => {
      const d = db();
      const f: Flashcard = {
        _id: uid('fc'),
        materialId: null,
        folderId: d.folders[0]?._id ?? 'none',
        front: p.front,
        back: p.back,
        sourceQuizSetId: null,
        sourceQuestionId: p.sourceQuestionId ?? null,
        lastResult: null,
        createdAt: now(),
      } as Flashcard;
      d.flashcards.push(f);
      return ok(f);
    },
    deleteFlashcards: (ids) => {
      const d = db();
      d.flashcards = d.flashcards.filter((f) => !ids.includes(f._id));
      return ok(undefined);
    },
  },
  rooms: {
    // 공개 방 찾기는 다른 사람의 방이 있어야 하므로 서버 연결 후에 보인다
    recommended: () => ok([]),
    mine: () => ok(db().rooms.filter((r) => !r.closedAt)),
    create: (p) => {
      const d = db();
      const r: StudyRoom = {
        _id: uid('room'),
        title: p.title,
        categoryId: subjectId(d, p.categoryName),
        categoryName: p.categoryName,
        hostId: d.user._id,
        isPublic: p.isPublic,
        inviteCode: Math.random().toString(36).slice(2, 8).toUpperCase().padEnd(6, 'X'),
        maxCapacity: 8,
        memberCount: 1,
        timerRule: null,
        members: [
          { ...me(d), role: 'host', status: 'joined', camOn: false, micOn: false, todaySec: 0 },
        ],
        createdAt: now(),
        closedAt: null,
      };
      d.rooms.push(r);
      return ok(r);
    },
    join: (code) => {
      const r = db().rooms.find((x) => x.inviteCode === code.toUpperCase());
      if (!r)
        return fail(
          ERROR_CODES.ROOM_CODE_INVALID,
          '유효하지 않은 코드입니다 · 다른 사람의 방은 서버 연결 후 들어갈 수 있어요',
        );
      return ok(r);
    },
    get: (id) => {
      const d = db();
      const r = d.rooms.find((x) => x._id === id);
      if (!r) return fail(ERROR_CODES.NOT_FOUND, '스터디룸을 찾을 수 없어요', 404);
      // 내 오늘 순공시간은 기록에서 계산한다
      const mine = dailyTotals(d.sessions).get(today()) ?? 0;
      return ok({
        ...r,
        // 단계는 지금 시각으로 다시 계산한다 (나갔다 들어와도 같은 박자)
        timerState: roomTimerState(r.timerRule, d.timerStartedAt?.[id] ?? Date.now()),
        members: r.members.map((m) =>
          m.userId === d.user._id ? { ...m, nickname: me(d).nickname, todaySec: mine } : m,
        ),
      });
    },
    leave: (id) => {
      const d = db();
      d.rooms = d.rooms.filter((r) => r._id !== id);
      return ok(undefined);
    },
    setTimer: async (id, rule) => {
      const r = db().rooms.find((x) => x._id === id);
      if (!r) return fail(ERROR_CODES.NOT_FOUND, '스터디룸을 찾을 수 없어요', 404);
      const d = db();
      r.timerRule = rule;
      (d.timerStartedAt ??= {})[id] = Date.now();
      r.timerState = roomTimerState(rule, d.timerStartedAt[id]);
      const saved = await ok(r);
      // 저장에 성공한 뒤에만 알린다. 실패한 설정을 화면이 적용하지 않게
      localSocket.push('room:timer', {
        roomId: id,
        rule,
        phase: r.timerState?.phase ?? 'focus',
        endsAt: r.timerState?.endsAt ?? null,
      });
      return saved;
    },
    schedule: () => {
      // 멤버 시간표: 지금은 내 시간표로 바쁜 시간만 칠한다 (다른 멤버는 서버 연결 후)
      const d = db();
      const startHour = 9;
      const grid = Array.from({ length: 14 }, (_, h) =>
        Array.from({ length: 7 }, (_, day) =>
          d.classes.some((c) => {
            const wd = (day + 1) % 7; // 월요일부터
            const [sh = 0] = c.startTime.split(':').map(Number);
            const [eh = 0, em = 0] = c.endTime.split(':').map(Number);
            const hour = startHour + h;
            return c.days.includes(wd) && hour >= sh && (hour < eh || (hour === eh && em > 0));
          })
            ? 1
            : 0,
        ),
      );
      const out: RoomSchedule = {
        members: [{ nickname: me(d).nickname, emoji: '✏️' }],
        grid,
        startHour,
        matches: [],
      };
      return ok(out);
    },
    invite: () => needServer('친구 초대'),
    shared: (id) => {
      const d = db();
      const items = d.roomShared.filter((x) => x.roomId === id);
      const cardIds = new Set(items.flatMap((x) => x.flashcardIds));
      return ok({ items, flashcards: d.flashcards.filter((f) => cardIds.has(f._id)) });
    },
    livekitToken: () => needServer('캠 · 음성'),
    report: () => needServer('신고'),
    chatRoomId: (id) => ok(`room-chat-${id}`),
  },
  shop: {
    items: (p) => {
      const d = db();
      const bought = new Map<string, number>();
      for (const u of d.userItems) if (u.isOwned) bought.set(u.itemId, 1);
      let list = SHOP.filter((i) => !p.category || i.category === p.category).map((i) => ({
        ...i,
        purchaseCount: bought.get(i._id) ?? 0,
      }));
      if (p.sort === 'price') list = [...list].sort((a, b) => a.price - b.price);
      if (p.sort === 'popular') list = [...list].sort((a, b) => b.purchaseCount - a.purchaseCount);
      return ok(list);
    },
    myItems: () => ok(db().userItems),
    wish: (itemId) => {
      const d = db();
      let ui = d.userItems.find((u) => u.itemId === itemId);
      if (!ui)
        d.userItems.push(
          (ui = {
            _id: uid('ui'),
            itemId,
            itemCategory: SHOP.find((i) => i._id === itemId)?.category ?? 'avatar',
            isOwned: false,
            isWished: false,
            isEquipped: false,
            acquiredAt: null,
          }),
        );
      ui.isWished = !ui.isWished;
      return ok(ui.isWished);
    },
    purchase: async (itemId) => {
      await ok(undefined);
      const d = db();
      const item = SHOP.find((i) => i._id === itemId);
      if (!item) return fail(ERROR_CODES.NOT_FOUND, '상품을 찾을 수 없어요', 404);
      if (d.user.pointBalance < item.price)
        return fail(ERROR_CODES.POINTS_INSUFFICIENT, '포인트가 부족해요');
      let ui = d.userItems.find((u) => u.itemId === itemId);
      if (ui?.isOwned) return fail(ERROR_CODES.ALREADY_OWNED, '이미 가진 아이템이에요');
      if (!ui)
        d.userItems.push(
          (ui = {
            _id: uid('ui'),
            itemId,
            itemCategory: item.category,
            isOwned: false,
            isWished: false,
            isEquipped: false,
            acquiredAt: null,
          }),
        );
      Object.assign(ui, { isOwned: true, acquiredAt: now() });
      addPoints(d, -item.price, 'purchase', `${item.name} 구매`);
      return ok({ balance: d.user.pointBalance });
    },
    equip: (itemId) => {
      const d = db();
      // 기본 아바타는 보유 기록 없이 누구나 쓴다 — 낀 아바타를 모두 풀면 기본 아바타다
      if (itemId === BASE_AVATAR._id) {
        for (const u of d.userItems) if (u.itemCategory === 'avatar') u.isEquipped = false;
        return ok(undefined);
      }
      const target = d.userItems.find((u) => u.itemId === itemId && u.isOwned);
      if (!target) return fail(ERROR_CODES.NOT_FOUND, '보유한 아이템이 아니에요', 404);
      // 같은 종류(아바타 · 테마)끼리만 바꿔 낀다
      for (const u of d.userItems)
        if (u.itemCategory === target.itemCategory) u.isEquipped = u === target;
      return ok(undefined);
    },
    ledger: (type) =>
      ok(db().ledger.filter((l) => !type || (type === 'earn' ? l.amount > 0 : l.amount < 0))),
  },
};

/** 로그인 전 호출(db()가 바로 던지는 경우)도 실서버처럼 거절된 Promise로 돌려준다 */
function asAsync<T extends object>(o: T): T {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      typeof v === 'function'
        ? (...a: unknown[]) => {
            try {
              return Promise.resolve(v(...a));
            } catch (e) {
              return Promise.reject(e);
            }
          }
        : asAsync(v as object),
    ]),
  ) as T;
}

export const localApi: Api = asAsync(api);

/** 채팅: 보낸 메시지를 저장하고 화면에 돌려준다 (다른 사람에게 전달은 서버 연결 후) */
localSocket.onClient = (ev, args) => {
  if (ev === 'room:join') {
    const ack = args[1] as ((result: { ok: boolean }) => void) | undefined;
    ack?.({ ok: true });
    return;
  }
  if (ev !== 'chat:send') return;
  const [p, ack] = args as [
    { chatRoomId: string; text: string; clientId: string },
    ((m: Message) => void) | undefined,
  ];
  const d = db();
  const m: Message = {
    _id: uid('msg'),
    chatRoomId: p.chatRoomId,
    senderId: d.user._id,
    senderNickname: me(d).nickname,
    type: 'text',
    text: p.text,
    sharedItemId: null,
    createdAt: now(),
    clientId: p.clientId,
  };
  d.messages[p.chatRoomId] = [...(d.messages[p.chatRoomId] ?? []), m];
  try {
    save();
  } catch {
    return; // 확인 응답을 보내지 않아 화면이 전송 실패로 안내하고 다시 보내게 한다
  }
  setTimeout(() => (ack ? ack(m) : localSocket.push('chat:message', m)), 0);
};

/** 테스트용: 문제가 다 만들어진 퀴즈를 넣는다 (기기 저장 모드는 퀴즈 생성을 AI 서버에 맡겨 직접 만들 수 없다) */
export const seedQuizForTests = (answers: string[]) => {
  const d = db();
  const qs: QuizSet = {
    _id: uid('qs'),
    materialId: 'm-test',
    folderId: 'f-test',
    sourceSetId: null,
    title: '테스트 퀴즈',
    status: 'ready',
    progress: 100,
    questionCount: answers.length,
    questions: answers.map((answer, i) => ({
      _id: uid('q'),
      order: i,
      type: 'short_answer',
      prompt: `문제 ${i + 1}`,
      choices: null,
      answer,
      explanation: null,
      conceptTags: [],
    })),
    createdAt: now(),
  };
  d.quizSets.unshift(qs);
  save();
  return qs;
};

/** 테스트용: 앱을 다시 켠 것처럼 메모리를 비우고 파일에서 다시 읽는다 */
export const resetLocalForTests = () => {
  accounts = readAccounts();
  loaded.clear();
  savedJson.clear();
};
