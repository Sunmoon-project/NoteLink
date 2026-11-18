import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { PointService } from '../src/modules/reward/point/point.service.js';
import { DailyRecord } from '../src/modules/progress/schemas/daily-record.schema.js';
import { StudySession } from '../src/modules/session/schemas/study-session.schema.js';
import { Subject } from '../src/modules/session/schemas/subject.schema.js';
import { StudySessionsController } from '../src/modules/session/study-sessions.controller.js';
import { StudyController } from '../src/modules/session/study.controller.js';
import { StudyService } from '../src/modules/session/study.service.js';
import { SubjectsController } from '../src/modules/session/subjects.controller.js';
import { TEST_USER_ID } from './shop-test-app.js';

// shop-test-app.ts의 AUTH 헤더("Bearer test-token")와 같은 토큰만 통과시킨다
const TEST_TOKEN = 'test-token';

/** 진짜 DB 대신 가짜 모델·트랜잭션·포인트를 넣은 공부 기록 테스트용 서버 */
export async function createSessionTestApp(fakes: {
    studySession: object;
    dailyRecord: object;
    subject: object;
    connection: object;
    points: object;
}): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
        controllers: [StudyController, SubjectsController, StudySessionsController],
        providers: [
            StudyService,
            { provide: PointService, useValue: fakes.points },
            { provide: getModelToken(StudySession.name), useValue: fakes.studySession },
            { provide: getModelToken(DailyRecord.name), useValue: fakes.dailyRecord },
            { provide: getModelToken(Subject.name), useValue: fakes.subject },
            { provide: getConnectionToken(), useValue: fakes.connection },
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
