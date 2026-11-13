import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { toAppQuestion, type AppQuestion, type QuestionRow } from '../../quiz-sets/quiz-sets.service.js';
import { QuizBoxCounter } from './schemas/quiz-box-counter.schema.js';
import { QuizBoxItem } from './schemas/quiz-box-item.schema.js';
import { QuizSet } from './schemas/quiz-set.schema.js';

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const DUPLICATE_KEY = 11000;
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
     * 문제를 보관함에 담고 보관함 전체를 돌려준다. 같은 문제는 한 건만 남는다(동시에 담아도).
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

            // 이미 담긴 문제는 그대로 둔다(담은 시각 · 순서 번호가 바뀌지 않는다). 새 문제만 번호를 받는다
            const existing = await this.items.find({ userId: owner, questionId: { $in: ids.map((id) => new Types.ObjectId(id)) } }, { questionId: 1 }).lean<{ questionId: Types.ObjectId }[]>();
            const have = new Set(existing.map((e) => e.questionId.toString()));
            const fresh = ids.filter((id) => !have.has(id));
            if (fresh.length > 0) {
                // 새로 담을 개수만큼 번호 묶음을 한 번에 받는다 → 이 요청의 문제들은 이어진 번호라 다른 요청과 섞이지 않는다
                const counter = await this.counters
                    .findOneAndUpdate({ _id: owner }, { $inc: { seq: fresh.length } }, { upsert: true, returnDocument: 'after' })
                    .lean<{ seq: number }>();
                const first = counter!.seq - fresh.length + 1;
                const savedAt = new Date();
                try {
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
                        { ordered: false }, // 겹친 문제 때문에 실패해도 나머지는 계속 담는다
                    );
                } catch (e) {
                    if (!onlyDuplicateKey(e)) throw e; // 동시에 담은 다른 요청이 먼저 넣은 문제만 겹친 것이면 괜찮다(유일 인덱스로 한 건만 남는다)
                }
            }
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

/** 일괄 저장이 "같은 문제를 동시에 담아 유일 인덱스에 걸린" 오류로만 실패했는지 */
function onlyDuplicateKey(e: unknown): boolean {
    const err = e as { code?: number; writeErrors?: { code?: number; err?: { code?: number } }[] } | null;
    if (err?.writeErrors?.length) return err.writeErrors.every((w) => (w.code ?? w.err?.code) === DUPLICATE_KEY);
    return err?.code === DUPLICATE_KEY;
}
