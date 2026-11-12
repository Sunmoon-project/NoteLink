import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { GoalsController } from '../src/modules/progress/goals.controller.js';
import { ProgressService } from '../src/modules/progress/progress.service.js';
import { DailyRecord } from '../src/modules/progress/schemas/daily-record.schema.js';
import { StudySession } from '../src/modules/session/schemas/study-session.schema.js';
import { WeeklyGoal } from '../src/modules/progress/schemas/weekly-goal.schema.js';
import { StudyProgressController } from '../src/modules/progress/study-progress.controller.js';
import { TEST_USER_ID } from './shop-test-app.js';

// shop-test-app.ts의 AUTH 헤더("Bearer test-token")와 같은 토큰만 통과시킨다
const TEST_TOKEN = 'test-token';

/** 진짜 DB 대신 가짜 모델을 넣은 이번 주 목표·요약 테스트용 서버 */
export async function createProgressTestApp(fakes: {
    dailyRecord: object;
    weeklyGoal: object;
    studySession?: object;
}): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
        controllers: [GoalsController, StudyProgressController],
        providers: [
            ProgressService,
            { provide: getModelToken(DailyRecord.name), useValue: fakes.dailyRecord },
            { provide: getModelToken(WeeklyGoal.name), useValue: fakes.weeklyGoal },
            { provide: getModelToken(StudySession.name), useValue: fakes.studySession ?? {} },
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
