/** 주간 목표(분)와 공부 시간(초)을 비교한다. 목표가 없으면 달성률을 계산하지 않는다. */
export function weeklyProgress(totalSec: number, targetMin: number | null | undefined) {
  if (!targetMin || targetMin <= 0) return null;
  const percent = (totalSec / (targetMin * 60)) * 100;
  return { percent, reached80: totalSec >= targetMin * 60 * 0.8 };
}
