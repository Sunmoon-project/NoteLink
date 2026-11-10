import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { type Connection, Model, Types } from 'mongoose';

import { QuizAttempt, type QuizAttemptDocument } from './schemas/quiz-attempt.schema.js';
import { QuizSet, type QuizSetDocument } from './schemas/quiz-set.schema.js';

/** 세트 · 풀이 · 문제가 없거나 남의 것일 때 (packages/shared ERROR_CODES.NOT_FOUND) */
const NOT_FOUND = 'NOT_FOUND';
/** 요청을 지금 상태에서 받을 수 없을 때 (packages/shared ERROR_CODES.VALIDATION) */
const VALIDATION_FAILED = 'VALIDATION_FAILED';
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/** 앱에 보내는 풀이 한 건 (packages/shared QuizAttempt). id 필드 이름은 공용 계약대로 _id */
export interface AppQuizAttempt {
    _id: string;
    quizSetId: string;
    correctCount: number;
    total: number;
    pointsEarned: number;
    answers: { questionId: string; answer: string | null; correct: boolean; tries: number }[];
    startedAt: string;
    finishedAt: string | null;
}

/** 답을 낸 결과 */
export interface AnswerResult {
    correct: boolean;
    correctAnswer: string;
}

interface AttemptRow {
    _id: Types.ObjectId;
    answers?: { questionId: Types.ObjectId; answer?: string | null; correct: boolean; tries: number }[];
    finishedAt?: Date | null;
}

interface SetRow {
    status: string;
    questions?: { _id: Types.ObjectId; answer: string }[];
}

const notFound = (what: string) => new NotFoundException({ code: NOT_FOUND, message: `${what}을 찾을 수 없어요` });
const invalid = (message: string) => new BadRequestException({ code: VALIDATION_FAILED, message });

/** 앱이 보낸 id. 형식이 틀리면 없는 것과 같게 404 */
function objectId(id: string, what: string): Types.ObjectId {
    if (!OBJECT_ID.test(id)) throw notFound(what);
    return new Types.ObjectId(id);
}

@Injectable()
export class QuizAttemptsService {
    constructor(
        @InjectModel(QuizAttempt.name) private readonly attempts: Model<QuizAttemptDocument>,
        @InjectModel(QuizSet.name) private readonly sets: Model<QuizSetDocument>,
        @InjectConnection() private readonly connection: Connection,
    ) { }

    /** 내 퀴즈 세트로 풀이를 시작한다. 만드는 중이거나 실패한 세트(ready가 아닌 것)는 풀 수 없다 */
    async start(userId: string, quizSetId: string): Promise<AppQuizAttempt> {
        const owner = objectId(userId, '사용자');
        const set = await this.sets
            .findOne({ _id: objectId(quizSetId, '퀴즈'), ownerId: owner, deletedAt: null })
            .lean<SetRow & { _id: Types.ObjectId }>();
        if (!set) throw notFound('퀴즈');
        if (set.status !== 'ready') throw invalid('아직 풀 수 없는 퀴즈예요');

        const startedAt = new Date();
        const total = set.questions?.length ?? 0;
        const created = await this.attempts.create({
            quizSetId: set._id,
            userId: owner,
            correctCount: 0,
            total,
            pointsEarned: 0,
            answers: [],
            startedAt,
            finishedAt: null,
        });
        return {
            _id: String(created._id),
            quizSetId: set._id.toString(),
            correctCount: 0,
            total,
            pointsEarned: 0,
            answers: [],
            startedAt: startedAt.toISOString(),
            finishedAt: null,
        };
    }

    /**
     * 답을 채점해 저장한다. 저장된 정답과 글자 그대로 비교한다(앱의 로컬 모의 API와 같은 방식).
     * 같은 문제를 다시 내면 그 항목의 answer · correct를 바꾸고 tries를 1 올린다. correctCount는 answers에서 다시 센다.
     *
     * 같은 풀이에 거의 동시에 답이 들어와도 한 문제의 답이 하나만 남도록 "읽기 → 계산 → 풀이 문서 쓰기"를
     * 한 트랜잭션으로 묶는다. 두 요청이 같은 문서를 고치면 한쪽이 쓰기 충돌로 처음부터 다시 시도되고,
     * 그때는 먼저 들어간 답을 읽어 tries를 이어서 올린다
     */
    async answer(userId: string, attemptId: string, questionId: string, answer: string): Promise<AnswerResult> {
        const owner = objectId(userId, '사용자');
        const attemptOid = objectId(attemptId, '풀이 기록');
        // IsMongoId는 대문자 16진수도 받으므로 소문자 표준형으로 바꿔 비교한다(Codex #287)
        const questionKey = objectId(questionId, '문제').toHexString();
        return this.connection.transaction(async (session) => {
            const row = await this.attempts
                .findOne({ _id: attemptOid, userId: owner }, null, { session })
                .lean<AttemptRow & { quizSetId: Types.ObjectId }>();
            if (!row) throw notFound('풀이 기록');
            if (row.finishedAt) throw invalid('이미 끝낸 풀이예요');

            const set = await this.sets
                .findOne({ _id: row.quizSetId, ownerId: owner, deletedAt: null }, null, { session })
                .lean<SetRow>();
            const question = set?.questions?.find((q) => q._id.toString() === questionKey);
            if (!question) throw notFound('문제');

            const correct = question.answer === answer;
            const questionOid = question._id;
            const before = row.answers ?? [];
            const found = before.find((a) => a.questionId.toString() === questionKey);
            const entry = { questionId: questionOid, answer, correct, tries: (found?.tries ?? 0) + 1 };
            const answers = found
                ? before.map((a) => (a === found ? entry : a))
                : [...before, entry];
            const correctCount = answers.filter((a) => a.correct).length;

            // 끝난 풀이는 고치지 않는다(조회와 쓰기 사이에 끝났으면 못 찾는다)
            const saved = await this.attempts
                .findOneAndUpdate(
                    { _id: attemptOid, userId: owner, finishedAt: null },
                    { $set: { answers, correctCount } },
                    { returnDocument: 'after', session },
                )
                .lean();
            if (!saved) throw invalid('이미 끝낸 풀이예요');
            return { correct, correctAnswer: question.answer };
        });
    }
}
