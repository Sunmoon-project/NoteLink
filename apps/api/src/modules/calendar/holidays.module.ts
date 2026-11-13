import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module.js';
import { HolidaySource, KasiHolidaySource } from './holiday-source.js';
import { HolidaysController } from './holidays.controller.js';
import { HolidaysService } from './holidays.service.js';
import { CustomHoliday, CustomHolidaySchema } from './schemas/custom-holiday.schema.js';
import { HiddenHoliday, HiddenHolidaySchema } from './schemas/hidden-holiday.schema.js';
import { HolidayFetch, HolidayFetchSchema } from './schemas/holiday-fetch.schema.js';
import { PublicHoliday, PublicHolidaySchema } from './schemas/public-holiday.schema.js';

// 공휴일 · 사용자 제외일 (FR-12). 할 일 · D-day의 CalendarModule과는 따로 둔다
@Module({
    imports: [
        MongooseModule.forFeature([
            { name: PublicHoliday.name, schema: PublicHolidaySchema },
            { name: HolidayFetch.name, schema: HolidayFetchSchema },
            { name: HiddenHoliday.name, schema: HiddenHolidaySchema },
            { name: CustomHoliday.name, schema: CustomHolidaySchema },
        ]),
        AuthModule, // 로그인 확인(JwtAuthGuard)에 필요한 도구를 가져온다
    ],
    controllers: [HolidaysController],
    // 공휴일 원본은 공공데이터포털. 테스트에서는 HolidaySource를 가짜로 바꿔 끼운다
    providers: [HolidaysService, { provide: HolidaySource, useClass: KasiHolidaySource }],
    exports: [HolidaysService], // 반복 목표 판정(FR-12-04)이 건너뛸 날짜를 물어볼 때 쓴다
})
export class HolidaysModule { }
