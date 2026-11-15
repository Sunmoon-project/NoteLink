import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  REPORT_SWEEP_INTERVAL_MS,
  ReportImageSweeper,
} from '../src/modules/social/report-image-sweeper.service.js';

const make = () => {
  const reports = { exists: vi.fn() };
  const storage = { sweepReportImages: vi.fn() };
  return {
    reports,
    storage,
    sweeper: new ReportImageSweeper(reports as never, storage as never),
  };
};
afterEach(() => vi.useRealTimers());

describe('신고 사진 복사본 정리 작업 (ReportImageSweeper)', () => {
  it('신고 문서가 있는지 DB에서 보고 정리를 맡긴다', async () => {
    const { reports, storage, sweeper } = make();
    const id = new Types.ObjectId();
    reports.exists.mockResolvedValueOnce({ _id: id }).mockResolvedValueOnce(null);
    storage.sweepReportImages.mockImplementation(
      async (_now: Date, exists: (id: string) => Promise<boolean>) => {
        expect(await exists(String(id))).toBe(true);
        expect(await exists(String(new Types.ObjectId()))).toBe(false);
        return { kept: 1, deleted: 1, failed: 0 };
      },
    );
    const now = new Date();

    await sweeper.run(now);

    expect(storage.sweepReportImages).toHaveBeenCalledWith(now, expect.any(Function));
    expect(reports.exists.mock.calls[0]![0]._id.equals(id)).toBe(true);
  });

  it('겹쳐 부르면 뒤 호출은 건너뛰고, 실패해도 던지지 않는다', async () => {
    const { storage, sweeper } = make();
    let release!: () => void;
    storage.sweepReportImages.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ kept: 0, deleted: 0, failed: 0 });
      }),
    );
    const first = sweeper.run(new Date());
    await sweeper.run(new Date());
    expect(storage.sweepReportImages).toHaveBeenCalledTimes(1);
    release();
    await first;

    storage.sweepReportImages.mockRejectedValueOnce(new Error('저장소 장애'));
    await expect(sweeper.run(new Date())).resolves.toBeUndefined();
  });

  it('서버가 켜질 때는 돌지 않고 주기마다 돈다', async () => {
    vi.useFakeTimers();
    const { storage, sweeper } = make();
    storage.sweepReportImages.mockResolvedValue({ kept: 0, deleted: 0, failed: 0 });

    sweeper.onApplicationBootstrap();
    expect(storage.sweepReportImages).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(REPORT_SWEEP_INTERVAL_MS);
    expect(storage.sweepReportImages).toHaveBeenCalledTimes(1);

    sweeper.onApplicationShutdown();
    await vi.advanceTimersByTimeAsync(REPORT_SWEEP_INTERVAL_MS);
    expect(storage.sweepReportImages).toHaveBeenCalledTimes(1);
  });
});
