import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { StorageScope, type StorageScopeDocument } from './schemas/storage-scope.schema.js';

export const STORAGE_SCOPE_ID = 'default';
const DUPLICATE_KEY = 11000;

/** 이 DB의 저장소 구분값을 읽는다. 없으면 한 번 만들고, 그 뒤로는 바뀌지 않는다 */
@Injectable()
export class StorageScopeService {
  private cached?: Promise<string>;

  constructor(
    @InjectModel(StorageScope.name) private readonly scopes: Model<StorageScopeDocument>,
  ) {}

  get(): Promise<string> {
    this.cached ??= this.load().catch((error: unknown) => {
      this.cached = undefined;
      throw error;
    });
    return this.cached;
  }

  private async load(): Promise<string> {
    // 처음 만드는 요청이 겹치면 한쪽이 유일 키에 걸리므로 한 번 더 읽는다
    for (let attempt = 0; ; attempt += 1) {
      try {
        const doc = await this.scopes
          .findOneAndUpdate(
            { _id: STORAGE_SCOPE_ID },
            { $setOnInsert: { scope: randomUUID() } },
            { upsert: true, new: true },
          )
          .lean()
          .orFail();
        return doc.scope;
      } catch (error) {
        if (attempt > 0 || (error as { code?: unknown }).code !== DUPLICATE_KEY) throw error;
      }
    }
  }
}
