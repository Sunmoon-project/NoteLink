import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';

import { type CategoryCollection, runInterestCategorySeed } from './interest-category-seed.js';

/** 서버가 시작될 때 공용 관심 분야를 한 번 확인해 없는 것만 넣는다 (INTEREST_SEED=off면 건너뜀) */
@Injectable()
export class InterestCategorySeedService implements OnApplicationBootstrap {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  onApplicationBootstrap(): Promise<void> {
    return runInterestCategorySeed(
      this.connection.collection('categories') as unknown as CategoryCollection,
      process.env.INTEREST_SEED,
    );
  }
}
