import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { CalendarController } from '../src/modules/calendar/calendar.controller.js';
import { CalendarService } from '../src/modules/calendar/calendar.service.js';
import { Todo } from '../src/modules/calendar/schemas/todo.schema.js';
import { Subject } from '../src/modules/session/schemas/subject.schema.js';
import { TEST_USER_ID } from './shop-test-app.js';

// shop-test-app.ts의 AUTH 헤더("Bearer test-token")와 같은 토큰만 통과시킨다
const TEST_TOKEN = 'test-token';

/** 진짜 DB 대신 가짜 모델을 넣은 할 일 · D-day 테스트용 서버 */
export async function createCalendarTestApp(fakes: { todo: object; subject: object }): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
        controllers: [CalendarController],
        providers: [
            CalendarService,
            { provide: getModelToken(Todo.name), useValue: fakes.todo },
            { provide: getModelToken(Subject.name), useValue: fakes.subject },
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
