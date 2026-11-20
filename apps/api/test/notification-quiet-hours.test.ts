import { describe, expect, it } from 'vitest';

import { inQuietHours } from '../src/modules/notification/notification.service.js';

/** 서울 시각 hh:mm의 Date(2026-11-19) */
const seoul = (hhmm: string) => new Date(`2026-11-19T${hhmm}:00+09:00`);

describe('조용한 시간(서울)', () => {
  it('자정을 넘는 23:00~07:00: 23:00 · 00:30 · 06:59는 조용, 07:00 · 12:00 · 22:59는 아님', () => {
    const q = { start: '23:00', end: '07:00' };
    for (const t of ['23:00', '00:30', '06:59']) expect(inQuietHours(q, seoul(t))).toBe(true);
    for (const t of ['07:00', '12:00', '22:59']) expect(inQuietHours(q, seoul(t))).toBe(false);
  });

  it('같은 날 13:00~14:00', () => {
    const q = { start: '13:00', end: '14:00' };
    expect(inQuietHours(q, seoul('13:30'))).toBe(true);
    expect(inQuietHours(q, seoul('14:00'))).toBe(false);
  });

  it('끔(null) · 형식이 틀림 · 시작과 끝이 같으면 조용한 시간이 없다', () => {
    for (const q of [
      null,
      undefined,
      { start: '25:00', end: '07:00' },
      { start: '9:00' },
      { start: '08:00', end: '08:00' },
    ])
      expect(inQuietHours(q, seoul('08:00'))).toBe(false);
  });
});
