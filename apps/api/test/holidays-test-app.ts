import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { HolidaySource, type HolidayItem } from '../src/modules/calendar/holiday-source.js';
import { HolidaysController } from '../src/modules/calendar/holidays.controller.js';
import { HolidaysService } from '../src/modules/calendar/holidays.service.js';
import { CustomHoliday } from '../src/modules/calendar/schemas/custom-holiday.schema.js';
import { HiddenHoliday } from '../src/modules/calendar/schemas/hidden-holiday.schema.js';
import { HolidayFetch } from '../src/modules/calendar/schemas/holiday-fetch.schema.js';
import { PublicHoliday } from '../src/modules/calendar/schemas/public-holiday.schema.js';

export const USER_A = new Types.ObjectId();
export const USER_B = new Types.ObjectId();
export const AUTH_A = { Authorization: 'Bearer token-a' };
export const AUTH_B = { Authorization: 'Bearer token-b' };
const TOKENS: Record<string, Types.ObjectId> = { 'token-a': USER_A, 'token-b': USER_B };

export interface PubRow { _id: string; name: string; source: string; createdAt: Date }
export interface FetchRow { _id: number; fetchedAt: Date; count: number }
export interface HidRow { userId: Types.ObjectId; date: string }
export interface CusRow { _id: Types.ObjectId; userId: Types.ObjectId; name: string; date: string; createdAt: number }

type BulkOp =
    | { updateOne: { filter: { _id: string; source?: string }; update: { $set?: { name: string }; $setOnInsert?: Omit<PubRow, '_id'> }; upsert?: boolean } }
    | { deleteOne: { filter: { _id: string; source?: string } } };
const matchesFilter = (r: PubRow, f: { _id: string; source?: string }) => r._id === f._id && (!f.source || r.source === f.source);

type Range = { $gte: string; $lte: string };
const inRange = (v: string, r: Range) => v >= r.$gte && v <= r.$lte;

/** 메모리에 들어 있는 가짜 컬렉션 3개 (서비스가 쓰는 만큼만 흉내 낸다) */
export function createFakeStores() {
    const pub: PubRow[] = [];
    const fetches: FetchRow[] = [];
    const hid: HidRow[] = [];
    const cus: CusRow[] = [];
    let seq = 0;
    const chain = <T>(rows: T[], key?: (r: T) => string) => {
        const sorted = key ? [...rows].sort((a, b) => key(a).localeCompare(key(b))) : [...rows];
        const c = { sort: () => c, lean: () => Promise.resolve(sorted) };
        return c;
    };
    const publicModel = {
        find: (f: { _id: Range }) => chain(pub.filter((r) => inRange(r._id, f._id)), (r) => r._id),
        bulkWrite: (ops: BulkOp[]) => {
            for (const op of ops) {
                if ('deleteOne' in op) {
                    const i = pub.findIndex((r) => matchesFilter(r, op.deleteOne.filter));
                    if (i >= 0) pub.splice(i, 1);
                    continue;
                }
                const { filter, update, upsert } = op.updateOne;
                const row = pub.find((r) => matchesFilter(r, filter));
                if (row) {
                    if (update.$set) Object.assign(row, update.$set); // $setOnInsert는 이미 있으면 아무것도 안 한다
                } else if (upsert && !pub.some((r) => r._id === filter._id)) {
                    pub.push({ _id: filter._id, ...update.$setOnInsert! });
                }
            }
            return Promise.resolve();
        },
    };
    const fetchModel = {
        findOne: (f: { _id: number }) => ({ lean: () => Promise.resolve(fetches.find((r) => r._id === f._id) ?? null) }),
        updateOne: (f: { _id: number }, u: { $set: Omit<FetchRow, '_id'> }) => {
            const row = fetches.find((r) => r._id === f._id);
            if (row) Object.assign(row, u.$set);
            else fetches.push({ _id: f._id, ...u.$set });
            return Promise.resolve();
        },
    };
    const hiddenModel = {
        find: (f: { userId: Types.ObjectId; date: Range }) =>
            chain(hid.filter((r) => r.userId.equals(f.userId) && inRange(r.date, f.date))),
        updateOne: (f: HidRow) => {
            if (!hid.some((r) => r.userId.equals(f.userId) && r.date === f.date)) hid.push({ userId: f.userId, date: f.date });
            return Promise.resolve();
        },
        deleteOne: (f: HidRow) => {
            const i = hid.findIndex((r) => r.userId.equals(f.userId) && r.date === f.date);
            if (i >= 0) hid.splice(i, 1);
            return Promise.resolve();
        },
    };
    const customModel = {
        find: (f: { userId: Types.ObjectId; date?: Range }) =>
            chain(
                cus.filter((r) => r.userId.equals(f.userId) && (!f.date || inRange(r.date, f.date))),
                (r) => String(r.createdAt).padStart(8, '0'),
            ),
        create: (docs: { userId: Types.ObjectId; name: string; date: string }[]) => {
            const row = { _id: new Types.ObjectId(), ...docs[0]!, createdAt: ++seq };
            cus.push(row);
            return Promise.resolve([{ toObject: () => row }]);
        },
        deleteOne: (f: { _id: Types.ObjectId; userId: Types.ObjectId }) => {
            const i = cus.findIndex((r) => r._id.equals(f._id) && r.userId.equals(f.userId));
            if (i >= 0) cus.splice(i, 1);
            return Promise.resolve({ deletedCount: i >= 0 ? 1 : 0 });
        },
    };
    return { pub, fetches, hid, cus, publicModel, fetchModel, hiddenModel, customModel };
}

export type FakeStores = ReturnType<typeof createFakeStores>;

/** 가짜 DB · 가짜 외부 API · 가짜 로그인(token-a, token-b)을 넣은 공휴일 테스트용 서버 */
export async function createHolidaysTestApp(
    stores: FakeStores,
    fetchYear: (year: number) => Promise<HolidayItem[] | null>,
): Promise<{ app: INestApplication; service: HolidaysService }> {
    const moduleRef = await Test.createTestingModule({
        controllers: [HolidaysController],
        providers: [
            HolidaysService,
            { provide: getModelToken(PublicHoliday.name), useValue: stores.publicModel },
            { provide: getModelToken(HolidayFetch.name), useValue: stores.fetchModel },
            { provide: getModelToken(HiddenHoliday.name), useValue: stores.hiddenModel },
            { provide: getModelToken(CustomHoliday.name), useValue: stores.customModel },
            { provide: HolidaySource, useValue: { fetchYear } },
            {
                provide: TokenService,
                useValue: {
                    verifyAccess: (t: string) =>
                        TOKENS[t]
                            ? Promise.resolve({ userId: TOKENS[t].toString() })
                            : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                },
            },
        ],
    }).compile();

    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    return { app, service: moduleRef.get(HolidaysService) };
}
