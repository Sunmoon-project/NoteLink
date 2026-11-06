import { getConnectionToken } from '@nestjs/mongoose';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';

import { AppModule } from '../../src/app.module.js';

/**
 * `AppModule`을 그대로 조립하되, 실제 MongoDB 연결만 가짜로 바꾼다.
 * 설정(`MONGODB_URI` 읽기 · 검증)은 실제 코드가 그대로 실행되고, DB 없이도(CI 포함) 돌아간다.
 */
export function createAppModuleBuilder(): TestingModuleBuilder {
  return Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(getConnectionToken())
    .useValue({ close: () => Promise.resolve() });
}
