// 진짜 MongoDB에서 반복 목표의 연속 달성 주 수(GET /goals/recurring의 streak, FR-11 · FR-12-04)를 확인하는 테스트.
// 확인하는 것: 지난 몇 주 daily_records와 목표로 계산한 streak, 제외일 · 공휴일을 넣으면 결과가 바뀌는 것(내가 숨긴 공휴일은 건너뛰지 않음),
// 과목 지정 · 쉬는 목표 · pausedUntil, 다른 사람 기록이 섞이지 않는 것, 목표가 여러 개여도 공부 기록은 한 번만 읽는 것.
// "오늘"은 시계(Date)를 서울 2026-11-14(토) 정오로 고정해 쓴다.
// MONGODB_VERIFY_URI가 localhost일 때만 돌고(없거나 localhost가 아니면 건너뜀), 파일 · 실행마다 고유한 전용 DB만 쓰고 끝나면 그 DB만 지운다.
// 실행: $env:MONGODB_VERIFY_URI = "mongodb://localhost:27017/?directConnection=true"; npm run test -w @notelink/api -- test/goal-judge-real-db.test.ts
import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, getModelToken, MongooseModule } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { RecurringGoal as SharedRecurringGoal } from '@notelink/shared';
import { Types, type Connection, type Model } from 'mongoose';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { User, UserSchema } from '../src/modules/auth/schemas/user.schema.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { HolidaySource, type HolidayItem } from '../src/modules/calendar/holiday-source.js';
import { HolidaysService } from '../src/modules/calendar/holidays.service.js';
import { CustomHoliday, CustomHolidaySchema } from '../src/modules/calendar/schemas/custom-holiday.schema.js';
import { HiddenHoliday, HiddenHolidaySchema } from '../src/modules/calendar/schemas/hidden-holiday.schema.js';
import { HolidayFetch, HolidayFetchSchema } from '../src/modules/calendar/schemas/holiday-fetch.schema.js';
import { PublicHoliday, PublicHolidaySchema } from '../src/modules/calendar/schemas/public-holiday.schema.js';
import { RecurringGoalsController } from '../src/modules/progress/recurring-goals.controller.js';
import { RecurringGoalsService } from '../src/modules/progress/recurring-goals.service.js';
import { DailyRecord, DailyRecordSchema } from '../src/modules/progress/schemas/daily-record.schema.js';
import { RecurringGoal, RecurringGoalSchema } from '../src/modules/progress/schemas/recurring-goal.schema.js';
import { Subject, SubjectSchema } from '../src/modules/session/schemas/subject.schema.js';

const uri = process.env.MONGODB_VERIFY_URI;
const isLocal = !!uri && /^mongodb:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)[:/]/.test(uri);
// 이 파일이 이번 실행에서만 쓰는 DB 이름 (다른 파일 · 다른 실행과 겹치지 않는다)
const dbName = `notelink_verify_goal_judge_${process.pid}_${Date.now()}`;

// 서울 2026-11-14(토) 12:00. 이 주(11-09 주)의 월 · 수는 지났고, 지난 주들은 10-19 · 10-26 · 11-02 · 11-09 주다
const NOW = new Date('2026-11-14T03:00:00Z');
const CREATED = new Date('2026-09-30T15:00:00Z'); // 서울 2026-10-01
const DONE = 1800; // 30분
const WEEKS = ['2026-10-19', '2026-10-21', '2026-10-26', '2026-10-28', '2026-11-02', '2026-11-04', '2026-11-09', '2026-11-11']; // 월 · 수

describe.skipIf(!isLocal)('진짜 DB 반복 목표 연속 달성 주 수', () => {
    const tokens: Record<string, Types.ObjectId> = {};
    let userSeq = 0;
    type TestUser = { id: Types.ObjectId; auth: { Authorization: string } };
    let app: INestApplication;
    let conn: Connection;
    const col = (name: string) => conn.collection(name);
    const fetchYear = vi.fn<(year: number) => Promise<HolidayItem[] | null>>();

    const http = () => request(app.getHttpServer());
    const list = async (u: TestUser) => {
        const res = await http().get('/api/v1/goals/recurring').set(u.auth);
        expect(res.status).toBe(200);
        return res.body.data as { _id: string; name: string; streak: number }[];
    };
    const streakOf = async (u: TestUser, name = '목표') => (await list(u)).find((g) => g.name === name)!.streak;

    // nickname에 유일 인덱스가 있어서 사람마다 다르게 넣는다
    const newUser = async (): Promise<TestUser> => {
        const id = new Types.ObjectId();
        const n = userSeq++;
        await col('users').insertOne({ _id: id, nickname: `goal_judge_${n}_${process.pid}`, email: `goal_judge_${n}_${process.pid}@example.com` });
        tokens[`token-${id.toString()}`] = id;
        return { id, auth: { Authorization: `Bearer token-${id.toString()}` } };
    };
    const addGoal = async (u: TestUser, over: Record<string, unknown> = {}) => {
        const doc = {
            _id: new Types.ObjectId(),
            userId: u.id,
            name: '목표',
            days: [1, 3],
            targetMin: 30,
            remindEnabled: false,
            remindTime: null,
            pausedUntil: null,
            streak: 0,
            isActive: true,
            deletedAt: null,
            createdAt: CREATED,
            updatedAt: CREATED,
            ...over,
        };
        await col('recurring_goals').insertOne(doc);
        return doc._id;
    };
    /** 날짜마다 그날 공부한 초(전체)와, 있으면 과목별 초를 넣는다 */
    const addStudy = async (u: TestUser, days: string[], sec = DONE, subject?: { id: Types.ObjectId; sec: number }) => {
        await col('daily_records').insertMany(
            days.map((studyDate) => ({
                userId: u.id,
                studyDate,
                totalSec: sec,
                personalSec: sec,
                roomSec: 0,
                streakOk: false,
                items: subject ? [{ _id: new Types.ObjectId(), title: '공부', subjectId: subject.id, subjectName: '과목', goalMin: null, accumulatedSec: subject.sec }] : [],
            })),
        );
    };

    beforeAll(async () => {
        if (!isLocal) throw new Error('localhost 주소가 아니라서 실행하지 않습니다');
        const moduleRef = await Test.createTestingModule({
            imports: [
                // 접속이 안 되면 30초 기다리지 않고 5초 뒤에 이유와 함께 실패하게 한다
                MongooseModule.forRoot(uri!, { dbName, serverSelectionTimeoutMS: 5000 }),
                MongooseModule.forFeature([
                    { name: RecurringGoal.name, schema: RecurringGoalSchema },
                    { name: Subject.name, schema: SubjectSchema },
                    { name: DailyRecord.name, schema: DailyRecordSchema },
                    { name: PublicHoliday.name, schema: PublicHolidaySchema },
                    { name: HolidayFetch.name, schema: HolidayFetchSchema },
                    { name: HiddenHoliday.name, schema: HiddenHolidaySchema },
                    { name: CustomHoliday.name, schema: CustomHolidaySchema },
                    { name: User.name, schema: UserSchema },
                ]),
            ],
            controllers: [RecurringGoalsController],
            providers: [
                RecurringGoalsService,
                HolidaysService,
                { provide: HolidaySource, useValue: { fetchYear } },
                {
                    provide: TokenService,
                    useValue: {
                        verifyAccess: (t: string) =>
                            tokens[t]
                                ? Promise.resolve({ userId: tokens[t].toString() })
                                : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                    },
                },
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
        conn = moduleRef.get<Connection>(getConnectionToken());
        await conn.dropDatabase();
        await Promise.all([conn.model(RecurringGoal.name).init(), conn.model(DailyRecord.name).init(), conn.model(User.name).init()]);
        dailyModel = moduleRef.get<Model<DailyRecord>>(getModelToken(DailyRecord.name));
    }, 30000);
    let dailyModel: Model<DailyRecord>;

    beforeEach(() => {
        // 공휴일 원본은 이 주 근처에 공휴일이 없는 응답. 시계는 서울 2026-11-14(토) 정오
        fetchYear.mockReset();
        fetchYear.mockResolvedValue([{ date: '2026-01-01', name: '신정' }]);
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
    });
    afterEach(async () => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        await Promise.all(['recurring_goals', 'daily_records', 'public_holidays', 'holiday_fetches', 'hidden_holidays', 'custom_holidays'].map((n) => col(n).deleteMany({})));
    });
    afterAll(async () => {
        if (conn) await conn.dropDatabase();
        await app?.close();
    });

    it('1) 지난 몇 주를 모두 채웠으면 연속 달성 주 수가 나온다 (shared RecurringGoal 모양 그대로)', async () => {
        const me = await newUser();
        await addGoal(me);
        await addStudy(me, WEEKS);
        const res = await http().get('/api/v1/goals/recurring').set(me.auth);
        expect(res.body.data).toHaveLength(1);
        expect(SharedRecurringGoal.safeParse(res.body.data[0]).success).toBe(true);
        expect(res.body.data[0].streak).toBe(4); // 이번 주(월 · 수를 이미 채움) + 지난 3주
    });

    it('2) 한 주를 못 하면 거기서 끊기고, 이번 주에 못 한 날이 있으면 0이다', async () => {
        const me = await newUser();
        await addGoal(me);
        await addStudy(me, WEEKS.filter((d) => d !== '2026-11-04')); // 11-02 주의 수요일을 못 함
        expect(await streakOf(me)).toBe(1); // 이번 주(11-09 주)만

        const you = await newUser();
        await addGoal(you);
        await addStudy(you, WEEKS.filter((d) => d !== '2026-11-09')); // 이번 주 월요일을 못 함
        expect(await streakOf(you)).toBe(0);
    });

    it('3) 오늘 아직 못 채웠어도 끊지 않는다 (보류)', async () => {
        const me = await newUser();
        await addGoal(me, { days: [1, 3, 6] }); // 오늘(토)도 대상 날
        await addStudy(me, WEEKS); // 지난 주들의 토요일은 목표 요일이 아니던 때와 달라, 토요일 기록도 넣는다
        await addStudy(me, ['2026-10-24', '2026-10-31', '2026-11-07']);
        expect(await streakOf(me)).toBe(3); // 이번 주는 토요일(오늘)이 아직이라 진행 중 → 지난 3주만
        await addStudy(me, ['2026-11-14']);
        expect(await streakOf(me)).toBe(4);
    });

    it('4) 제외일을 넣으면 결과가 바뀐다 (그 날을 못 채웠어도 주가 달성)', async () => {
        const me = await newUser();
        await addGoal(me);
        await addStudy(me, WEEKS.filter((d) => d !== '2026-11-04'));
        expect(await streakOf(me)).toBe(1);

        await col('custom_holidays').insertOne({ userId: me.id, name: '여행', date: '2026-11-04', createdAt: new Date() });
        expect(await streakOf(me)).toBe(4);
    });

    it('5) 공휴일도 건너뛴다. 내가 캘린더에서 숨겨도 건너뛴다(숨김은 표시 설정일 뿐)', async () => {
        const me = await newUser();
        await addGoal(me);
        await addStudy(me, WEEKS.filter((d) => d !== '2026-11-04'));
        // 다른 출처(manual)로 저장된 11-04 공휴일 (공휴일 원본 응답으로 지워지지 않는다)
        await col('public_holidays').insertOne({ _id: '2026-11-04' as never, name: '임시 공휴일', source: 'manual', createdAt: new Date() });
        expect(await streakOf(me)).toBe(4);

        await col('hidden_holidays').insertOne({ userId: me.id, date: '2026-11-04' }); // 내 캘린더에서 숨김
        expect(await streakOf(me)).toBe(4); // 숨겨도 그 날 공부를 안 해도 스트릭이 끊기지 않는다

        await col('hidden_holidays').deleteMany({});
        expect(await streakOf(me)).toBe(4);
    });

    it('6) pausedUntil 이전 날은 건너뛰고, 쉬는 목표(isActive=false)는 0이다', async () => {
        const me = await newUser();
        await addGoal(me, { name: '쉬는 목표', isActive: false });
        await addGoal(me, { name: '일시중지', pausedUntil: new Date('2026-11-04T00:00:00+09:00') });
        await addStudy(me, ['2026-11-09', '2026-11-11']); // 11-04까지는 기록이 없다
        const goals = await list(me);
        expect(goals.find((g) => g.name === '쉬는 목표')!.streak).toBe(0);
        expect(goals.find((g) => g.name === '일시중지')!.streak).toBe(1); // 11-04까지 쉬어서 이번 주만 센다
    });

    it('7) 과목을 지정한 목표는 그 과목 시간만 센다', async () => {
        const me = await newUser();
        const math = new Types.ObjectId();
        const eng = new Types.ObjectId();
        await addGoal(me, { name: '수학', subjectId: math });
        await addGoal(me, { name: '영어', subjectId: eng });
        await addGoal(me, { name: '전체' });
        await addStudy(me, WEEKS, 7200, { id: math, sec: DONE }); // 하루 총 2시간 중 수학은 30분, 영어는 0
        const goals = await list(me);
        expect(goals.find((g) => g.name === '수학')!.streak).toBe(4);
        expect(goals.find((g) => g.name === '영어')!.streak).toBe(0);
        expect(goals.find((g) => g.name === '전체')!.streak).toBe(4);
    });

    it('8) 다른 사람의 공부 기록 · 제외일은 섞이지 않는다', async () => {
        const me = await newUser();
        const other = await newUser();
        await addGoal(me);
        await addGoal(other);
        await addStudy(other, WEEKS); // 다른 사람만 열심히 함
        await col('custom_holidays').insertOne({ userId: other.id, name: '남의 제외일', date: '2026-11-09', createdAt: new Date() });
        expect(await streakOf(me)).toBe(0);
        expect(await streakOf(other)).toBe(4);

        await addStudy(me, WEEKS.filter((d) => d !== '2026-11-04'));
        expect(await streakOf(me)).toBe(1); // 남의 제외일로 바뀌지 않는다
        expect((await list(other)).map((g) => g._id)).not.toContain((await list(me))[0]!._id);
    });

    it('9) 목표가 여러 개여도 공부 기록은 한 번만 읽는다', async () => {
        const me = await newUser();
        await addGoal(me, { name: '가' });
        await addGoal(me, { name: '나', days: [2] });
        await addGoal(me, { name: '다', days: [5] });
        await addStudy(me, WEEKS);
        const find = vi.spyOn(dailyModel, 'find');
        const goals = await list(me);
        expect(goals).toHaveLength(3);
        expect(find).toHaveBeenCalledTimes(1);
    });

    it('10) 쉬는 목표만 있으면 공부 기록을 읽지 않는다', async () => {
        const me = await newUser();
        await addGoal(me, { isActive: false });
        const find = vi.spyOn(dailyModel, 'find');
        expect((await list(me))[0]!.streak).toBe(0);
        expect(find).not.toHaveBeenCalled();
    });

    it('11) 만들기 응답의 streak은 바로 뒤 목록의 streak과 같다 (오늘 목표 시간을 이미 채운 사용자가 오늘 요일로 만들 때)', async () => {
        const me = await newUser();
        await addStudy(me, ['2026-11-14']); // 오늘(토) 30분을 이미 공부했다
        const created = await http().post('/api/v1/goals/recurring').set(me.auth).send({ name: '토요일 공부', days: [6], targetMin: 30 });
        expect(created.status).toBe(201);
        expect(SharedRecurringGoal.safeParse(created.body.data).success).toBe(true);
        expect(created.body.data.streak).toBe(1); // 이번 주 대상 날(오늘)을 이미 달성
        expect((await list(me)).find((g) => g.name === '토요일 공부')!.streak).toBe(created.body.data.streak);
    });
});
