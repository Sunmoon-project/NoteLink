import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { seoulDate } from '../session/study-time.js';
import type { CreateCustomHolidayDto } from './dto/holiday.dto.js';
import { fixedHolidays, HolidaySource, type HolidayItem } from './holiday-source.js';
import { CustomHoliday } from './schemas/custom-holiday.schema.js';
import { HiddenHoliday } from './schemas/hidden-holiday.schema.js';
import { PublicHoliday } from './schemas/public-holiday.schema.js';

/** 앱에 내려주는 공휴일 (공유 계약 PublicHoliday). _id는 날짜 */
export interface PublicHolidayView {
    _id: string;
    name: string;
    hidden: boolean;
}

/** 앱에 내려주는 내 제외일 */
export interface CustomHolidayView {
    _id: string;
    name: string;
    date: string;
}

type CustomLean = CustomHoliday & { _id: Types.ObjectId };

const NOT_FOUND = { code: 'NOT_FOUND', message: '존재하지 않는 제외일입니다.' };
const SOURCE_PUBLIC_API = 'public_api'; // public_holidays.source 값

@Injectable()
export class HolidaysService {
    private readonly logger = new Logger(HolidaysService.name);

    constructor(
        @InjectModel(PublicHoliday.name) private readonly publicModel: Model<PublicHoliday>,
        @InjectModel(HiddenHoliday.name) private readonly hiddenModel: Model<HiddenHoliday>,
        @InjectModel(CustomHoliday.name) private readonly customModel: Model<CustomHoliday>,
        private readonly source: HolidaySource,
    ) { }

    /** 그 해 공휴일 + 내가 숨겼는지. year를 안 주면 서울 기준 올해. 저장된 게 없으면 한 번 받아 와서 저장한다 */
    async list(userId: string, year?: number): Promise<PublicHolidayView[]> {
        const y = year ?? Number(seoulDate(new Date()).slice(0, 4));
        const items = await this.yearItems(y);
        const hidden = await this.hiddenDates(userId, `${y}-01-01`, `${y}-12-31`);
        return items.map((item) => ({ _id: item.date, name: item.name, hidden: hidden.has(item.date) }));
    }

    /** 공휴일 하나를 내 캘린더에서 숨기거나 다시 보이게 한다 */
    async setHidden(userId: string, date: string, hidden: boolean): Promise<void> {
        const owner = new Types.ObjectId(userId);
        if (hidden) {
            await this.hiddenModel.updateOne({ userId: owner, date }, { $setOnInsert: { userId: owner, date } }, { upsert: true });
        } else {
            await this.hiddenModel.deleteOne({ userId: owner, date });
        }
    }

    /** 내 제외일 목록 (만든 순서. 앱의 기기 저장 모드와 같다) */
    async customList(userId: string): Promise<CustomHolidayView[]> {
        const docs = await this.customModel
            .find({ userId: new Types.ObjectId(userId) })
            .sort({ createdAt: 1, _id: 1 })
            .lean<CustomLean[]>();
        return docs.map(toCustomView);
    }

    async customAdd(userId: string, dto: CreateCustomHolidayDto): Promise<CustomHolidayView> {
        const [created] = await this.customModel.create([{ userId: new Types.ObjectId(userId), name: dto.name, date: dto.date }]);
        if (!created) throw new Error('제외일이 만들어지지 않았습니다.');
        return toCustomView(created.toObject() as unknown as CustomLean);
    }

    /** 내 제외일을 지운다. 남의 것이거나 없으면 404 */
    async customRemove(userId: string, id: string): Promise<void> {
        const result = Types.ObjectId.isValid(id)
            ? await this.customModel.deleteOne({ _id: new Types.ObjectId(id), userId: new Types.ObjectId(userId) })
            : { deletedCount: 0 };
        if (result.deletedCount === 0) throw new NotFoundException(NOT_FOUND);
    }

    /**
     * 이 사용자가 [startDate, endDate](서울 기준 'YYYY-MM-DD', 양 끝 포함) 동안 건너뛸 날짜 목록(오름차순, 중복 없음):
     * 내가 숨기지 않은 공휴일 + 내 제외일. 반복 목표 판정(FR-12-04)이 쓸 함수이고, 판정은 여기서 하지 않는다
     */
    async skipDates(userId: string, startDate: string, endDate: string): Promise<string[]> {
        if (startDate > endDate) return [];
        const hidden = await this.hiddenDates(userId, startDate, endDate);
        const dates = new Set<string>();
        for (let y = Number(startDate.slice(0, 4)); y <= Number(endDate.slice(0, 4)); y++) {
            for (const item of await this.yearItems(y)) {
                if (item.date >= startDate && item.date <= endDate && !hidden.has(item.date)) dates.add(item.date);
            }
        }
        const customs = await this.customModel
            .find({ userId: new Types.ObjectId(userId), date: { $gte: startDate, $lte: endDate } }, { date: 1 })
            .lean<{ date: string }[]>();
        for (const c of customs) dates.add(c.date);
        return [...dates].sort();
    }

    private async hiddenDates(userId: string, from: string, to: string): Promise<Set<string>> {
        const docs = await this.hiddenModel
            .find({ userId: new Types.ObjectId(userId), date: { $gte: from, $lte: to } }, { date: 1 })
            .lean<{ date: string }[]>();
        return new Set(docs.map((doc) => doc.date));
    }

    /** 저장된 그 해 공휴일(_id가 날짜라 범위로 찾는다). 없으면 외부에서 받아 저장하고, 그것도 안 되면 고정 공휴일 */
    private async yearItems(year: number): Promise<HolidayItem[]> {
        const stored = await this.publicModel
            .find({ _id: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } }, { name: 1 })
            .sort({ _id: 1 })
            .lean<{ _id: string; name: string }[]>();
        if (stored.length > 0) return stored.map((doc) => ({ date: doc._id, name: doc.name }));
        return this.load(year);
    }

    /** 외부에서 받아 저장한다. 못 받으면(키 없음 · 호출 실패) 날짜가 고정인 공휴일만 임시로 보여 주고 저장은 하지 않는다 */
    private async load(year: number): Promise<HolidayItem[]> {
        let fetched: HolidayItem[] | null = null;
        try {
            fetched = await this.source.fetchYear(year);
        } catch (error) {
            this.logger.warn(`${year}년 공휴일 호출 오류 (${error instanceof Error ? error.name : 'unknown'})`);
        }
        if (!fetched || fetched.length === 0) {
            this.logger.warn(`${year}년 공휴일을 받지 못해 고정 공휴일만 사용합니다.`);
            return fixedHolidays(year);
        }
        try {
            // 동시에 두 요청이 와도 날짜가 겹치지 않게 upsert로 넣는다
            await this.publicModel.bulkWrite(
                fetched.map((item) => ({
                    updateOne: {
                        filter: { _id: item.date },
                        update: { $setOnInsert: { name: item.name, source: SOURCE_PUBLIC_API, createdAt: new Date() } },
                        upsert: true,
                    },
                })),
            );
        } catch (error) {
            this.logger.warn(`${year}년 공휴일을 저장하지 못했습니다 (${error instanceof Error ? error.name : 'unknown'})`);
        }
        return fetched;
    }
}

function toCustomView(doc: CustomLean): CustomHolidayView {
    return { _id: doc._id.toString(), name: doc.name, date: doc.date };
}
