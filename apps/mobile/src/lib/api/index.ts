import { env } from '../env';
import { localApi } from '../local/api';
import { httpApi } from './http-api';
import type { Api } from './types';

/** 화면은 이 객체만 쓴다. 기본은 NestJS 메인 API, EXPO_PUBLIC_USE_LOCAL_DATA=true면 기기 저장(localApi) */
export const api: Api = env.localData ? localApi : httpApi;
export { ApiError, NetworkError } from './http';
export type * from './types';
