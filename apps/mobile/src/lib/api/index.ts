import { env } from '../env';
import { localApi } from '../local/api';
import { httpApi } from './http-api';
import type { Api } from './types';

/** 화면은 이 객체만 쓴다. 기본은 기기 저장(localApi), EXPO_PUBLIC_USE_SERVER=true면 NestJS 메인 API */
export const api: Api = env.localData ? localApi : httpApi;
export { ApiError, NetworkError } from './http';
export type * from './types';
