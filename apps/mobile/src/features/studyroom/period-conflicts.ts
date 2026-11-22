import type { RoomSchedule } from '@/lib/api';

// 교시제 편집에서 멤버 수업과 겹치는지 본다(TestQA ROOM-013, #657). 정책: 겹쳐도 경고만, 저장은 막지 않는다

/** 방 시간표의 요일 순서(blocks.day 0 = 월요일) */
const DAY_SHORT = ['월', '화', '수', '목', '금', '토', '일'];

const toMin = (t: string) => {
  const [h = 0, m = 0] = t.split(':').map(Number);
  return h * 60 + m;
};

/** 이 교시와 겹치는 한 멤버의 수업. days는 겹치는 요일(0 = 월요일) 오름차순 */
export type PeriodConflict = { name: string; me: boolean; days: number[] };

/**
 * 교시(매일 같은 시각, 서울 기준 HH:MM)와 시간이 걸치는 멤버 수업을 멤버 순서대로 모은다. 끝 = 시작은 겹치지 않는다.
 * 이 방에서 시간을 숨긴 멤버, 멤버별 일정(blocks)을 주지 않는 예전 서버 응답은 비교하지 않는다
 */
export function periodConflicts(
  period: { start: string; end: string },
  members: RoomSchedule['members'],
  myId: string | null | undefined,
): PeriodConflict[] {
  const start = toMin(period.start);
  const end = toMin(period.end);
  return members.flatMap((m) => {
    if (m.hidden || !m.blocks) return [];
    const days = [
      ...new Set(
        m.blocks.filter((b) => toMin(b.start) < end && toMin(b.end) > start).map((b) => b.day),
      ),
    ].sort((a, b) => a - b);
    return days.length ? [{ name: m.nickname, me: !!myId && m.id === myId, days }] : [];
  });
}

/** 「민수님 수업과 겹쳐요 (월 · 수)」 — 수업 제목은 공유 설정과 상관없이 보이지 않고 이름 · 요일만 */
export function conflictMessage(conflicts: PeriodConflict[]): string | null {
  if (!conflicts.length) return null;
  const mine = conflicts.some((c) => c.me);
  const others = conflicts.filter((c) => !c.me).map((c) => `${c.name}님`);
  const who = others.length
    ? `${[...(mine ? ['나'] : []), ...others].join(' · ')} 수업`
    : '내 수업';
  const days = [...new Set(conflicts.flatMap((c) => c.days))].sort((a, b) => a - b);
  return `${who}과 겹쳐요 (${days.map((d) => DAY_SHORT[d]).join(' · ')})`;
}
