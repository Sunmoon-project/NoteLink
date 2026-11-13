import type { INestApplication } from '@nestjs/common';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Types, type Model } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../src/app.setup.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { QuizBoxController } from '../src/modules/quiz/quiz-box.controller.js';
import { QuizBoxService } from '../src/modules/quiz/quiz-box.service.js';
import type { QuizBoxItem } from '../src/modules/quiz/schemas/quiz-box-item.schema.js';
import type { QuizSet } from '../src/modules/quiz/schemas/quiz-set.schema.js';

const ME = new Types.ObjectId();
const AUTH = { Authorization: 'Bearer token-me' };
const ID = new Types.ObjectId().toString();

describe('퀴즈 보관함 API 주소 · 입력 검증', () => {
    const fake = {
        box: vi.fn().mockResolvedValue([]),
        save: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue(undefined),
    };
    let app: INestApplication;

    beforeAll(async () => {
        const moduleRef = await Test.createTestingModule({
            controllers: [QuizBoxController],
            providers: [
                { provide: QuizBoxService, useValue: fake },
                {
                    provide: TokenService,
                    useValue: {
                        verifyAccess: (t: string) =>
                            t === 'token-me'
                                ? Promise.resolve({ userId: ME.toString() })
                                : Promise.reject(new UnauthorizedException({ code: 'AUTH_TOKEN_EXPIRED', message: 'x' })),
                    },
                },
            ],
        }).compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
    });
    afterAll(async () => app.close());

    const http = () => request(app.getHttpServer());

    it('로그인 없이는 401', async () => {
        expect((await http().get('/api/v1/quiz-box')).status).toBe(401);
        expect((await http().post('/api/v1/quiz-box').send({ questionIds: [] })).status).toBe(401);
        expect((await http().post('/api/v1/quiz-box/delete').send({ questionIds: [] })).status).toBe(401);
    });

    it('앱이 부르는 3개: GET 200, POST 담기 200, POST /delete 204', async () => {
        expect((await http().get('/api/v1/quiz-box').set(AUTH)).status).toBe(200);
        expect((await http().post('/api/v1/quiz-box').set(AUTH).send({ questionIds: [ID] })).status).toBe(200);
        expect(fake.save).toHaveBeenCalledWith(ME.toString(), [ID]);
        expect((await http().post('/api/v1/quiz-box/delete').set(AUTH).send({ questionIds: [ID] })).status).toBe(204);
        expect(fake.remove).toHaveBeenCalledWith(ME.toString(), [ID]);
    });

    it('questionIds가 배열의 문자열이 아니거나 너무 많거나 모르는 필드가 있으면 400', async () => {
        for (const body of [{}, { questionIds: 'a' }, { questionIds: [1] }, { questionIds: ['a'.repeat(101)] }, { questionIds: Array(201).fill(ID) }, { questionIds: [], x: 1 }]) {
            expect((await http().post('/api/v1/quiz-box').set(AUTH).send(body)).status).toBe(400);
            expect((await http().post('/api/v1/quiz-box/delete').set(AUTH).send(body)).status).toBe(400);
        }
    });
});

describe('QuizBoxService (가짜 모델)', () => {
    const itemsModel = { find: vi.fn(), updateOne: vi.fn(), deleteMany: vi.fn() };
    const setsModel = { find: vi.fn() };
    const svc = () => new QuizBoxService(itemsModel as unknown as Model<QuizBoxItem>, setsModel as unknown as Model<QuizSet>);

    it('담기: 형식이 틀린 id가 있으면 DB를 거치지 않고 404', async () => {
        await expect(svc().save(ME.toString(), [ID, 'not-an-id'])).rejects.toBeInstanceOf(NotFoundException);
        expect(setsModel.find).not.toHaveBeenCalled();
        expect(itemsModel.updateOne).not.toHaveBeenCalled();
    });

    it('담기: 내 세트에서 못 찾는 문제가 있으면 하나도 담지 않고 404', async () => {
        setsModel.find.mockReturnValue({ lean: () => Promise.resolve([]) });
        await expect(svc().save(ME.toString(), [ID])).rejects.toBeInstanceOf(NotFoundException);
        expect(itemsModel.updateOne).not.toHaveBeenCalled();
    });

    it('담기: 빈 목록은 아무것도 하지 않고 보관함만 돌려준다', async () => {
        setsModel.find.mockClear();
        itemsModel.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([]) }) });
        await expect(svc().save(ME.toString(), [])).resolves.toEqual([]);
        expect(setsModel.find).not.toHaveBeenCalled();
    });

    it('삭제: 형식이 틀린 id만 있으면 DB를 거치지 않고, 아니면 내 보관함에서만 지운다', async () => {
        await svc().remove(ME.toString(), ['not-an-id']);
        expect(itemsModel.deleteMany).not.toHaveBeenCalled();
        await svc().remove(ME.toString(), [ID, ID.toUpperCase(), 'bad']);
        expect(itemsModel.deleteMany).toHaveBeenCalledTimes(1);
        const [filter] = itemsModel.deleteMany.mock.calls[0]!;
        expect(filter.userId).toEqual(ME);
        expect(filter.questionId.$in).toHaveLength(1); // 대소문자만 다른 id는 하나로
    });
});
