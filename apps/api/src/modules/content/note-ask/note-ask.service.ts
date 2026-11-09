import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ERROR_CODES, NoteAskBody } from '@notelink/shared';
import { Model, Types } from 'mongoose';

import { type AppAiJob, AiJobsService, PENDING_LIMIT } from '../../../ai-jobs/ai-jobs.service.js';
import { Material } from '../schemas/material.schema.js';
import { QuizSet } from '../../quiz/schemas/quiz-set.schema.js';
import { Recording } from '../schemas/recording.schema.js';

/** 처리기에 넘기는 노트 글 최대 길이(apps/ai note/ask.py MAX_CONTEXT와 같음) */
export const MAX_CONTEXT = 12_000;
/** 한 사용자가 동시에 기다릴 수 있는 질문 수(AiJobsService PENDING_LIMIT) */
export const MAX_PENDING = PENDING_LIMIT.note_ask;

const OBJECT_ID = /^[0-9a-f]{24}$/i;
const notFound = () =>
  new NotFoundException({ code: ERROR_CODES.NOT_FOUND, message: '노트를 찾을 수 없어요' });

interface MaterialRow {
  _id: Types.ObjectId;
  kind: string;
  title: string;
  summary?: { sections?: { heading: string; body: string }[]; points?: string[] } | null;
  pages?: { pageNo: number; ocrText?: string | null }[];
}

interface QuizRow {
  prompt: string;
  answer: string;
  explanation?: string | null;
}

/**
 * 아바타가 답할 근거(학습 자료): 요약 → 핵심 → 퀴즈 → 쪽 글(OCR) → 녹음 대본 순으로 이어 붙여 자른다.
 * 정리된 내용이 앞이라 잘려도 뼈대는 남는다. 처리기는 이 글로만 답한다(apps/ai note/ask.py)
 */
export function noteContext(
  m: MaterialRow,
  transcript: string | null,
  quiz: QuizRow[] = [],
): string {
  const parts: string[] = [];
  for (const s of m.summary?.sections ?? []) parts.push(`## ${s.heading}\n${s.body}`);
  if (m.summary?.points?.length)
    parts.push(`## 핵심\n${m.summary.points.map((p) => `- ${p}`).join('\n')}`);
  if (quiz.length)
    parts.push(
      `## 퀴즈\n${quiz
        .map(
          (q) =>
            `Q. ${q.prompt}\n정답: ${q.answer}${q.explanation ? `\n해설: ${q.explanation}` : ''}`,
        )
        .join('\n')}`,
    );
  for (const p of m.pages ?? [])
    if (p.ocrText?.trim()) parts.push(`[${p.pageNo}쪽]\n${p.ocrText.trim()}`);
  if (transcript?.trim()) parts.push(`## 녹음 원문\n${transcript.trim()}`);
  return parts.join('\n\n').slice(0, MAX_CONTEXT);
}

/**
 * 아바타에게 노트 묻기: 본인 노트의 글을 모아 note_ask 작업으로 넣는다.
 * 앱은 돌려받은 작업을 /ai-jobs/:id로 기다렸다가 result(NoteAskResult)를 읽는다.
 */
@Injectable()
export class NoteAskService {
  constructor(
    @InjectModel(Material.name) private readonly materials: Model<Material>,
    @InjectModel(Recording.name) private readonly recordings: Model<Recording>,
    @InjectModel(QuizSet.name) private readonly quizSets: Model<QuizSet>,
    private readonly jobs: AiJobsService,
  ) {}

  async ask(userId: string, materialId: string, raw: unknown): Promise<AppAiJob> {
    const body = NoteAskBody.safeParse(raw);
    if (!body.success)
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '질문을 확인해 주세요',
      });
    if (!OBJECT_ID.test(materialId)) throw notFound();
    const _id = new Types.ObjectId(materialId);
    const owner = new Types.ObjectId(userId);
    const m = await this.materials
      .findOne(
        { _id, ownerId: owner, deletedAt: null },
        { kind: 1, title: 1, summary: 1, pages: 1 },
      )
      .lean<MaterialRow>();
    if (!m) throw notFound();
    const rec =
      m.kind === 'recording'
        ? await this.recordings
            .findOne({ materialId: _id, deletedAt: null }, { transcript: 1 })
            .lean<{ transcript?: { text?: unknown } }>()
        : null;
    const text = rec?.transcript?.text;
    // 이 노트로 만든 퀴즈(문제 · 정답 · 해설)도 학습 자료로 함께 넘긴다
    const sets = await this.quizSets
      .find({ materialId: _id, ownerId: owner, deletedAt: null, status: 'ready' }, { questions: 1 })
      .lean<{ questions?: QuizRow[] }[]>();
    const quiz = sets.flatMap((q) => q.questions ?? []);
    const context = noteContext(m, typeof text === 'string' ? text : null, quiz);
    if (!context)
      throw new ConflictException({
        code: ERROR_CODES.NOTE_NOT_READY,
        message: '노트 정리가 끝나면 물어볼 수 있어요',
      });
    // 사용자별 대기 한도(MAX_PENDING)는 AiJobsService가 넣을 때 · 다시 시도할 때 함께 지킨다
    return this.jobs.enqueue({
      type: 'note_ask',
      userId,
      targetType: 'material',
      targetId: materialId,
      input: { title: m.title, context, history: body.data.history, question: body.data.question },
    });
  }
}
