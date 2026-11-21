import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { type ClientSession, Model, Types } from 'mongoose';

import { AiJobsService, PREGEN_TYPE } from '../ai-jobs/ai-jobs.service.js';
import { Flashcard, type FlashcardDocument } from '../modules/quiz/schemas/flashcard.schema.js';
import { QuizBoxItem } from '../modules/quiz/schemas/quiz-box-item.schema.js';
import { QuizSet, type QuizSetDocument } from '../modules/quiz/schemas/quiz-set.schema.js';
import { SET_JOB_TYPES } from './quiz-sets.service.js';

/** 학습 폴더를 지울 때 같이 지울 퀴즈 데이터의 범위: 그 폴더와 그 폴더의 노트(지운 노트 포함) */
export interface QuizScope {
  folderId: Types.ObjectId;
  materialIds: Types.ObjectId[];
}

/** 오늘의 복습에서 이어졌는지 거슬러 오를 때 읽는 필드 */
const LINEAGE = { _id: 1, reviewDay: 1, sourceSetId: 1 };
interface LineageRow {
  _id: Types.ObjectId;
  reviewDay?: string | null;
  sourceSetId?: Types.ObjectId | null;
}

/** 로그에 남기는 오류: 이름 · 코드만 */
function errorName(e: unknown): string {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return `${e instanceof Error ? e.name : typeof e}${code === undefined ? '' : ` ${String(code)}`}`;
}

/**
 * 학습 폴더를 지울 때 그 폴더의 퀴즈 · 플래시카드 · 보관함 항목을 같이 지운다(#602). 폴더 삭제(FoldersService.remove)가
 * 같은 트랜잭션 세션으로 removeFor를 부르고, 커밋 뒤 afterRemove로 늦게 생긴 세트를 한 번 더 지우고 AI 작업을 취소한다.
 * - 퀴즈 세트 · 플래시카드: 폴더와 같은 시각으로 소프트 삭제(deletedAt). 목록 · 오늘의 복습(처리기는 지운 세트의 문제를
 *   내지 않고 풀이만 셈) · 플래시카드에서 빠진다. 자동 카드는 문서가 남아야 늦게 옮겨지는 카드 작업이 되살리지 않는다
 * - 보관함 항목: 지운 세트의 것을 하드 삭제. 보관함은 지운 세트의 문제도 보여 주므로(QuizBoxService.box) 따로 지운다
 * - 풀이 기록(quiz_attempts)은 남긴다: 포인트 · 풀이 통계 · 오늘의 복습의 약한 개념 입력
 * - 오늘의 복습 세트(reviewDay 있음)와 거기서 이어 만든 오답 복습 세트, 그 문제로 저장한 카드는 지우지 않는다: 여러 폴더
 *   문제의 사본을 섞고 폴더는 첫 문제의 것만 가져, 지우면 다른 폴더 문제의 복습이 끊긴다(원본은 사본으로 넘겨 moved).
 *   그 안에 든 이 폴더 문제의 사본은 알려진 차이(후속 이슈)
 */
@Injectable()
export class QuizCleanupService {
  private readonly logger = new Logger(QuizCleanupService.name);

  constructor(
    @InjectModel(QuizSet.name) private readonly sets: Model<QuizSetDocument>,
    @InjectModel(Flashcard.name) private readonly cards: Model<FlashcardDocument>,
    @InjectModel(QuizBoxItem.name) private readonly boxItems: Model<QuizBoxItem>,
    private readonly jobs: AiJobsService,
  ) {}

  /**
   * 범위의 지우지 않은 퀴즈 세트(오늘의 복습 제외) · 플래시카드를 now로 지우고, 지운 세트의 보관함 항목을 뺀다.
   * 세션을 받으면 그 트랜잭션 안에서 쓴다(하나라도 실패하면 폴더 삭제째 되돌아감). 지운 세트 id를 돌려준다.
   * 이미 지운 것은 건드리지 않아 여러 번 불러도 같다
   */
  async removeFor(
    owner: Types.ObjectId,
    scope: QuizScope,
    now: Date,
    session?: ClientSession,
  ): Promise<Types.ObjectId[]> {
    const opts = session ? { session } : {};
    const inScope = {
      ownerId: owner,
      deletedAt: null,
      $or: [
        { folderId: scope.folderId },
        ...(scope.materialIds.length > 0 ? [{ materialId: { $in: scope.materialIds } }] : []),
      ],
    };
    const rows = await this.sets.find(inScope, LINEAGE, opts).lean<LineageRow[]>();
    // 오늘의 복습 세트와 거기서 이어 만든 오답 복습 세트(첫 문제의 폴더 값을 물려받음)는 남긴다. 원본이 범위 밖이거나
    // 이미 지운 세트여도 DB에서 거슬러 오른다(QuizSetsService.fromTodayReview와 같은 기준)
    const byId = new Map(rows.map((r) => [String(r._id), r]));
    const fromToday = async (row: LineageRow): Promise<boolean> => {
      let cur: LineageRow | null = row;
      // 끝이나 이미 지나온 세트(고리)를 만날 때까지 오른다. 횟수로 끊지 않는다(Codex 1차)
      const seen = new Set<string>([String(row._id)]);
      while (cur) {
        if (cur.reviewDay) return true;
        if (!cur.sourceSetId || seen.has(String(cur.sourceSetId))) return false;
        seen.add(String(cur.sourceSetId));
        cur =
          byId.get(String(cur.sourceSetId)) ??
          (await this.sets.findOne({ _id: cur.sourceSetId }, LINEAGE, opts).lean<LineageRow>());
      }
      return false;
    };
    const kept = new Set<string>();
    for (const r of rows) if (await fromToday(r)) kept.add(String(r._id));
    const setIds = rows.filter((r) => !kept.has(String(r._id))).map((r) => r._id);
    const keptIds = rows.filter((r) => kept.has(String(r._id))).map((r) => r._id);
    if (setIds.length > 0) {
      await this.sets.updateMany(
        { _id: { $in: setIds }, ownerId: owner, deletedAt: null },
        { $set: { deletedAt: now } },
        opts,
      );
      await this.boxItems.deleteMany({ userId: owner, quizSetId: { $in: setIds } }, opts);
    }
    // 남긴 세트(오늘의 복습 등)의 문제로 저장한 카드는 다른 폴더 문제일 수 있어 남긴다
    await this.cards.updateMany(
      keptIds.length > 0 ? { ...inScope, sourceQuizSetId: { $nin: keptIds } } : inScope,
      { $set: { deletedAt: now } },
      opts,
    );
    return setIds;
  }

  /**
   * 폴더 삭제를 커밋한 뒤에 부른다. 둘 다 실패해도 삭제는 성공으로 두고 경고 로그만 남긴다.
   * 1. 같은 범위를 한 번 더 지운다: 트랜잭션이 시작한 뒤 커밋 전에 넣은 세트(맞춤 퀴즈 · 유사 퀴즈 만들기와 겹침)는
   *    트랜잭션이 보지 못한다. 커밋 뒤에 넣은 세트는 넣은 쪽이 폴더를 다시 보고 지운다(QuizSetsService.dropIfFolderGone).
   *    지운 세트 전부의 보관함 항목도 다시 지운다: 세트가 살아 있을 때 확인하고 커밋 뒤에 담은 항목이 남지 않게
   * 2. 지운 세트의 퀴즈 작업과 범위 노트의 미리 만들기를 취소한다(AI 비용 · 사용자 작업 줄 절약. 지운 세트는 조회되지
   *    않아 결과가 옮겨지지 않으므로 데이터는 생기지 않음)
   */
  async afterRemove(
    userId: string,
    owner: Types.ObjectId,
    scope: QuizScope,
    now: Date,
    removed: Types.ObjectId[],
  ): Promise<void> {
    const setIds = [...removed];
    try {
      setIds.push(...(await this.removeFor(owner, scope, now)));
      if (setIds.length > 0)
        await this.boxItems.deleteMany({ userId: owner, quizSetId: { $in: setIds } });
    } catch (e) {
      this.logger.warn(
        `폴더 삭제 뒤 퀴즈 정리를 다시 하지 못했습니다(삭제는 그대로): ${errorName(e)}`,
      );
    }
    try {
      await this.jobs.cancelForTargets(userId, [
        { targetType: 'quiz_set', targetIds: setIds.map(String), types: SET_JOB_TYPES },
        {
          targetType: 'material',
          targetIds: scope.materialIds.map(String),
          types: [PREGEN_TYPE],
        },
      ]);
    } catch (e) {
      this.logger.warn(
        `폴더 삭제 뒤 퀴즈 작업을 취소하지 못했습니다(삭제는 그대로): ${errorName(e)}`,
      );
    }
  }
}
