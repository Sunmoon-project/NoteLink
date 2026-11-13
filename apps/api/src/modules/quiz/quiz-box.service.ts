import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { toAppQuestion, type AppQuestion, type QuestionRow } from '../../quiz-sets/quiz-sets.service.js';
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
        @InjectModel(QuizSet.name) private readonly sets: Model<QuizSet>, // 읽기만 한다
    ) { }

    /** 내 보관함의 문제 (담은 순서, 정답 포함). 앱의 기기 저장 모드와 같다 */
    async box(userId: string): Promise<AppQuestion[]> {
        const owner = new Types.ObjectId(userId);
        const rows = await this.items.find({ userId: owner }).sort({ savedAt: 1, _id: 1 }).lean<BoxRow[]>();
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

            const now = Date.now();
            for (const [index, id] of ids.entries()) {
                const questionId = new Types.ObjectId(id);
                try {
                    // 이미 담긴 문제는 그대로 둔다 (담은 시각 · 순서가 바뀌지 않는다)
                    await this.items.updateOne(
                        { userId: owner, questionId },
                        { $setOnInsert: { userId: owner, questionId, quizSetId: setOf.get(id)!, savedAt: new Date(now + index) } },
                        { upsert: true },
                    );
                } catch (e) {
                    if ((e as { code?: number } | null)?.code !== DUPLICATE_KEY) throw e; // 동시에 담은 다른 요청이 먼저 넣었다
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
