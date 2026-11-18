import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { Timetable } from '../src/modules/calendar/schemas/timetable.schema.js';
import { TimetableShare } from '../src/modules/calendar/schemas/timetable-share.schema.js';
import { Friendship } from '../src/modules/social/schemas/friendship.schema.js';
import { TimetableController } from '../src/modules/timetable/timetable.controller.js';
import { TimetableService } from '../src/modules/timetable/timetable.service.js';
import { TEST_USER_ID } from './shop-test-app.js';

// shop-test-app.ts의 AUTH 헤더("Bearer test-token")와 같은 토큰만 통과시킨다
const TEST_TOKEN = 'test-token';

/** 진짜 DB 대신 가짜 모델을 넣은 시간표 테스트용 서버 */
export async function createTimetableTestApp(fakes: {
    timetable: object;
    share: object;
    friendship: object;
}): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
        controllers: [TimetableController],
        providers: [
            TimetableService,
            { provide: getModelToken(Timetable.name), useValue: fakes.timetable },
            { provide: getModelToken(TimetableShare.name), useValue: fakes.share },
            { provide: getModelToken(Friendship.name), useValue: fakes.friendship },
            // 로그인 확인(JwtAuthGuard)이 쓰는 도구의 가짜: TEST_TOKEN만 통과시킨다
            {
                provide: TokenService,
                useValue: {
                    verifyAccess: (token: string) =>
                        token === TEST_TOKEN
                            ? Promise.resolve({ userId: TEST_USER_ID })
                            : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                },
            },
        ],
    }).compile();

    const app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    return app;
}
