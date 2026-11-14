import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { type Connection, Model, Types } from 'mongoose';

import { toAppQuestion, type AppQuestion, type QuestionRow } from '../../quiz-sets/quiz-sets.service.js';
import { QuizBoxCounter } from './schemas/quiz-box-counter.schema.js';
import { QuizBoxItem } from './schemas/quiz-box-item.schema.js';
import { QuizSet } from './schemas/quiz-set.schema.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const NOT_FOUND = { code: 'NOT_FOUND', message: '보관할 문제를 찾을 수 없어요' };

interface SetQuestions {
    _id: Types.ObjectId;
    questions?: QuestionRow[];
}
interface BoxRow {
    questionId: Types.ObjectId;
    quizSetId: Types.ObjectId;
}

/** 퀴즈 보관함 (FR-57 · 58): 내 퀴즈 세트의 문제를 담고, 보고, 지운다 */
@Injectable()
export class QuizBoxService {
    constructor(
        @InjectModel(QuizBoxItem.name) private readonly items: Model<QuizBoxItem>,
        @InjectModel(QuizBoxCounter.name) private readonly counters: Model<QuizBoxCounter>,
        @InjectModel(QuizSet.name) private readonly sets: Model<QuizSet>, // 읽기만 한다
        @InjectConnection() private readonly connection: Connection,
    ) { }

    /**
     * 내 보관함의 문제 (담은 순서, 정답 포함). 앱의 기기 저장 모드(먼저 담은 것이 앞)와 같다.
     * order 순이고, order가 없는 옛 문서는 맨 앞에 savedAt 순으로 온다(없는 값은 숫자보다 앞에 정렬된다)
     */
    async box(userId: string): Promise<AppQuestion[]> {
        const owner = new Types.ObjectId(userId);
        const rows = await this.items.find({ userId: owner }).sort({ order: 1, savedAt: 1, _id: 1 }).lean<BoxRow[]>();
        if (rows.length === 0) return [];
        // 세트를 지워도(deletedAt) 문제 자체는 남아 있어서 보관함에는 계속 보인다
        const sets = await this.sets
            .find({ _id: { $in: [...new Set(rows.map((r) => r.quizSetId.toString()))].map((id) => new Types.ObjectId(id)) }, ownerId: owner })
            .lean<SetQuestions[]>();
        const byId = new Map<string, QuestionRow>();
        for (const set of sets) for (const q of set.questions ?? []) byId.set(q._id.toString(), q);
        const result: AppQuestion[] = [];
        for (const row of rows) {
            const q = byId.get(row.questionId.toString());
            if (q) result.push(toAppQuestion(q)); // 문제가 사라진 항목은 건너뛴다
        }
        return result;
    }

    /**
     * 문제를 보관함에 담고 보관함 전체를 돌려준다. 같은 문제는 한 건만 남고(동시에 담아도), 겹치는 동시 요청도 요청 안의 순서를 지킨다.
     * 내 세트에 없는 문제(남의 세트 · 없는 id · 형식이 틀린 id)가 하나라도 있으면 아무것도 담지 않고 404
     */
    async save(userId: string, questionIds: string[]): Promise<AppQuestion[]> {
        const owner = new Types.ObjectId(userId);
        const ids = [...new Set(questionIds.map((id) => id.toLowerCase()))]; // 대문자로 보내도 같은 문제로 센다
        if (ids.some((id) => !OBJECT_ID.test(id))) throw new NotFoundException(NOT_FOUND);
        const wanted = new Set(ids);
        if (wanted.size > 0) {
            const sets = await this.sets
                .find({ ownerId: owner, deletedAt: null, 'questions._id': { $in: ids.map((id) => new Types.ObjectId(id)) } }, { questions: 1 })
                .lean<SetQuestions[]>();
            const setOf = new Map<string, Types.ObjectId>();
            for (const set of sets) for (const q of set.questions ?? []) if (wanted.has(q._id.toString())) setOf.set(q._id.toString(), set._id);
            if (ids.some((id) => !setOf.has(id))) throw new NotFoundException(NOT_FOUND);

            // 기존 항목 확인 · 번호 배정 · 삽입을 한 트랜잭션으로 묶는다. 같은 사람의 카운터 문서를 함께 쓰므로 겹치는 요청은
            // 쓰기 충돌로 다시 시도되고, 다시 시도된 쪽은 먼저 끝난 요청이 넣은 문제를 "이미 담긴 문제"로 보고 번호를 받지 않는다
            // (번호만 먼저 받고 삽입이 뒤바뀌어 순서가 역전되는 일이 없다)
            await this.connection.transaction(async (session) => {
                // 이미 담긴 문제는 그대로 둔다(담은 시각 · 순서 번호가 바뀌지 않는다). 새 문제만 번호를 받는다
                const existing = await this.items
                    .find({ userId: owner, questionId: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { questionId: 1 }, { session })
                    .lean<{ questionId: Types.ObjectId }[]>();
                const have = new Set(existing.map((e) => e.questionId.toString()));
                const fresh = ids.filter((id) => !have.has(id));
                if (fresh.length === 0) return;
                // 새로 담을 개수만큼 번호 묶음을 한 번에 받는다 → 이 요청의 문제들은 이어진 번호라 다른 요청과 섞이지 않는다
                const counter = await this.counters
                    .findOneAndUpdate({ _id: owner }, { $inc: { seq: fresh.length } }, { upsert: true, returnDocument: 'after', session })
                    .lean<{ seq: number }>();
                const first = counter!.seq - fresh.length + 1;
                const savedAt = new Date();
                await this.items.bulkWrite(
                    fresh.map((id, index) => {
                        const questionId = new Types.ObjectId(id);
                        return {
                            updateOne: {
                                filter: { userId: owner, questionId },
                                update: { $setOnInsert: { userId: owner, questionId, quizSetId: setOf.get(id)!, savedAt, order: first + index } },
                                upsert: true,
                            },
                        };
                    }),
                    { ordered: false, session },
                );
            });
        }
        return this.box(userId);
    }

    /** 내 보관함에서 문제를 뺀다. 보관함에 없는 문제 · 형식이 틀린 id는 앱처럼 그냥 넘어가고, 남의 보관함은 건드리지 않는다 */
    async remove(userId: string, questionIds: string[]): Promise<void> {
        const ids = [...new Set(questionIds.map((id) => id.toLowerCase()))].filter((id) => OBJECT_ID.test(id)).map((id) => new Types.ObjectId(id));
        if (ids.length === 0) return;
        await this.items.deleteMany({ userId: new Types.ObjectId(userId), questionId: { $in: ids } });
    }
}
