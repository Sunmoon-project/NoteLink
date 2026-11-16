import {
  Controller,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { isValidObjectId, Model, Types } from 'mongoose';

import { type AuthenticatedRequest, JwtAuthGuard } from '../modules/auth/jwt-auth.guard.js';
import { QuizSet, type QuizSetDocument } from '../modules/quiz/schemas/quiz-set.schema.js';
import { NOT_FOUND, type QuestionRow } from './quiz-sets.service.js';

const noQuestion = () =>
  new NotFoundException({ code: NOT_FOUND, message: '문제를 찾을 수 없어요' });

/**
 * 문제 해설(GET /questions/:id/explanation). 문제를 만들 때 처리기가 쓴 해설(questions.explanation)을
 * 돌려준다. 해설을 새로 만드는 AI 작업(explain)은 아직 처리기에 없어, 해설이 없는 문제는 정답과 함께
 * 아직 해설이 없다고 알린다. 지운 세트의 문제도 보관함에 남아 있을 수 있어 지움 여부는 보지 않는다
 */
@Injectable()
export class ExplanationsService {
  constructor(@InjectModel(QuizSet.name) private readonly sets: Model<QuizSetDocument>) {}

  async explain(userId: string, questionId: string): Promise<{ text: string }> {
    if (!isValidObjectId(questionId) || !isValidObjectId(userId)) throw noQuestion();
    const qid = new Types.ObjectId(questionId);
    const set = await this.sets
      .findOne(
        { ownerId: new Types.ObjectId(userId), 'questions._id': qid },
        { questions: { $elemMatch: { _id: qid } } },
      )
      .lean<{ _id: Types.ObjectId; questions?: QuestionRow[] }>();
    const q = set?.questions?.[0];
    if (!q) throw noQuestion();
    const text = q.explanation?.trim();
    return {
      text: text || `정답은 「${q.answer}」예요. 이 문제는 아직 해설이 없어요.`,
    };
  }
}

@Controller('questions')
@UseGuards(JwtAuthGuard)
export class ExplanationsController {
  constructor(private readonly explanations: ExplanationsService) {}

  @Get(':id/explanation')
  @Header('Cache-Control', 'no-store')
  async explanation(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ data: { text: string } }> {
    return { data: await this.explanations.explain(req.user!.userId, id) };
  }
}
