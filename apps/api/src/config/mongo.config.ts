import type { MongooseModuleOptions } from '@nestjs/mongoose';

/** `ConfigService`에서 이 파일이 쓰는 부분만 뽑은 형태(테스트에서 가짜 객체를 넣기 쉽게 함) */
export interface ConfigReader {
  get(key: string): string | undefined;
}

/**
 * MongoDB 연결 설정을 만든다.
 * `MONGODB_URI`가 없거나 비어 있으면 연결을 시도하기 전에 바로 실패한다.
 * (오류 문구에는 URI 값을 넣지 않는다. 비밀번호가 들어 있을 수 있다.)
 */
export function createMongooseOptions(config: ConfigReader): MongooseModuleOptions {
  const uri = config.get('MONGODB_URI')?.trim();
  if (!uri) {
    throw new Error('MONGODB_URI 환경변수가 필요합니다 (apps/api/.env.production 참고)');
  }
  return { uri };
}
