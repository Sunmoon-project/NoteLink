import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

// 내장 문서: Question (공용 스키마 Question을 따름)
@Schema()
export class Question {
  @Prop({ type: Types.ObjectId, auto: true })
  _id: Types.ObjectId;

  @Prop({ required: true, type: Number, default: 0 })
  order: number;

  @Prop({ required: true, type: String, enum: ['multiple_choice', 'short_answer', 'ox'] })
  type: string;

  @Prop({ required: true, type: String })
  prompt: string;

  // 빈칸 · 문장 문제의 지문(처리기 결과 passage). 공용 스키마에는 없어 앱에는 prompt 뒤에 붙여 보낸다
  @Prop({ type: String, default: null })
  passage?: string | null;

  // 처리기가 정한 문제 갈래('빈칸' · '어휘' · '정의' 등). 다음 퀴즈를 만들 때 처리기에 다시 넘긴다
  @Prop({ type: String, default: null })
  category?: string | null;

  // 객관식이 아니면 null
  @Prop({ type: [String], default: null })
  choices?: string[] | null;

  @Prop({ required: true })
  answer: string;

  @Prop({ type: String, default: null })
  explanation?: string | null;

  @Prop({ type: [String], default: [] })
  conceptTags: string[];

  // 난이도 '하' · '중' · '상'(공용 스키마 QuestionDifficulty, #268). 처리기가 유형으로 정한 처음 값이고,
  // 난이도를 붙이기 전에 만든 문제는 null. 다음 퀴즈를 만들 때 처리기에 다시 넘긴다
  @Prop({ type: String, enum: ['하', '중', '상'], default: null })
  difficulty?: '하' | '중' | '상' | null;

  // 복습 상태(step · dueAt · lastResult · streak · reviews · state 등). 형식은 처리기(apps/ai srs.py)가 정하고,
  // 오답 복습(similar_quiz)의 srsUpdates를 NestJS가 여기에 반영한다. 공용 스키마에는 아직 없다.
  @Prop({ type: Object, default: null })
  srs?: Record<string, unknown> | null;

  // srs를 쓴 오답 복습 세트를 만든 시각. 더 새 세트의 상태만 덮어써, 늦게 옮긴 오래된 결과가 되돌리지 않게 한다
  @Prop({ type: Date, default: undefined })
  srsAt?: Date;
}

export const QuestionSchema = SchemaFactory.createForClass(Question);

// 메인 스키마: quiz_sets (공용 스키마 QuizSet을 따름)
export type QuizSetDocument = HydratedDocument<QuizSet>;

@Schema({ collection: 'quiz_sets', timestamps: true })
export class QuizSet {
  @Prop({ type: Types.ObjectId, ref: 'Material' })
  materialId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Folder' })
  folderId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'User', required: true })
  ownerId: Types.ObjectId;

  @Prop({ required: true, type: String, enum: ['ai_generated', 'manual'] })
  source: string;

  @Prop({ type: Types.ObjectId, ref: 'QuizSet', default: null })
  sourceSetId?: Types.ObjectId | null;

  // 유사 퀴즈(다시 보기) 세트를 만든 풀이. 오답 복습은 만들 때마다 복습 상태를 옮기므로 한 풀이에 한 번만 만든다
  @Prop({ type: Types.ObjectId, ref: 'QuizAttempt', default: null })
  sourceAttemptId?: Types.ObjectId | null;

  // 오답 복습 결과의 복습 상태(srsUpdates)를 다 옮긴 시각. 옮긴 세트는 다시 쓰지 않는다
  @Prop({ type: Date, default: null })
  srsSavedAt?: Date | null;

  // 오답 복습 결과를 옮긴 뒤 이어 받을 풀이(그 사이 같은 퀴즈를 또 끝낸 풀이)를 아직 넣지 못했으면 true.
  // 세트 조회가 다시 넣어 보고 지운다(QuizSetsService.followUp)
  @Prop({ type: Boolean, default: false })
  followUpPending?: boolean;

  // 맞춤 퀴즈 · 미리 만들기 세트가 ready가 된 뒤 개념 카드 작업(quiz_flashcards, #558)을 아직 넣지 못했으면 true.
  // ready로 바꾸는 갱신에 같이 적고, 세트 조회가 넣어 보고 지운다(QuizSetsService.ensureCards). 앱에는 보내지 않는다.
  // 이 필드가 없는 기존 문서는 false로 본다
  @Prop({ type: Boolean, default: false })
  cardsPending?: boolean;

  // 오늘의 복습 세트의 날짜(서울 YYYY-MM-DD). 하루에 한 번만 만든다. 다른 세트는 null
  @Prop({ type: String, default: null })
  reviewDay?: string | null;

  @Prop({ required: true, type: String })
  title: string;

  // 공용 스키마의 status는 'generating' | 'ready' | 'failed' 문자열이다.
  @Prop({
    required: true,
    type: String,
    enum: ['generating', 'ready', 'failed'],
    default: 'generating',
  })
  status: string;

  @Prop({ required: true, type: Number, default: 0 })
  progress: number;

  @Prop({ required: true, type: Number, default: 0 })
  questionCount: number;

  @Prop({ type: [QuestionSchema], default: [] })
  questions: Question[];

  // 문제를 만드는 AI 작업(ai_jobs). 미리 만들기를 이어받으면 그 작업(targetType 'material')을 가리킨다(#175)
  @Prop({ type: Types.ObjectId, ref: 'AiJob', default: null })
  jobId?: Types.ObjectId | null;

  @Prop({ type: Date, default: null })
  deletedAt?: Date | null;
}

export const QuizSetSchema = SchemaFactory.createForClass(QuizSet);
// 노트마다 만드는 중인 세트는 하나(#175). 퀴즈를 거의 동시에 두 번 요청해도 같은 퀴즈를 두 번 만들지 않는다.
// 지운 세트는 세지 않는다(QuizSetsService.generatingSet의 deletedAt: null). 부분 색인 조건은 { $ne: null }을
// 받지 않아 $type으로 쓴다. $type은 deletedAt 필드가 없는 문서는 세지 않으므로, 세트를 만들 때 deletedAt을
// null로 꼭 넣는다(QuizSetsService.createOnce · 스키마 기본값)
QuizSetSchema.index(
  { ownerId: 1, materialId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'generating', deletedAt: { $type: 'null' } },
  },
);
// 오늘의 복습은 사용자 · 날짜마다 하나(TodayReviewService.start). 동시 요청이 둘 다 「오늘 세트 없음」을 읽어도
// 늦은 쪽의 생성은 이 색인에 막혀 먼저 만든 세트를 돌려준다. 닫은(지운) 세트는 세지 않아 실패한 날은 다시 만든다
QuizSetSchema.index(
  { ownerId: 1, reviewDay: 1 },
  {
    unique: true,
    partialFilterExpression: { reviewDay: { $type: 'string' }, deletedAt: { $type: 'null' } },
  },
);
// 내 퀴즈 세트 목록(최근 것부터)
QuizSetSchema.index({ ownerId: 1, createdAt: -1 });
