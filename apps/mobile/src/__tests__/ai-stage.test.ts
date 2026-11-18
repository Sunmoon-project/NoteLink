import { AI_WAITING_STEP, stageOf } from '../lib/ai';

// 변환 화면 단계는 진행률이 아니라 AI 처리기가 알린 단계(ai_jobs.step)로 고른다
describe('stageOf', () => {
  it('녹음: 정리 중(organize, 20~90%)은 진행률이 50% 아래여도 「노트 정리」(2)', () => {
    expect(stageOf('organize', 31)).toBe(2);
    expect(stageOf('stt', 0)).toBe(1);
    expect(stageOf('material', 0)).toBe(1);
    expect(stageOf('embed', 90)).toBe(3);
  });

  it('필기 · 문서: ocr → split · refine → embed', () => {
    expect(stageOf('ocr', 40)).toBe(1);
    expect(stageOf('split', 60)).toBe(2);
    expect(stageOf('refine', 80)).toBe(2);
    expect(stageOf('embed', 95)).toBe(3);
  });

  it('단계가 없거나 모르는 이름 · 대기 중이면 진행률로 고른다', () => {
    expect(stageOf(undefined, 0)).toBe(1);
    expect(stageOf(null, 60)).toBe(2);
    expect(stageOf('new-step', 90)).toBe(3);
    expect(stageOf(AI_WAITING_STEP, 0)).toBe(1);
  });
});
