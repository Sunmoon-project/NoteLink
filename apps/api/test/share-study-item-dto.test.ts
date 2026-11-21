// 방에 퀴즈 · 플래시카드 공유 본문(#481): 종류마다 필요한 칸만 검사한다
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { ShareStudyItemDto } from '../src/modules/content/materials/dto/share-study-item.dto.js';

const errors = async (body: object) =>
  (await validate(plainToInstance(ShareStudyItemDto, body))).map((e) => e.property);
const ID = '0123456789abcdef01234567';

describe('ShareStudyItemDto', () => {
  it('퀴즈는 quizSetId, 카드는 flashcardIds(1장 이상)만 본다', async () => {
    expect(await errors({ kind: 'quiz', quizSetId: ID })).toEqual([]);
    expect(await errors({ kind: 'flashcards', flashcardIds: [ID] })).toEqual([]);
    expect(await errors({ kind: 'quiz' })).toEqual(['quizSetId']);
    expect(await errors({ kind: 'flashcards', flashcardIds: [] })).toEqual(['flashcardIds']);
    expect(await errors({ kind: 'flashcards', flashcardIds: ['x'] })).toEqual(['flashcardIds']);
    expect(await errors({ kind: 'note', quizSetId: ID })).toEqual(['kind']);
  });
});
