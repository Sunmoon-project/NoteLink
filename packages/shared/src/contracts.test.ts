import { describe, expect, it } from 'vitest';

import { PATHS } from './contracts.js';
import { DailyRecord, Material, Notification, QuizSet } from './schemas.js';

describe('PATHS', () => {
  it('경로 조각을 인코딩해 다른 경로로 새지 않게 한다', () => {
    expect(PATHS.material('../users/me')).toBe('/materials/..%2Fusers%2Fme');
    expect(PATHS.chatMessages('a/b?c')).toBe('/chat-rooms/a%2Fb%3Fc/messages');
  });

  it('평범한 id는 그대로 둔다', () => {
    expect(PATHS.studySessionAction('abc123', 'end')).toBe('/study-sessions/abc123/end');
  });
});

describe('schemas', () => {
  it('자료 응답을 검증한다', () => {
    const ok = Material.safeParse({
      _id: 'm1',
      folderId: 'f1',
      kind: 'handwriting',
      source: 'camera',
      title: '필기',
      description: null,
      avatarItemId: null,
      processing: { status: 'done', progress: 100, jobId: null },
      summary: null,
      keywords: [],
      bookmarks: [],
      createdAt: '2026-10-26T00:00:00Z',
    });
    expect(ok.success).toBe(true);
  });

  it('알 수 없는 퀴즈 상태는 거절한다', () => {
    const r = QuizSet.shape.status.safeParse('unknown');
    expect(r.success).toBe(false);
  });
});

describe('날짜 형식', () => {
  it('UTC 시각과 서울 날짜 형식만 받는다', () => {
    const n = {
      _id: 'n1',
      userId: 'u1',
      type: 'x',
      title: 't',
      body: 'b',
      data: null,
      readAt: null,
    };
    expect(Notification.safeParse({ ...n, createdAt: '2026-10-27T03:00:00.000Z' }).success).toBe(
      true,
    );
    expect(Notification.safeParse({ ...n, createdAt: '어제' }).success).toBe(false);
  });
});

describe('서울 날짜 계약', () => {
  it('실제 존재하는 YYYY-MM-DD 날짜만 받는다', () => {
    const date = DailyRecord.shape.studyDate;
    expect(date.safeParse('2028-02-29').success).toBe(true);
    expect(date.safeParse('2026-10-31').success).toBe(true);
    expect(date.safeParse('2026-02-30').success).toBe(false);
    expect(date.safeParse('2026-10-31T00:00:00Z').success).toBe(false);
    expect(date.safeParse('오늘').success).toBe(false);
  });
});
