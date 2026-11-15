import { Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { INTEREST_CATEGORY_GROUPS } from '@notelink/shared';

/** 시드 끄기용 환경 변수. 값이 off면 서버를 켜도 공용 관심 분야를 넣지 않는다 (기본은 켜짐) */
export const INTEREST_SEED_ENV = 'INTEREST_SEED';

/** 시드가 쓰는 categories 컬렉션 기능만(mongoose 연결의 collection('categories')) */
export interface CategoryCollection {
  findOneAndUpdate(
    filter: object,
    update: object,
    options: { upsert: true; returnDocument: 'after'; includeResultMetadata: true },
  ): Promise<{
    value: { _id: Types.ObjectId } | null;
    lastErrorObject?: { upserted?: unknown };
  }>;
  findOne(filter: object): Promise<{ _id: Types.ObjectId } | null>;
}

// 고정 id 앞부분: "notelinkic"를 16진수로 쓴 값(20자리) + 번호 4자리. 서버가 여러 대 켜져도 같은 분야는 같은 id
const idOf = (n: number) => new Types.ObjectId(`6e6f74656c696e6b6963${String(n).padStart(4, '0')}`);

const DUPLICATE_KEY = 11000;
const isDuplicateKey = (e: unknown) => (e as { code?: number } | null)?.code === DUPLICATE_KEY;

export function isInterestSeedEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== 'off';
}

/**
 * 공용 관심 분야(큰 분야 → 세부 분야)를 이름으로 찾아 없을 때만 넣는다($setOnInsert). 이미 있는 분야(운영에서
 * 바꾼 색 · 순서 · 숨김)는 건드리지 않는다. 스터디룸이 이름으로 분야 하나를 찾으므로 이름이 겹치는 분야를 만들지 않는다.
 * 새로 넣은 개수를 돌려준다. 실패하면 예외를 던진다(서버 시작에서는 runInterestCategorySeed가 잡아 로그만 남긴다)
 */
export async function seedInterestCategories(categories: CategoryCollection): Promise<number> {
  let inserted = 0;
  let n = 0;
  const upsert = async (
    name: string,
    parentId: Types.ObjectId | null,
    color: string,
    sortOrder: number,
  ) => {
    const _id = idOf(++n);
    const at = new Date();
    try {
      const res = await categories.findOneAndUpdate(
        { name, ownerId: null, deletedAt: null },
        {
          $setOnInsert: {
            _id,
            name,
            ownerId: null,
            parentId,
            color,
            sortOrder,
            isActive: true,
            deletedAt: null,
            createdAt: at,
            updatedAt: at,
          },
        },
        { upsert: true, returnDocument: 'after', includeResultMetadata: true },
      );
      // 이번에 새로 넣었을 때만 센다(같은 고정 id로 예전에 넣어 둔 분야는 이미 있는 것)
      if (res.lastErrorObject?.upserted) inserted += 1;
      return res.value?._id ?? null;
    } catch (e) {
      // 다른 서버가 같은 고정 id로 먼저 넣었거나, 운영에서 지운(deletedAt) 같은 id가 남아 있을 때
      if (!isDuplicateKey(e)) throw e;
      return (await categories.findOne({ _id }))?._id ?? null;
    }
  };
  for (const [g, group] of INTEREST_CATEGORY_GROUPS.entries()) {
    const parentId = await upsert(group.name, null, group.color, g * 100);
    for (const [c, child] of group.children.entries()) {
      // 큰 분야를 찾지 못하면 그 아래도 번호만 넘긴다(고정 id가 다른 분야와 엇갈리지 않게)
      if (parentId) await upsert(child, parentId, group.color, g * 100 + c + 1);
      else n += 1;
    }
  }
  return inserted;
}

/** 서버 시작 때 쓰는 진입점: 끄기 설정이면 건너뛰고, 실패해도 예외를 밖으로 내지 않는다 */
export async function runInterestCategorySeed(
  /** 컬렉션을 꺼내는 일까지 실패를 잡는 안에서 한다(DB 대역 · 연결 문제로 서버 시작이 막히지 않게) */
  categories: () => CategoryCollection,
  env: string | undefined,
  logger: Pick<Logger, 'log' | 'error'> = new Logger('InterestCategorySeed'),
): Promise<void> {
  if (!isInterestSeedEnabled(env)) {
    logger.log(`${INTEREST_SEED_ENV}=off 라서 공용 관심 분야를 넣지 않습니다.`);
    return;
  }
  try {
    const inserted = await seedInterestCategories(categories());
    logger.log(`공용 관심 분야 확인 완료 (새로 넣은 개수: ${inserted})`);
  } catch (e) {
    logger.error(`공용 관심 분야를 넣지 못했습니다(서버는 계속 시작합니다): ${String(e)}`);
  }
}
