import { Types } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import {
  buildSchedule,
  SCHEDULE_START_HOUR,
} from '../src/modules/studyroom/study-room-schedule.service.js';
import { ExplanationsService } from '../src/quiz-sets/explanations.controller.js';

const ME = new Types.ObjectId().toHexString();

describe('문제 해설(ExplanationsService)', () => {
  const service = (found: unknown) => {
    const findOne = vi.fn(() => ({ lean: () => Promise.resolve(found) }));
    return { svc: new ExplanationsService({ findOne } as never), findOne };
  };

  it('내 세트의 문제 해설을 돌려준다(그 문제만 꺼내 읽음)', async () => {
    const qid = new Types.ObjectId();
    const { svc, findOne } = service({
      _id: new Types.ObjectId(),
      questions: [{ _id: qid, answer: '세포막', explanation: '  세포막이 세포를 둘러싼다. ' }],
    });
    expect(await svc.explain(ME, qid.toHexString())).toEqual({ text: '세포막이 세포를 둘러싼다.' });
    expect(findOne).toHaveBeenCalledWith(
      { ownerId: new Types.ObjectId(ME), 'questions._id': qid },
      { questions: { $elemMatch: { _id: qid } } },
    );
  });

  it('해설이 없는 문제는 정답과 함께 아직 해설이 없다고 알린다', async () => {
    const qid = new Types.ObjectId();
    const { svc } = service({ questions: [{ _id: qid, answer: '핵', explanation: null }] });
    expect(await svc.explain(ME, qid.toHexString())).toEqual({
      text: '정답은 「핵」예요. 이 문제는 아직 해설이 없어요.',
    });
  });

  it('남의 문제 · 없는 문제 · 형식이 틀린 id는 404', async () => {
    await expect(
      service(null).svc.explain(ME, new Types.ObjectId().toHexString()),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(service(null).svc.explain(ME, 'not-an-id')).rejects.toMatchObject({ status: 404 });
  });
});

describe('스터디룸 공용 일정(buildSchedule)', () => {
  const row = (hour: number) => hour - SCHEDULE_START_HOUR;

  it('누군가 수업이 있으면 1, 모두 비면 2(멤버 2명 이상), 혼자면 0', () => {
    const me = [{ days: [1], startTime: '10:00', endTime: '11:30' }]; // 월 10:00 ~ 11:30
    const friend = [{ days: [3], startTime: '09:00', endTime: '10:00' }]; // 수 09:00 ~ 10:00
    const { grid } = buildSchedule([me, friend], 2);
    expect(grid[row(10)]![0]).toBe(1); // 월 10시
    expect(grid[row(11)]![0]).toBe(1); // 월 11시(11:30까지 걸침)
    expect(grid[row(12)]![0]).toBe(2); // 월 12시는 모두 빔
    expect(grid[row(9)]![2]).toBe(1); // 수 9시
    expect(grid[row(10)]![2]).toBe(2); // 수 10시(10:00에 끝남)
    expect(buildSchedule([me], 1).grid[row(12)]![0]).toBe(0);
  });

  it('일요일 수업은 마지막 열에 칠한다', () => {
    const { grid } = buildSchedule([[{ days: [0], startTime: '14:00', endTime: '15:00' }]], 2);
    expect(grid[row(14)]![6]).toBe(1);
    expect(grid[row(14)]![5]).toBe(2);
  });

  it('추천 시간대는 모두 빈 연속 구간을 긴 것부터, 가장 긴 것에 best', () => {
    // 월요일은 9 ~ 21시 수업(21 ~ 23시만 빔), 나머지 요일은 종일 빔(9 ~ 23시)
    const busyMonday = [{ days: [1], startTime: '09:00', endTime: '21:00' }];
    const { matches } = buildSchedule([busyMonday, []], 2);
    expect(matches[0]).toEqual({
      day: '화요일',
      label: '화요일',
      start: '09:00',
      end: '23:00',
      best: true,
    });
    expect(matches).toHaveLength(5);
    expect(matches.slice(1).every((m) => !('best' in m))).toBe(true);
    expect(matches.some((m) => m.day === '월요일')).toBe(false); // 2시간짜리는 5위 밖
  });

  it('혼자면 추천 시간대가 없다', () => {
    expect(buildSchedule([[]], 1).matches).toEqual([]);
  });
});
