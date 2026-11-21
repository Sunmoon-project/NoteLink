import { describe, expect, it } from 'vitest';

import { PATHS } from './contracts.js';
import { AiJobCancelBody } from './schemas.js';

describe('AI 작업 취소 계약(POST /ai-jobs/:id/cancel)', () => {
  it('주소는 그대로다', () => {
    expect(PATHS.aiJobCancel('j1')).toBe('/ai-jobs/j1/cancel');
  });

  it('본문의 세트 번호(quizSetId)는 선택: 빈 본문(옛 앱)도 받는다', () => {
    expect(AiJobCancelBody.parse({})).toEqual({});
    const quizSetId = '6740a1b2c3d4e5f6a7b8c9d0';
    expect(AiJobCancelBody.parse({ quizSetId })).toEqual({ quizSetId });
  });

  it.each([
    [{ quizSetId: 3 }],
    [{ quizSetId: null }],
    [{ quizSetId: '' }],
    [{ quizSetId: 'qs1' }],
    ['qs1'],
  ])('본문 %j는 받지 않는다', (body) => {
    expect(AiJobCancelBody.safeParse(body).success).toBe(false);
  });
});
