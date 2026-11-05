import {
  ERROR_CODES,
  type AiJob,
  type AiJobType,
  type CalendarShare,
  type DDay,
  type Material,
  type Message,
  type QuizAttempt,
  type QuizSet,
  type StudySession,
  type TimetableShare,
} from '@notelink/shared';
import { ApiError, NetworkError } from '../../lib/api/http';
import type { Api, MonthDay } from '../../lib/api/types';
import { addDays, daysBetween, parse, seoul, today, ymd } from '../../lib/dates';
import { localSocket } from '../../lib/socket';
import { useNet } from '@/stores/net';
import { useAuth } from '@/stores/auth';
import { useMockFlags } from './flags';
import * as S from './seed';
import { mockUploadSource } from './uploads';
import { roomTimerState } from './timer';

// 목업 백엔드. 실서버와 같은 Api 인터페이스를 구현하고, AI 작업 진행률은 소켓 이벤트로 흘려보낸다.

const db = {
  user: S.seedUser(),
  items: S.seedItems(),
  sessions: new Map<string, StudySession>(),
  weeklyGoal: {
    _id: 'wg1',
    weekStart: today(),
    targetMin: 21 * 60,
    notify80: true,
    recentAvgMin: 18 * 60 + 30,
  },
  timetableShares: [
    { _id: 'ts1', friendId: 'u-jiwoo', mode: 'full', sharedAt: new Date().toISOString() },
  ] as TimetableShare[],
  recurring: S.seedRecurring(),
  todos: S.seedTodos(),
  manualDdays: S.seedManualDdays(),
  hiddenHolidays: new Set<string>(['10-09']),
  customHolidays: [{ _id: 'ch1', name: '가족 여행일', date: ymd(addDays(seoul(), 9)) }],
  shares: S.seedShares(),
  classes: S.seedClasses(),
  friends: S.seedFriends(),
  requests: S.seedRequests(),
  messages: new Map<string, Message[]>(),
  folders: S.seedFolders(),
  materials: [] as Material[],
  jobs: new Map<string, AiJob>(),
  quizSets: [] as QuizSet[],
  attempts: new Map<string, QuizAttempt>(),
  flashcards: S.seedFlashcards(),
  quizBox: [...S.QUESTIONS],
  rooms: [] as ReturnType<typeof S.makeRoom>[],
  userItems: S.seedUserItems(),
  ledger: S.seedLedger(),
};

const endedSessions = new Map<string, { durationSec: number; pointsEarned: number }>();
const createdMaterials = new Map<
  string,
  { payload: string; result: { material: Material; job: AiJob } }
>();
const finishedAttempts = new Map<string, { pointsEarned: number; balance: number }>();

const timerStartedAt = new Map<string, number>();
const presetTimerStartedAt = Date.now();

let seq = 1;
const uid = (p: string) => `${p}-${Date.now().toString(36)}${seq++}`;
const now = () => new Date().toISOString();

/** 네트워크 지연과 연결 상태를 흉내 낸다 */
async function ok<T>(v: T, ms = 220): Promise<T> {
  await new Promise((r) => setTimeout(r, ms));
  if (useNet.getState().state === 'offline') throw new NetworkError('offline');
  return structuredClone(v);
}
const fail = (code: string, message: string, status = 400) =>
  Promise.reject(new ApiError(code, message, status));

/* ── AI 작업: queued → running(진행률) → succeeded | failed (p.20) ──── */

const STEPS: Partial<Record<AiJobType, string[]>> = {
  handwriting_summary: ['이미지 업로드 완료', '손글씨 인식 완료', '노트 정리 중', 'AI 요약 생성'],
  recording_summary: [
    '녹음 업로드 완료',
    '음성 인식 완료',
    '노트 정리 중',
    'AI 요약 · 아바타 생성',
  ],
  document_summary: ['문서 업로드 완료', '문서 읽기 완료', '핵심 요약 중', '키워드 추출'],
  quiz_generate: ['노트 분석', '문제 생성', '해설 작성', '검토'],
  avatar_profile: ['사진 분석', '스타일 적용', '프로필 생성', '마무리'],
};

const jobCompletions = new Map<string, (job: AiJob) => void>();

const markMaterialFailed = (id: string) => {
  const m = db.materials.find((x) => x._id === id);
  if (m) m.processing.status = 'failed';
};

function runJob(type: AiJobType, targetId: string, onDone: (job: AiJob) => void): AiJob {
  const flags = useMockFlags.getState();
  const job: AiJob = {
    _id: uid('job'),
    type,
    status: 'queued',
    targetType: 'material',
    targetId,
    progress: 0,
    attempts: 1,
    result: null,
    error: null,
    createdAt: now(),
    updatedAt: now(),
  };
  db.jobs.set(job._id, job);
  jobCompletions.set(job._id, onDone);
  const steps = STEPS[type] ?? ['노트 분석', '문제 생성', '해설 작성', '검토'];
  const total = flags.llmSlow ? 9000 : 3200;
  const started = Date.now();
  const tick = setInterval(() => {
    const j = db.jobs.get(job._id);
    if (!j || j.status === 'canceled') return clearInterval(tick);
    const p = Math.min(100, Math.round(((Date.now() - started) / total) * 100));
    const failAt = flags.llmFail
      ? 68
      : flags.aiCreditExhausted && type === 'quiz_generate'
        ? 60
        : 101;
    if (p >= failAt) {
      clearInterval(tick);
      markMaterialFailed(j.targetId);
      Object.assign(j, {
        status: 'failed',
        progress: failAt,
        error: flags.aiCreditExhausted ? ERROR_CODES.AI_CREDIT_EXHAUSTED : 'LLM_FAILED',
        updatedAt: now(),
      });
      localSocket.push('ai:progress', {
        jobId: j._id,
        status: 'failed',
        progress: failAt,
        step: steps[2],
      });
      localSocket.push('ai:done', { jobId: j._id, job: structuredClone(j) });
      return;
    }
    j.status = p >= 100 ? 'succeeded' : 'running';
    j.progress = p;
    j.step = steps[Math.min(3, Math.floor(p / 25))];
    if (flags.llmSlow) j.attempts = p < 40 ? 1 : p < 75 ? 2 : 3;
    localSocket.push('ai:progress', { jobId: j._id, status: j.status, progress: p, step: j.step });
    if (p >= 100) {
      clearInterval(tick);
      onDone(j);
      localSocket.push('ai:done', { jobId: j._id, job: structuredClone(j) });
    }
  }, 120);
  return job;
}

/* ── 계산 헬퍼 ──────────────────────────────────── */

const ddays = (): DDay[] =>
  [
    ...db.todos
      .filter((t) => t.isDday && !t.done)
      .map((t) => ({
        _id: t._id,
        title: t.content,
        date: t.dueDate,
        source: 'todo' as const,
        kind: t.todoType === 'exam' ? '시험' : '과제',
        daysLeft: daysBetween(today(), t.dueDate),
      })),
    ...db.manualDdays.map((d) => ({
      _id: d._id,
      title: d.title,
      date: d.date,
      source: 'manual' as const,
      kind: d.kind,
      daysLeft: daysBetween(today(), d.date),
    })),
  ].sort((a, b) => (a.daysLeft < 0 ? 1 : b.daysLeft < 0 ? -1 : a.daysLeft - b.daysLeft));

// 이번 달 공부량 (색 진하기) — 오늘 이전 2주를 진하게
const levelOf = (date: string) => {
  const d = daysBetween(date, today());
  if (d < 0 || d > 13) return 0;
  return d === 0 ? 4 : ([1, 1, 1, 3, 3, 2, 3, 2, 2, 2, 2, 1, 1, 1][d] ?? 0);
};

const HOLIDAYS = [
  ['01-01', '신정'],
  ['03-01', '삼일절'],
  ['05-05', '어린이날'],
  ['06-06', '현충일'],
  ['08-15', '광복절'],
  ['10-03', '개천절'],
  ['10-09', '한글날'],
  ['12-25', '성탄절'],
] as const;

export const mockApi: Api = {
  auth: {
    socialLogin: (_p, _token) =>
      ok({ accessToken: 'mock-access', refreshToken: 'mock-refresh', user: db.user }, 600),
    emailLogin: () =>
      ok({ accessToken: 'mock-access', refreshToken: 'mock-refresh', user: db.user }, 600),
    emailSignup: (email) =>
      email === db.user.email
        ? fail(ERROR_CODES.EMAIL_TAKEN, '이미 가입한 이메일이에요', 409)
        : ok(undefined, 700),
    agreeTerms: () => ok(undefined),
    logout: () => ok(undefined),
  },
  me: {
    get: () => {
      if (useMockFlags.getState().tokenExpired)
        return fail(ERROR_CODES.TOKEN_EXPIRED, '로그인이 만료됐어요', 401);
      return ok(db.user);
    },
    update: async (patch) => {
      await ok(undefined);

      Object.assign(db.user, { ...patch, settings: { ...db.user.settings, ...patch.settings } });
      return structuredClone(db.user);
    },
    setStatus: async (status) => {
      await ok(undefined);
      return structuredClone(void (db.user.status = status));
    },
    registerDevice: () => ok(undefined),
    changePlan: async (tier) => {
      await ok(undefined);

      db.user.subscription = { tier, status: 'active' };
      db.user.usage!.storageLimitBytes = { free: 2, pro: 50, max: 200 }[tier] * 1024 ** 3;
      return structuredClone(db.user);
    },
    withdraw: () => ok(undefined),
    generateProfile: async (p) => {
      await ok(undefined);
      return structuredClone(
        runJob('avatar_profile', p.photoBlobUrl, (job) => {
          // 목업은 입력 사진을 성공 결과로 재사용한다. 실제 AI 생성은 서버가 담당한다.
          const avatarUrl = mockUploadSource(p.photoBlobUrl);
          db.user.avatarUrl = avatarUrl;
          job.result = { avatarUrl };
        }),
      );
    },
    saveAvatar: async (p) => {
      await ok(undefined);

      const color = /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#8cbea3';
      const descriptor = encodeURIComponent(`${p.style}:${p.gender}:${p.color}`);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128"><desc>${descriptor}</desc><rect width="128" height="128" rx="64" fill="${color}"/><circle cx="64" cy="53" r="28" fill="#f5d3b3"/><path d="M24 128v-18a40 40 0 0 1 80 0v18" fill="#ffffff"/><circle cx="54" cy="52" r="3"/><circle cx="74" cy="52" r="3"/><path d="M55 67q9 8 18 0" fill="none" stroke="#76533d" stroke-width="3"/></svg>`;
      db.user.avatarUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      return structuredClone(undefined);
    },
  },
  upload: {
    getSas: (p) => {
      const blobUrl = `https://notelinkblob.blob.core.windows.net/uploads/${uid('blob')}-${encodeURIComponent(p.fileName)}`;
      return ok({
        uploadUrl: `${blobUrl}?sv=mock`,
        blobUrl,
        expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
        headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': p.contentType },
      });
    },
  },
  study: {
    today: () =>
      ok({
        _id: 'dr',
        studyDate: today(),
        totalSec: db.items.reduce((a, i) => a + i.accumulatedSec, 0),
        personalSec: 0,
        roomSec: 0,
        streakOk: true,
        items: db.items,
      }),
    addItem: async (p) => {
      await ok(undefined);

      const it = {
        _id: uid('item'),
        title: p.title,
        subjectId: S.subjects.find((s) => s.name === p.subjectName)?._id ?? null,
        subjectName: p.subjectName,
        goalMin: p.goalMin,
        accumulatedSec: 0,
      };
      db.items.push(it);
      return structuredClone(it);
    },
    startSession: async (p) => {
      await ok(undefined, 80);

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
      db.sessions.set(s._id, s);
      return structuredClone(s);
    },
    pauseSession: async (id) => {
      await ok(undefined, 60);
      return structuredClone(
        void db.sessions
          .get(id)
          ?.pauses.push({ startedAt: now(), endedAt: null, reason: 'manual' }),
      );
    },
    resumeSession: async (id) => {
      await ok(undefined, 60);

      const p = db.sessions.get(id)?.pauses.at(-1);
      if (p) p.endedAt = now();
      return structuredClone(undefined);
    },
    endSession: async (id, p) => {
      await ok(undefined);
      const previous = endedSessions.get(id);
      if (previous) return structuredClone(previous);
      const s = db.sessions.get(id);
      if (!s) throw new ApiError(ERROR_CODES.NOT_FOUND, '세션을 찾을 수 없어요', 404);
      // 실서버와 같이 서버 쪽 기록(시작 · 일시정지 시각)으로 시간을 계산한다
      const paused = (s?.pauses ?? []).reduce(
        (a, x) => a + ((x.endedAt ? Date.parse(x.endedAt) : Date.now()) - Date.parse(x.startedAt)),
        0,
      );
      const durationSec = s
        ? Math.max(0, Math.floor((Date.now() - Date.parse(s.startedAt) - paused) / 1000))
        : 0;
      if (s)
        Object.assign(s, { status: 'ended', endedAt: now(), durationSec, endReason: p.endReason });
      const it = db.items.find((i) => i._id === s?.studyItemId);
      if (it) it.accumulatedSec += durationSec;
      const pts = durationSec >= 600 ? 30 : 0;
      if (pts) {
        db.user.pointBalance += pts;
        db.ledger.unshift({
          _id: uid('pl'),
          amount: pts,
          balanceAfter: db.user.pointBalance,
          reasonType: 'session_complete',
          description: '순공 세션 완료',
          createdAt: now(),
        });
      }
      const result = { durationSec, pointsEarned: pts };
      endedSessions.set(id, result);
      return structuredClone(result);
    },
    weekly: () =>
      ok({
        weekStart: today(),
        totalSec: 14 * 3600 + 22 * 60,
        diffFromLastWeekSec: 100 * 60,
        goalMin: db.weeklyGoal.targetMin,
        days: [],
      }),
    month: (ym) => {
      const [y = 2026, m = 1] = ym.split('-').map(Number);
      const n = new Date(y, m, 0).getDate();
      const todoDays = new Set(db.todos.map((t) => t.dueDate));
      return ok(
        Array.from({ length: n }, (_, i): MonthDay => {
          const d = ymd(new Date(y, m - 1, i + 1));
          return { studyDate: d, level: levelOf(d), hasTodo: todoDays.has(d) };
        }),
      );
    },
    stats: (range) =>
      ok({
        totalSec: { all: 166, '90d': 121, '30d': 48 }[range] * 3600,
        studyDays: { all: 97, '90d': 71, '30d': 24 }[range],
        longestStreak: 12,
        peakHour: 21,
        heatmap: Array.from({ length: 126 }, (_, i) => ({
          studyDate: ymd(addDays(seoul(), i - 125)),
          level:
            (i * 37 + (i % 5) * 11) % 9 > 6
              ? 3
              : (i * 37 + (i % 5) * 11) % 9 > 4
                ? 2
                : (i * 37 + (i % 5) * 11) % 9 > 2
                  ? 1
                  : 0,
        })),
      }),
    weeklyGoal: () => ok(db.weeklyGoal),
    setWeeklyGoal: async (p) => {
      await ok(undefined);
      return structuredClone(Object.assign(db.weeklyGoal, p));
    },
    recurringGoals: () => ok(db.recurring),
    saveRecurringGoal: async (g) => {
      await ok(undefined);

      const cur = db.recurring.find((x) => x._id === g._id);
      if (cur) return structuredClone(Object.assign(cur, g));
      const n = {
        days: [],
        targetMin: 30,
        subjectId: null,
        remindEnabled: false,
        remindTime: null,
        pausedUntil: null,
        streak: 0,
        isActive: true,
        ...g,
        _id: uid('rg'),
      };
      db.recurring.push(n);
      return structuredClone(n);
    },
    deleteRecurringGoal: async (id) => {
      await ok(undefined);
      return structuredClone(void (db.recurring = db.recurring.filter((g) => g._id !== id)));
    },
    subjects: () => ok(S.subjects),
  },
  calendar: {
    todos: (date) => ok(db.todos.filter((t) => t.dueDate === date && !t.isDday)),
    addTodo: async (p) => {
      await ok(undefined);

      const t = {
        _id: uid('todo'),
        dueDate: p.dueDate,
        content: p.content,
        todoType: p.todoType,
        isDday: p.todoType !== 'general',
        timeSlot: p.timeSlot,
        dueTime: p.dueTime ?? null,
        subjectId: null,
        subjectName: p.subjectName ?? undefined,
        done: false,
        doneAt: null,
        createdAt: now(),
      };
      db.todos.push(t);
      if (t.isDday) db.todos.push({ ...t, _id: uid('todo'), isDday: false });
      return structuredClone(t);
    },
    toggleTodo: async (id, done) => {
      await ok(undefined);
      return structuredClone(
        void Object.assign(db.todos.find((t) => t._id === id) ?? {}, {
          done,
          doneAt: done ? now() : null,
        }),
      );
    },
    ddays: () => ok(ddays()),
    addDday: async (p) => {
      await ok(undefined);

      const d = { _id: uid('dd'), title: p.title, date: p.date, kind: '목표일' };
      db.manualDdays.push(d);
      return structuredClone({
        ...d,
        source: 'manual' as const,
        daysLeft: daysBetween(today(), p.date),
      });
    },
    holidays: (year) =>
      ok(
        HOLIDAYS.map(([md, name]) => ({
          _id: `${year}-${md}`,
          name,
          hidden: db.hiddenHolidays.has(md),
        })),
      ),
    setHolidayHidden: async (date, hidden) => {
      await ok(undefined, 60);

      const md = date.slice(5);
      if (hidden) db.hiddenHolidays.add(md);
      else db.hiddenHolidays.delete(md);
      return structuredClone(undefined);
    },
    customHolidays: () => ok(db.customHolidays),
    addCustomHoliday: async (p) => {
      await ok(undefined);
      return structuredClone(void db.customHolidays.push({ _id: uid('ch'), ...p }));
    },
    removeCustomHoliday: async (id) => {
      await ok(undefined);
      return structuredClone(
        void (db.customHolidays = db.customHolidays.filter((h) => h._id !== id)),
      );
    },
    shares: () => ok(db.shares.filter((s) => !s.revokedAt)),
    createShare: async (p) => {
      await ok(undefined);

      const s: CalendarShare = {
        _id: uid('cs'),
        token: Math.random().toString(16).slice(2, 8),
        ownerId: 'u-me',
        rangeStart: p.rangeStart,
        rangeEnd: p.rangeEnd,
        scopes: ['todos', 'study'],
        expiresAt: p.expiresInDays ? addDays(new Date(), p.expiresInDays).toISOString() : null,
        revokedAt: null,
        createdAt: now(),
        subscribers: [],
      };
      db.shares.unshift(s);
      return structuredClone({ ...s, url: `notelink.app/share/${s.token}` });
    },
    revokeShare: async (id) => {
      await ok(undefined);
      return structuredClone(
        void Object.assign(db.shares.find((s) => s._id === id) ?? {}, { revokedAt: now() }),
      );
    },
    received: () => {
      const start = new Date();
      start.setDate(1);
      const base = S.seedShares()[0];
      if (!base) return ok([]);
      return ok([
        {
          ...base,
          _id: 'rcv1',
          ownerId: 'u-sujin',
          ownerNickname: '수진',
          days: [3, 8, 12, 15, 19, 22, 26].map((d) =>
            ymd(new Date(start.getFullYear(), start.getMonth(), d)),
          ),
        },
      ]);
    },
    subscribe: () => ok(undefined),
  },
  timetable: {
    get: () => ok({ _id: 'tt', updatedAt: now(), classes: db.classes }),
    addClass: async (c) => {
      await ok(undefined);

      const k = { ...c, _id: uid('cls'), source: 'manual' };
      db.classes.push(k);
      return structuredClone(k);
    },
    removeClass: async (id) => {
      await ok(undefined);
      return structuredClone(void (db.classes = db.classes.filter((c) => c._id !== id)));
    },
    share: async (p) => {
      await ok(undefined);

      for (const friendId of p.friendIds) {
        const existing = db.timetableShares.find((x) => x.friendId === friendId);
        if (existing) Object.assign(existing, { mode: p.mode, sharedAt: now() });
        else db.timetableShares.push({ _id: uid('ts'), friendId, mode: p.mode, sharedAt: now() });
      }
      return structuredClone(undefined);
    },
    shares: () => ok(db.timetableShares),
  },
  social: {
    friends: () => ok(db.friends),
    search: (q) => ok(S.searchable.filter((f) => q.trim() && f.nickname === q.trim())),
    sendRequest: () => ok(undefined),
    received: () => ok(db.requests),
    respond: async (id, accept) => {
      await ok(undefined);

      const r = db.requests.find((x) => x._id === id);
      db.requests = db.requests.filter((x) => x._id !== id);
      if (accept && r) db.friends.push({ ...r.requester, _id: uid('fr') });
      return structuredClone(undefined);
    },
    remove: async (userId) => {
      await ok(undefined);
      db.friends = db.friends.filter((f) => f.userId !== userId);
      // 빈 방을 남겨 재입장 때 초기 예시 대화가 다시 생성되지 않게 한다.
      db.messages.set(`dm-${userId}`, []);
      db.timetableShares = db.timetableShares.filter((share) => share.friendId !== userId);
    },
    openDirect: async (userId) => {
      await ok(undefined);

      const id = `dm-${userId}`;
      if (!db.messages.has(id)) db.messages.set(id, userId === 'u-jiwoo' ? S.seedDm(id) : []);
      return structuredClone({
        _id: id,
        type: 'direct',
        studyRoomId: null,
        lastMessage: null,
        members: [],
        updatedAt: now(),
      });
    },
    messages: (id) => ok(db.messages.get(id) ?? []),
  },
  content: {
    folders: () =>
      ok(
        db.folders.map((f) => ({
          ...f,
          materialCount: db.materials.filter(
            (m) =>
              m.folderId === f._id &&
              (m.processing.status === 'done' ||
                (m as Material & { saved?: boolean }).saved === true),
          ).length,
        })),
      ),
    createFolder: async (p) => {
      await ok(undefined);

      const f = {
        _id: uid('fo'),
        title: p.title,
        subjectId: S.subjects.find((s) => s.name === p.subjectName)?._id ?? 's-etc',
        subjectName: p.subjectName,
        createdAt: now(),
        updatedAt: now(),
      };
      db.folders.push(f);
      return structuredClone(f);
    },
    deleteFolder: async (id) => {
      await ok(undefined);
      return structuredClone(void (db.folders = db.folders.filter((f) => f._id !== id)));
    },
    materials: (folderId) =>
      ok(
        db.materials.filter(
          (m) =>
            m.folderId === folderId &&
            (m.processing.status === 'done' ||
              (m as Material & { saved?: boolean }).saved === true) &&
            (m as Material & { saved?: boolean }).saved !== false,
        ),
      ),
    createMaterial: async (p) => {
      const { requestId, ...payload } = p;
      const key = requestId ? `${useAuth.getState().userId}:${requestId}` : null;
      const fingerprint = JSON.stringify(payload);
      await ok(undefined);
      const previous = key ? createdMaterials.get(key) : undefined;
      if (previous) {
        if (previous.payload !== fingerprint)
          throw new ApiError(
            'IDEMPOTENCY_CONFLICT',
            '같은 등록 키에 다른 자료를 보낼 수 없어요',
            409,
          );
        return structuredClone(previous.result);
      }
      if (useMockFlags.getState().uploadPause)
        return Promise.reject(new NetworkError('upload paused'));
      const m = S.makeMaterial(p.folderId, p.kind, {
        title: p.title,
        source: p.source,
        description: p.description ?? null,
        processing: { status: 'queued', progress: 0, jobId: null },
      });
      (m as Material & { saved?: boolean }).saved = false;
      db.materials.push(m);
      const type = (
        {
          handwriting: 'handwriting_summary',
          recording: 'recording_summary',
          document: 'document_summary',
        } as const
      )[p.kind];
      const job = runJob(
        type,
        m._id,
        () => (m.processing = { status: 'done', progress: 100, jobId: null }),
      );
      m.processing.jobId = job._id;
      const result = { material: m, job };
      if (key) createdMaterials.set(key, { payload: fingerprint, result });
      return structuredClone(result);
    },
    material: (id) => {
      const m = db.materials.find((x) => x._id === id);
      return m ? ok(m) : fail(ERROR_CODES.NOT_FOUND, '자료를 찾을 수 없어요', 404);
    },
    saveMaterial: async (id) => {
      await ok(undefined);
      return structuredClone(
        void Object.assign(db.materials.find((m) => m._id === id) ?? {}, { saved: true }),
      );
    },
    updateSummary: async (id, sections) => {
      await ok(undefined);

      const m = db.materials.find((x) => x._id === id)!;
      m.summary = { sections, points: m.summary?.points ?? [] };
      return structuredClone(m);
    },
    deleteMaterial: async (id) => {
      await ok(undefined, 1400);
      return structuredClone(void (db.materials = db.materials.filter((m) => m._id !== id)));
    },
    recording: (id) => ok(S.RECORDING(id)),
    addBookmark: async (id, atSec) => {
      await ok(undefined, 60);
      return structuredClone(
        void db.materials.find((m) => m._id === id)?.bookmarks.push({ atSec }),
      );
    },
    downloadUrl: (id) =>
      ok({
        url: 'https://notelinkblob.blob.core.windows.net/uploads/sample.pdf',
        fileName: db.materials.find((m) => m._id === id)?.title ?? '연습문제.pdf',
      }),
    share: () => ok(undefined),
    checkImages: (files) =>
      ok(
        files.map((f) => ({
          name: f.name,
          verdict: /풍경|셀카|landscape/i.test(f.name)
            ? 'not_handwriting'
            : /단어장|blur/i.test(f.name)
              ? 'blurry'
              : 'ok',
        })),
        700,
      ),
  },
  ai: {
    job: (id) => {
      const j = db.jobs.get(id);
      return j ? ok(j) : fail(ERROR_CODES.NOT_FOUND, '작업을 찾을 수 없어요', 404);
    },
    cancel: async (id) => {
      await ok(undefined);
      const job = db.jobs.get(id);
      if (job && job.status !== 'succeeded') markMaterialFailed(job.targetId);
      return structuredClone(void Object.assign(job ?? {}, { status: 'canceled' }));
    },
    retry: async (id) => {
      await ok(undefined);
      const old = db.jobs.get(id);
      const complete = jobCompletions.get(id);
      if (!old || !complete) return fail(ERROR_CODES.NOT_FOUND, '작업을 찾을 수 없어요', 404);
      useMockFlags.setState({ llmFail: false, llmSlow: false });
      return structuredClone(runJob(old.type, old.targetId, complete));
    },
  },
  quiz: {
    sets: () => ok(db.quizSets),
    createSet: async (materialId) => {
      await ok(undefined);

      const qs = {
        ...S.makeQuizSet(materialId, materialId),
        status: 'generating' as const,
        progress: 0,
      };
      db.quizSets.unshift(qs);
      const job = runJob('quiz_generate', qs._id, () =>
        Object.assign(qs, { status: 'ready', progress: 100 }),
      );
      return structuredClone({ quizSet: qs, job });
    },
    set: (id) => ok(db.quizSets.find((q) => q._id === id) ?? S.makeQuizSet('m', '이차방정식 풀이')),
    startAttempt: async (quizSetId) => {
      await ok(undefined);

      const a: QuizAttempt = {
        _id: uid('att'),
        quizSetId,
        correctCount: 0,
        total: S.QUESTIONS.length,
        pointsEarned: 0,
        answers: [],
        startedAt: now(),
        finishedAt: null,
      };
      db.attempts.set(a._id, a);
      return structuredClone(a);
    },
    answer: async (attemptId, questionId, answer) => {
      await ok(undefined, 120);

      if (useMockFlags.getState().tokenExpired)
        return fail(ERROR_CODES.TOKEN_EXPIRED, '로그인이 만료됐어요', 401);
      const q = S.QUESTIONS.find((x) => x._id === questionId)!;
      const correct = q.answer === answer;
      const a = db.attempts.get(attemptId);
      if (a) {
        a.answers = [
          ...a.answers.filter((x) => x.questionId !== questionId),
          { questionId, answer, correct, tries: 1 },
        ];
        a.correctCount = a.answers.filter((x) => x.correct).length;
      }
      return structuredClone({ correct, correctAnswer: q.answer });
    },
    finish: async (attemptId) => {
      await ok(undefined);
      const previous = finishedAttempts.get(attemptId);
      if (previous) return structuredClone(previous);
      if (!db.attempts.has(attemptId))
        throw new ApiError(ERROR_CODES.NOT_FOUND, '풀이를 찾을 수 없어요', 404);
      const pts = 120;
      db.user.pointBalance += pts;
      db.ledger.unshift({
        _id: uid('pl'),
        amount: pts,
        balanceAfter: db.user.pointBalance,
        reasonType: 'quiz_correct',
        description: '퀴즈 정답 5개',
        createdAt: now(),
      });
      const a = db.attempts.get(attemptId);
      if (a) Object.assign(a, { finishedAt: now(), pointsEarned: pts });
      const result = { pointsEarned: pts, balance: db.user.pointBalance };
      finishedAttempts.set(attemptId, result);
      return structuredClone(result);
    },
    explanation: (qid) =>
      ok(
        {
          text:
            qid === 'q3'
              ? S.EXPLAIN_Q3
              : `정답은 ${S.QUESTIONS.find((q) => q._id === qid)?.answer} 이에요.\n노트의 핵심 개념을 다시 짚어 보면, 이 문제는 정의를 그대로 적용하면 풀 수 있어요.\n헷갈렸다면 유사 퀴즈로 한 번 더 연습해 보세요.`,
        },
        600,
      ),
    similar: (id) =>
      ok(
        {
          ...S.makeQuizSet('m', '유사 퀴즈'),
          sourceSetId: id,
          questions: S.SIMILAR,
          questionCount: 3,
        },
        900,
      ),
    box: () => ok(db.quizBox),
    saveToBox: async (questionIds) => {
      await ok(undefined);
      const questions = [
        ...S.QUESTIONS,
        ...S.SIMILAR,
        ...db.quizSets.flatMap((set) => set.questions),
      ];
      const selected = [...new Set(questionIds)].map((id) => questions.find((q) => q._id === id));
      if (selected.some((q) => !q))
        throw new ApiError(ERROR_CODES.NOT_FOUND, '보관할 문제를 찾을 수 없어요', 404);
      for (const q of selected) {
        if (q && !db.quizBox.some((item) => item._id === q._id)) db.quizBox.push(q);
      }
      return structuredClone(db.quizBox);
    },
    deleteFromBox: async (questionIds) => {
      await ok(undefined);
      db.quizBox = db.quizBox.filter((q) => !questionIds.includes(q._id));
    },
    flashcards: () => ok(db.flashcards),
    saveFlashcard: async (p) => {
      await ok(undefined);
      const f = {
        _id: uid('fc'),
        materialId: null,
        folderId: 'fo1',
        front: p.front,
        back: p.back,
        sourceQuizSetId: null,
        sourceQuestionId: p.sourceQuestionId ?? null,
        lastResult: null,
        createdAt: now(),
      };
      db.flashcards.push(f);
      return structuredClone(f);
    },
    deleteFlashcards: async (ids) => {
      await ok(undefined);
      return structuredClone(
        void (db.flashcards = db.flashcards.filter((f) => !ids.includes(f._id))),
      );
    },
  },
  rooms: {
    recommended: () => ok(S.RECOMMENDED),
    mine: () => ok(db.rooms),
    create: async (p) => {
      await ok(undefined);

      const r = S.makeRoom({
        _id: uid('room'),
        title: p.title,
        categoryName: p.categoryName,
        isPublic: p.isPublic,
        inviteCode: Math.random().toString(36).slice(2, 8).toUpperCase(),
        hostId: 'u-me',
        memberCount: 1,
        members: S.ROOM_MEMBERS.filter((m) => m.userId === 'u-me'),
      });
      db.rooms.push(r);
      return structuredClone(r);
    },
    join: async (code) => {
      await ok(undefined);

      if (code.length !== 6)
        return fail(ERROR_CODES.ROOM_CODE_INVALID, '코드를 다시 확인해 주세요');
      const r =
        S.RECOMMENDED.find((x) => x.inviteCode === code) ?? S.makeRoom({ inviteCode: code });
      if (!db.rooms.some((x) => x._id === r._id)) db.rooms.push(r);
      return structuredClone(r);
    },
    get: (id) => {
      const room =
        db.rooms.find((r) => r._id === id) ??
        S.RECOMMENDED.find((r) => r._id === id) ??
        S.makeRoom({ _id: id });
      return ok({
        ...room,
        timerState: roomTimerState(room.timerRule, timerStartedAt.get(id) ?? presetTimerStartedAt),
      });
    },
    leave: async (id) => {
      await ok(undefined);
      return structuredClone(void (db.rooms = db.rooms.filter((r) => r._id !== id)));
    },
    setTimer: async (id, rule) => {
      await ok(undefined);

      let room = db.rooms.find((r) => r._id === id);
      if (!room) {
        room = structuredClone(S.RECOMMENDED.find((r) => r._id === id) ?? S.makeRoom({ _id: id }));
        db.rooms.push(room);
      }
      room.timerRule = rule;
      timerStartedAt.set(id, Date.now());
      room.timerState = roomTimerState(rule, timerStartedAt.get(id)!);
      localSocket.push('room:timer', {
        roomId: id,
        rule,
        phase: room.timerState?.phase ?? 'focus',
        endsAt: room.timerState?.endsAt ?? null,
      });
      return structuredClone(room);
    },
    schedule: () =>
      ok({
        members: [
          { nickname: '나 (형욱)', emoji: '✏️' },
          { nickname: '지우', emoji: '⚡' },
          { nickname: '수민', emoji: '📖' },
          { nickname: '재민', emoji: '💡' },
        ],
        startHour: 16,
        grid: [
          [1, 0, 1, 1, 0, 0, 0],
          [1, 1, 1, 1, 1, 0, 0],
          [0, 2, 1, 2, 1, 1, 0],
          [1, 2, 0, 2, 1, 1, 1],
          [1, 2, 1, 0, 0, 1, 1],
          [0, 1, 1, 1, 1, 0, 0],
          [0, 0, 0, 1, 1, 0, 0],
        ],
        matches: [
          { day: '화요일', label: '화요일 (Tue)', start: '18:00', end: '21:00', best: true },
          { day: '목요일', label: '목요일 (Thu)', start: '18:00', end: '20:00' },
        ],
      }),
    invite: () => ok(undefined),
    shared: (id) =>
      ok({
        items: [
          {
            _id: 'rs1',
            roomId: id,
            sharedBy: 'u-sumin',
            sharedByNickname: '수민',
            itemType: 'flashcards' as const,
            quizSetId: null,
            folderId: null,
            materialId: null,
            questionIds: [],
            flashcardIds: db.flashcards.map((c) => c._id),
            title: '플래시 카드',
            createdAt: now(),
          },
        ],
        flashcards: db.flashcards,
      }),
    livekitToken: () => ok({ token: 'mock-livekit-token', url: 'wss://notelink.livekit.cloud' }),
    report: () => ok(undefined, 500),
    chatRoomId: async (id) => {
      const cid = `room-chat-${id}`;
      if (!db.messages.has(cid)) db.messages.set(cid, S.seedRoomChat(cid));
      return ok(cid);
    },
  },
  shop: {
    items: (p) => {
      let list = S.SHOP.filter((i) => !p.category || i.category === p.category);
      if (p.sort === 'price') list = [...list].sort((a, b) => a.price - b.price);
      if (p.sort === 'popular') list = [...list].sort((a, b) => b.purchaseCount - a.purchaseCount);
      return ok(list);
    },
    myItems: () => ok(db.userItems),
    wish: async (itemId) => {
      await ok(undefined, 60);

      const item = S.SHOP.find((i) => i._id === itemId);
      if (!item) return fail(ERROR_CODES.NOT_FOUND, '상품을 찾을 수 없어요');
      let ui = db.userItems.find((u) => u.itemId === itemId);
      if (!ui)
        db.userItems.push(
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
      ui.itemCategory = item.category;
      ui.isWished = !ui.isWished;
      return structuredClone(ui.isWished);
    },
    purchase: async (itemId) => {
      await ok(undefined, 500);

      if (useMockFlags.getState().purchaseFail)
        return Promise.reject(new NetworkError('purchase interrupted'));
      const item = S.SHOP.find((i) => i._id === itemId);
      if (!item) return fail(ERROR_CODES.NOT_FOUND, '상품을 찾을 수 없어요');
      const existing = db.userItems.find((u) => u.itemId === itemId);
      if (existing) existing.itemCategory = item.category;
      if (existing?.isOwned) return structuredClone({ balance: db.user.pointBalance });
      if (db.user.pointBalance < item.price)
        return fail(ERROR_CODES.POINTS_INSUFFICIENT, '포인트가 부족해요');
      db.user.pointBalance -= item.price;
      let ui = db.userItems.find((u) => u.itemId === itemId);
      if (!ui)
        db.userItems.push(
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
      Object.assign(ui, { isOwned: true, itemCategory: item.category, acquiredAt: now() });
      db.ledger.unshift({
        _id: uid('pl'),
        amount: -item.price,
        balanceAfter: db.user.pointBalance,
        reasonType: 'purchase',
        description: `${item.name} 구매`,
        createdAt: now(),
      });
      return structuredClone({ balance: db.user.pointBalance });
    },
    equip: async (itemId) => {
      await ok(undefined);

      const selected = db.userItems.find((u) => u.itemId === itemId && u.isOwned);
      if (!selected) return fail(ERROR_CODES.NOT_FOUND, '보유한 아이템이 아니에요');
      db.userItems.forEach((u) => {
        if (u.itemCategory === selected.itemCategory) u.isEquipped = u.itemId === itemId;
      });
      return structuredClone(undefined);
    },
    ledger: (type) =>
      ok(db.ledger.filter((l) => !type || (type === 'earn' ? l.amount > 0 : l.amount < 0))),
  },
};

/** 채팅 전송을 목업 서버가 받아 되돌려준다 */
localSocket.onClient = (ev, args) => {
  if (ev !== 'chat:send') return;
  const [p, ack] = args as [
    { chatRoomId: string; text: string; clientId: string },
    ((m: Message) => void) | undefined,
  ];
  const m: Message = {
    _id: uid('msg'),
    chatRoomId: p.chatRoomId,
    senderId: 'u-me',
    senderNickname: '최형욱',
    type: 'text',
    text: p.text,
    sharedItemId: null,
    createdAt: now(),
    clientId: p.clientId,
  };
  db.messages.set(p.chatRoomId, [...(db.messages.get(p.chatRoomId) ?? []), m]);
  setTimeout(() => (ack ? ack(m) : localSocket.push('chat:message', m)), 120);
};

/** 데모용: 홈 화면에서 측정 중 상태를 바로 보여줄 때 */
export const mockDemo = {
  seedStudyItems: () => (db.items = structuredClone(S.DEMO_ITEMS)),
  seedFolder: () => {
    if (!db.folders.length) db.folders.push(S.DEMO_FOLDER);
    if (!db.materials.length)
      db.materials.push(
        ...(['recording', 'handwriting', 'document'] as const).map((k) => S.makeMaterial('fo1', k)),
      );
  },
  parse,
};
