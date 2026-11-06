import type {
  CalendarShare,
  Flashcard,
  Folder,
  Friend,
  FriendRequest,
  Material,
  Message,
  PointLedger,
  Question,
  QuizSet,
  RecurringGoal,
  Recording,
  ShopItem,
  StudyItem,
  StudyRoom,
  Subject,
  TimetableClass,
  Todo,
  User,
  UserItem,
} from '@notelink/shared';
import { addDays, seoul, today, ymd } from '../../lib/dates';

// 발표 자료 화면에 나온 데이터를 그대로 옮긴 목업 DB. 날짜는 실행하는 날 기준으로 맞춘다.

const now = () => new Date().toISOString();
const ago = (h: number) => new Date(Date.now() - h * 3600000).toISOString();
const day = (n: number) => ymd(addDays(seoul(), n));

export const seedUser = (): User => ({
  _id: 'u-me',
  email: 'hwa2367@gmail.com',
  nickname: '최형욱',
  role: 'user',
  learnerType: 'middle_high',
  pointBalance: 1240,
  status: 'active',
  interestCategoryIds: ['c-suneung'],
  school: '선문고등학교',
  grade: '3학년',
  phone: '010-1234-5678',
  streakDays: 12,
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
  usage: { storageBytes: 0, storageLimitBytes: 2 * 1024 ** 3, aiCredits: 0, aiCreditLimit: 800 },
  createdAt: ago(24 * 90),
});

export const subjects: Subject[] = [
  { _id: 's-math', categoryId: null, name: '수학', color: '#3b6e5b', sortOrder: 0, isActive: true },
  { _id: 's-eng', categoryId: null, name: '영어', color: '#c9b98f', sortOrder: 1, isActive: true },
  { _id: 's-sci', categoryId: null, name: '과학', color: '#c9b98f', sortOrder: 2, isActive: true },
  { _id: 's-kor', categoryId: null, name: '국어', color: '#c9b98f', sortOrder: 3, isActive: true },
  { _id: 's-chem', categoryId: null, name: '화학', color: '#c9b98f', sortOrder: 4, isActive: true },
];

export const seedItems = (): StudyItem[] => [];

export const DEMO_ITEMS: StudyItem[] = [
  {
    _id: 'i1',
    title: '이차방정식 풀이',
    subjectId: 's-math',
    subjectName: '수학',
    goalMin: 60,
    accumulatedSec: 52 * 60 + 10,
  },
  {
    _id: 'i2',
    title: '가정법 정리',
    subjectId: 's-eng',
    subjectName: '영어',
    goalMin: 40,
    accumulatedSec: 48 * 60 + 27,
  },
  {
    _id: 'i3',
    title: '유전자 이론',
    subjectId: 's-sci',
    subjectName: '과학',
    goalMin: 30,
    accumulatedSec: 34 * 60,
  },
];

export const seedTodos = (): Todo[] => [
  {
    _id: 't1',
    dueDate: today(),
    content: '이온화 에너지 녹음 업로드',
    todoType: 'general',
    isDday: false,
    timeSlot: 'am',
    dueTime: '10:00',
    subjectId: 's-chem',
    subjectName: '화학',
    done: true,
    doneAt: ago(2),
    createdAt: ago(30),
  },
  {
    _id: 't2',
    dueDate: today(),
    content: '화학 스터디',
    todoType: 'general',
    isDday: false,
    timeSlot: 'pm',
    dueTime: '20:00',
    subjectId: null,
    subjectName: '스터디룸',
    done: false,
    doneAt: null,
    createdAt: ago(30),
  },
  {
    _id: 't3',
    dueDate: today(),
    content: '수학 오답노트 정리',
    todoType: 'general',
    isDday: false,
    timeSlot: 'none',
    dueTime: null,
    subjectId: 's-math',
    subjectName: '수학',
    done: false,
    doneAt: null,
    createdAt: ago(30),
  },
  {
    _id: 't4',
    dueDate: day(3),
    content: '9월 모의고사',
    todoType: 'exam',
    isDday: true,
    timeSlot: 'none',
    dueTime: null,
    subjectId: null,
    done: false,
    doneAt: null,
    createdAt: ago(200),
  },
  {
    _id: 't5',
    dueDate: day(7),
    content: '수학 워크북 3단원 제출',
    todoType: 'assignment',
    isDday: true,
    timeSlot: 'none',
    dueTime: null,
    subjectId: 's-math',
    subjectName: '수학',
    done: false,
    doneAt: null,
    createdAt: ago(100),
  },
];

export const seedManualDdays = () => [
  { _id: 'd3', title: '수능', date: day(56), kind: '목표일' },
  { _id: 'd4', title: '중간고사', date: day(16), kind: '목표일' },
  { _id: 'd5', title: '스터디 시작일', date: day(-55), kind: '목표일' },
];

export const seedRecurring = (): RecurringGoal[] => [
  {
    _id: 'g1',
    name: '매일 30분 영어 단어 암기',
    days: [1, 2, 3, 4, 5],
    targetMin: 30,
    subjectId: 's-eng',
    remindEnabled: true,
    remindTime: '20:00',
    pausedUntil: null,
    streak: 12,
    isActive: true,
  },
];

export const seedFriends = (): Friend[] => [
  { _id: 'fr1', userId: 'u-jiwoo', nickname: '지우', status: 'active' },
  { _id: 'fr2', userId: 'u-sumin', nickname: '수민', status: 'resting' },
  { _id: 'fr3', userId: 'u-haeun', nickname: '하은', status: 'offline' },
];

export const seedRequests = (): FriendRequest[] => [
  {
    _id: 'rq1',
    requester: {
      _id: 'x1',
      userId: 'u-seoyeon',
      nickname: '서연',
      handle: '@seoyeon',
      status: 'active',
    },
    requestedAt: ago(24),
  },
  {
    _id: 'rq2',
    requester: {
      _id: 'x2',
      userId: 'u-doyun',
      nickname: '도윤',
      handle: '@doyun',
      status: 'active',
    },
    requestedAt: ago(72),
  },
];

export const searchable: Friend[] = [
  {
    _id: 'x3',
    userId: 'u-hong',
    nickname: '홍길동',
    handle: '@hong_gd',
    status: 'active',
    mutualCount: 2,
  },
];

export const seedDm = (chatRoomId: string): Message[] => [
  {
    _id: 'm1',
    chatRoomId,
    senderId: 'u-jiwoo',
    type: 'text',
    text: '오늘 스터디룸에서 같이 공부할래?',
    sharedItemId: null,
    createdAt: ago(1),
  },
  {
    _id: 'm2',
    chatRoomId,
    senderId: 'u-me',
    type: 'text',
    text: '좋아! 8시에 들어갈게',
    sharedItemId: null,
    createdAt: ago(0.9),
  },
  {
    _id: 'm3',
    chatRoomId,
    senderId: 'u-jiwoo',
    type: 'text',
    text: 'ㅇㅋ 이따 봐 ㅎㅎ',
    sharedItemId: null,
    createdAt: ago(0.8),
  },
];

export const seedRoomChat = (chatRoomId: string): Message[] => [
  {
    _id: 'rm1',
    chatRoomId,
    senderId: 'u-sumin',
    senderNickname: '수민',
    type: 'text',
    text: '다들 얼마정도 푸셨나요?',
    sharedItemId: null,
    createdAt: ago(0.5),
  },
  {
    _id: 'rm2',
    chatRoomId,
    senderId: 'u-me',
    senderNickname: '최형욱',
    type: 'text',
    text: '저는 10 문제 풀었습니다!',
    sharedItemId: null,
    createdAt: ago(0.4),
  },
  {
    _id: 'rm3',
    chatRoomId,
    senderId: 'u-sumin',
    senderNickname: '수민',
    type: 'text',
    text: '다들 무슨 과목 공부 중이에요? 저는 수학 이차 방정식 푸는 중이에요',
    sharedItemId: null,
    createdAt: ago(0.3),
  },
];

export const seedClasses = (): TimetableClass[] => [
  {
    _id: 'k1',
    subjectName: '국어',
    days: [1, 3, 5],
    startTime: '09:00',
    endTime: '10:00',
    location: '',
    color: '#dfece4',
    source: 'manual',
  },
  {
    _id: 'k2',
    subjectName: '수학 II',
    days: [2, 4],
    startTime: '10:00',
    endTime: '11:30',
    location: '3-2 교실',
    color: '#e3e8f4',
    source: 'manual',
  },
  {
    _id: 'k3',
    subjectName: '영어 독해',
    days: [1],
    startTime: '13:00',
    endTime: '14:00',
    location: '',
    color: '#e3e8f4',
    source: 'manual',
  },
  {
    _id: 'k4',
    subjectName: '화학 실험',
    days: [3],
    startTime: '14:00',
    endTime: '16:00',
    location: '과학실',
    color: '#f6dfdf',
    source: 'manual',
  },
  {
    _id: 'k5',
    subjectName: '체육',
    days: [5],
    startTime: '15:00',
    endTime: '16:00',
    location: '',
    color: '#faf0cf',
    source: 'manual',
  },
];

export const seedShares = (): CalendarShare[] => [
  {
    _id: 'cs1',
    token: '8f2ac1',
    ownerId: 'u-me',
    rangeStart: day(-25),
    rangeEnd: day(5),
    scopes: ['todos', 'study'],
    expiresAt: null,
    revokedAt: null,
    createdAt: ago(24 * 25),
    subscribers: [],
  },
  {
    _id: 'cs2',
    token: '1b9d02',
    ownerId: 'u-me',
    rangeStart: day(-45),
    rangeEnd: day(-26),
    scopes: ['todos'],
    expiresAt: null,
    revokedAt: null,
    createdAt: ago(24 * 45),
    subscribers: [],
  },
];

export const NOTE_SECTIONS = [
  { heading: '1. 이차방정식의 정의', body: 'ax² + bx + c = 0 (a≠0) 형태의 방정식' },
  { heading: '2. 근의 공식', body: 'x = (-b ± √(b²-4ac)) / 2a' },
  { heading: '3. 판별식 D = b²-4ac', body: 'D>0: 서로 다른 두 실근 / D=0: 중근 / D<0: 허근' },
];

export const DOC_POINTS = {
  '이차방정식_필기.pdf': [
    '이차방정식은 ax²+bx+c=0 형태이며 근의 공식으로 해를 구할 수 있어요',
    '판별식 D의 부호에 따라 실근·중근·허근이 결정돼요',
    '그래프는 D 값에 따라 x축과의 교점 개수가 달라져요',
  ],
  '연습문제.pdf': [
    '이차방정식 연습문제 12문항과 풀이 과정이 포함되어 있어요',
    '근의 공식과 인수분해를 활용한 풀이 유형으로 구성돼요',
    '마지막 페이지에 정답과 해설표가 있어요',
  ],
};

export const makeMaterial = (
  folderId: string,
  kind: Material['kind'],
  over: Partial<Material> = {},
): Material => {
  const base = {
    handwriting: {
      title: '이차방정식 필기.jpg',
      source: 'camera',
      summary: { sections: NOTE_SECTIONS, points: [] },
      keywords: ['이차방정식', '근의 공식', '판별식'],
    },
    recording: {
      title: '9/6 강의 녹음',
      source: 'audio_file',
      summary: {
        sections: [],
        points: [
          '원자 반지름 ↓ → 이온화 에너지 ↑',
          '같은 족: 아래로 갈수록 감소',
          '같은 주기: 오른쪽으로 갈수록 증가',
        ],
      },
      keywords: ['이온화 에너지', '원자 반지름'],
    },
    document: {
      title: '연습문제.pdf',
      source: 'file',
      summary: { sections: [], points: DOC_POINTS['연습문제.pdf'] },
      keywords: ['이차방정식', '연습문제', '근의 공식'],
    },
  }[kind];
  return {
    _id: `mat-${Math.random().toString(36).slice(2, 8)}`,
    folderId,
    kind,
    source: base.source as Material['source'],
    title: base.title,
    description: null,
    avatarItemId: null,
    processing: { status: 'done', progress: 100, jobId: null },
    summary: base.summary,
    keywords: base.keywords,
    bookmarks:
      kind === 'recording' ? [252, 765, 1503, 2488, 3487].map((s) => ({ atSec: s / 10 })) : [],
    pages:
      kind === 'handwriting'
        ? [{ pageNo: 1, imageUrl: '', sizeBytes: 3.1 * 1024 ** 2, ocrText: null, takenAt: ago(24) }]
        : undefined,
    createdAt: ago(24 * 3),
    ...over,
  };
};

export const seedFolders = (): Folder[] => [];

export const DEMO_FOLDER: Folder = {
  _id: 'fo1',
  title: '이차방정식 풀이',
  subjectId: 's-math',
  subjectName: '수학',
  createdAt: ago(24 * 3),
  updatedAt: now(),
};

export const RECORDING = (materialId: string): Recording => ({
  _id: `rec-${materialId}`,
  materialId,
  audioUrl: '',
  audioSizeBytes: 28_400_000,
  durationSec: 340,
  transcript: {
    text: '오늘은 이온화 에너지의 주기적 경향성에 대해 알아볼게요. 이온화 에너지는 원자에서 전자 하나를 완전히 떼어내는 데 필요한 에너지를 말합니다. 원자 반지름이 작아질수록 핵과 전자 사이의 인력이 강해져서 전자를 떼어내기가 더 어려워지고, 그만큼 이온화 에너지 값은 커지는 경향을 보입니다. 같은 족에서는 아래로 내려갈수록 전자 껍질 수가 늘어나기 때문에 원자 반지름이 커지고, 이온화 에너지는 작아집니다. 반대로 같은 주기에서는 오른쪽으로 갈수록 핵전하가 커지면서 원자 반지름이 작아지고 이온화 에너지는 커집니다. 다만 2족에서 13족으로 넘어갈 때나 15족에서 16족으로 넘어갈 때는 예외적으로 이온화 에너지가 살짝 감소하는 구간이 있다는 것도 함께 기억해두세요. 이러한 경향은 전자 배치의 안정성과 밀접한 관련이 있습니다.',
    segments: [
      { startSec: 0, endSec: 30, text: '오늘은 이온화 에너지의 주기적 경향성에 대해 알아볼게요.' },
      {
        startSec: 30,
        endSec: 60,
        text: '원자 반지름이 작아질수록 전자를 떼어내기가 더 어려워지고,',
      },
      { startSec: 60, endSec: 90, text: '그만큼 이온화 에너지 값은 커지는 경향을 보입니다.' },
      { startSec: 90, endSec: 120, text: '같은 족에서는 아래로 내려갈수록 값이 작아집니다.' },
    ],
  },
  slides: Array.from({ length: 8 }, (_, i) => ({
    index: i,
    title:
      i === 2
        ? '이온화 에너지 주기적 경향성'
        : ([
            '이온화 에너지란?',
            '전자 껍질과 핵전하',
            '이온화 에너지 주기적 경향성',
            '같은 족의 경향',
            '같은 주기의 경향',
            '예외 구간',
            '전자 배치와 안정성',
            '정리',
          ][i] ?? '정리'),
    bullets: [
      '원자 반지름 ↓ → 이온화 에너지 ↑',
      '같은 족: 아래로 갈수록 감소',
      '같은 주기: 오른쪽으로 갈수록 증가',
    ],
    startSec: i * 42,
    endSec: (i + 1) * 42,
  })),
  visemeUrl: null,
});

export const QUESTIONS: Question[] = [
  {
    _id: 'q1',
    order: 1,
    type: 'multiple_choice',
    prompt: '엔트로피의 SI 단위는?',
    choices: ['J/K (줄 매 켈빈)', 'J (줄)', 'K (켈빈)', 'W (와트)', 'Pa (파스칼)'],
    answer: 'J/K (줄 매 켈빈)',
    explanation: null,
    conceptTags: ['엔트로피'],
  },
  {
    _id: 'q2',
    order: 2,
    type: 'multiple_choice',
    prompt: '고립계에서 엔트로피가 항상 증가하는 이유와 관련 있는 개념은?',
    choices: ['무질서도의 증가', '에너지 보존', '질량 보존', '열역학 제1법칙', '열역학 제2법칙'],
    answer: '무질서도의 증가',
    explanation: null,
    conceptTags: ['엔트로피'],
  },
  {
    _id: 'q3',
    order: 3,
    type: 'multiple_choice',
    prompt: '이차방정식 x²-5x+6=0의 두 근의 합은?',
    choices: ['5', '6', '-5', '1', '-6'],
    answer: '5',
    explanation: null,
    conceptTags: ['근과 계수의 관계'],
  },
  {
    _id: 'q4',
    order: 4,
    type: 'multiple_choice',
    prompt: '삼각형의 내각의 합은?',
    choices: ['90°', '180°', '270°', '360°', '120°'],
    answer: '180°',
    explanation: null,
    conceptTags: ['도형'],
  },
  {
    _id: 'q5',
    order: 5,
    type: 'multiple_choice',
    prompt: '등비수열에서 첫째항이 3, 공비가 2일 때 5번째 항은?',
    choices: ['24', '30', '48', '96', '15'],
    answer: '48',
    explanation: null,
    conceptTags: ['수열'],
  },
];

export const EXPLAIN_Q3 = [
  '이차방정식 x² − 5x + 6 = 0의 두 근의 합',
  '근과 계수의 관계(비에트의 공식) 를 쓰면 바로 나와요.',
  '이차방정식 ax² + bx + c = 0의 두 근을 α, β라 하면:',
  '• 두 근의 합: α + β = -b/a',
  '• 두 근의 곱: α × β = c/a',
  '이 식에서 a = 1, b = -5, c = 6 이니까:',
  '두 근의 합 = -(-5)/1 = 5',
  '검산해보면: x² − 5x + 6 = (x − 2)(x − 3) = 0 이므로 두 근은 2와 3.',
  '합은 2 + 3 = 5 ✅ (곱도 2×3=6으로 맞아떨어짐)',
].join('\n');

export const SIMILAR: Question[] = [
  {
    _id: 'sq1',
    order: 1,
    type: 'short_answer',
    prompt: '이차방정식 x² − 5x + 6 = 0의 두 근의 합은?',
    choices: null,
    answer: 'x=2 또는 x=3',
    explanation: null,
    conceptTags: [],
  },
  {
    _id: 'sq2',
    order: 2,
    type: 'short_answer',
    prompt: '삼각형의 내각의 합이 180°임을 이용해 구하는 각 ∠A는?',
    choices: null,
    answer: '∠A = 180° − (∠B + ∠C)',
    explanation: null,
    conceptTags: [],
  },
  {
    _id: 'sq3',
    order: 3,
    type: 'short_answer',
    prompt: '등비수열에서 첫째항이 3, 공비가 2일 때 5번째 항은?',
    choices: null,
    answer: '48',
    explanation: null,
    conceptTags: [],
  },
];

export const makeQuizSet = (materialId: string, title: string): QuizSet => ({
  _id: `qs-${Math.random().toString(36).slice(2, 8)}`,
  materialId,
  folderId: 'fo1',
  sourceSetId: null,
  title,
  status: 'ready',
  progress: 100,
  questionCount: QUESTIONS.length,
  questions: QUESTIONS,
  createdAt: now(),
});

export const seedFlashcards = (): Flashcard[] =>
  (
    [
      ['엔트로피란?', '무질서도를 나타내는 열역학적 상태량'],
      ['엔트로피의 단위는?', 'J/K (줄 매 켈빈)'],
      ['열역학 제2 법칙이란?', '고립계의 엔트로피는 감소하지 않는다'],
      ['엔트로피와 확률의 관계는?', 'S = k ln W (볼츠만 식)'],
      ['가역 과정과 비가역 과정의 차이는?', '가역 과정은 엔트로피 변화가 0, 비가역 과정은 증가'],
    ] as const
  ).map(([front, back], i) => ({
    _id: `fc${i}`,
    materialId: null,
    folderId: 'fo1',
    front,
    back,
    sourceQuizSetId: null,
    sourceQuestionId: null,
    lastResult: null,
    createdAt: now(),
  }));

export const ROOM_MEMBERS = [
  {
    userId: 'u-jiwoo',
    nickname: '지우',
    role: 'host' as const,
    status: 'joined' as const,
    camOn: true,
    micOn: false,
    todaySec: 6723,
  },
  {
    userId: 'u-sumin',
    nickname: '수민',
    role: 'member' as const,
    status: 'joined' as const,
    camOn: false,
    micOn: false,
    todaySec: 2839,
    avatarUrl: '🐻',
  },
  {
    userId: 'u-me',
    nickname: '나 (형욱)',
    role: 'member' as const,
    status: 'joined' as const,
    camOn: true,
    micOn: true,
    todaySec: 8077,
  },
  {
    userId: 'u-jaemin',
    nickname: '재민',
    role: 'member' as const,
    status: 'joined' as const,
    camOn: false,
    micOn: false,
    todaySec: 4244,
    avatarUrl: '🐱',
  },
  {
    userId: 'u-youngwoo',
    nickname: '영우',
    role: 'member' as const,
    status: 'joined' as const,
    camOn: true,
    micOn: false,
    todaySec: 7850,
  },
  {
    userId: 'u-jaejun',
    nickname: '재준',
    role: 'member' as const,
    status: 'joined' as const,
    camOn: false,
    micOn: false,
    todaySec: 4244,
    avatarUrl: '🐱',
  },
];

export const makeRoom = (over: Partial<StudyRoom> = {}): StudyRoom => ({
  _id: 'room-1',
  title: '3학년 4반 야자모임',
  categoryId: 'c-suneung',
  categoryName: '수능',
  hostId: 'u-jiwoo',
  isPublic: false,
  inviteCode: 'AB3F9K',
  maxCapacity: 8,
  memberCount: 6,
  timerRule: null,
  members: ROOM_MEMBERS,
  createdAt: ago(24 * 10),
  closedAt: null,
  ...over,
});

export const RECOMMENDED: StudyRoom[] = [
  makeRoom({
    _id: 'room-en',
    title: '영어회화 스터디',
    categoryName: '영어',
    isPublic: true,
    inviteCode: 'EN12QW',
    memberCount: 12,
    tags: ['영어', '회화'],
    description: '매일 30분씩 영어 회화 실력을 높이는 스터디룸입니다.',
  }),
  makeRoom({
    _id: 'room-py',
    title: '코딩 스터디 (Python)',
    categoryName: '코딩',
    isPublic: true,
    inviteCode: 'PY88ZX',
    memberCount: 8,
    tags: ['코딩', 'Python'],
    description: 'Python 기초부터 프로젝트까지 함께 공부하는 코딩 스터디입니다.',
  }),
];

export const SHOP: ShopItem[] = [
  {
    _id: 'saebyeok',
    category: 'avatar',
    name: '새벽 아바타',
    description: '짧은 머리가 깔끔한 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '🧑🏽',
    assetUrl: '🧑🏽',
    purchaseCount: 120,
    isActive: true,
    isDefault: false,
    badge: 'NEW',
  },
  {
    _id: 'jihoo',
    category: 'avatar',
    name: '지후 아바타',
    description: '단정한 교복 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '👨🏻',
    assetUrl: '👨🏻',
    purchaseCount: 340,
    isActive: true,
    isDefault: false,
    badge: 'BEST',
  },
  {
    _id: 'bora',
    category: 'avatar',
    name: '보라 아바타',
    description: '머리를 묶은 발랄한 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '👧🏻',
    assetUrl: '👧🏻',
    purchaseCount: 80,
    isActive: true,
    isDefault: false,
  },
  {
    _id: 'haneul',
    category: 'avatar',
    name: '하늘 아바타',
    description: '긴 생머리 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '👩🏻',
    assetUrl: '👩🏻',
    purchaseCount: 60,
    isActive: true,
    isDefault: false,
  },
  {
    _id: 'narae',
    category: 'avatar',
    name: '나래 아바타',
    description: '곱슬머리가 귀여운 스타일이에요.',
    price: 500,
    avatarStyle: 'nice',
    thumbnailUrl: '👩🏼‍🦱',
    assetUrl: '👩🏼‍🦱',
    purchaseCount: 40,
    isActive: true,
    isDefault: false,
  },
  {
    _id: 'sea',
    category: 'theme',
    name: '바다 테마',
    description: '시원한 파란 물결이 앱 전체를 감싸요.',
    price: 1000,
    avatarStyle: null,
    thumbnailUrl: '🌊',
    assetUrl: '🌊',
    purchaseCount: 30,
    isActive: true,
    isDefault: false,
  },
];
export { BASE_AVATAR } from '../../lib/shop-items';

export const seedUserItems = (): UserItem[] => [
  {
    _id: 'ui-base',
    itemId: 'base',
    itemCategory: 'avatar',
    isOwned: true,
    isWished: false,
    isEquipped: true,
    acquiredAt: ago(24 * 90),
  },
  {
    _id: 'ui-sea',
    itemId: 'sea',
    itemCategory: 'theme',
    isOwned: false,
    isWished: true,
    isEquipped: false,
    acquiredAt: null,
  },
];

export const seedLedger = (): PointLedger[] => [
  {
    _id: 'p1',
    amount: 30,
    balanceAfter: 1240,
    reasonType: 'session_complete',
    description: '순공 세션 완료',
    createdAt: ago(3),
  },
  {
    _id: 'p2',
    amount: 40,
    balanceAfter: 1210,
    reasonType: 'quiz_correct',
    description: '퀴즈 정답 8개',
    createdAt: ago(14),
  },
  {
    _id: 'p3',
    amount: 20,
    balanceAfter: 1170,
    reasonType: 'review_complete',
    description: '복습 큐 완료',
    createdAt: ago(16),
  },
  {
    _id: 'p4',
    amount: -10,
    balanceAfter: 1150,
    reasonType: 'session_abuse',
    description: '세션 이탈 페널티',
    createdAt: ago(22),
  },
];
