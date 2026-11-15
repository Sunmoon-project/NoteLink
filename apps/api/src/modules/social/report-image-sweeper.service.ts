import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Types, type Model } from 'mongoose';

import { BlobStorageService } from '../upload/blob-storage.service.js';
import { StorageScopeService } from '../upload/storage-scope.service.js';
import { Report } from './schemas/report.schema.js';

export const REPORT_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * 신고가 저장되지 않은 사진 복사본 정리. 신고를 접수할 때는 저장 실패를 확정할 수 없어 지우지 않고,
 * 충분히 지난 뒤 신고 문서가 있는지 보고 지우거나 남긴다(BlobStorageService.sweepReportImages).
 * 이 DB의 구분값이 달린 복사본만 다룬다(같은 저장소를 쓰는 다른 DB의 신고 사진은 건드리지 않음).
 * 서버가 켜질 때는 돌지 않고 주기마다만 돈다(여러 서버가 함께 돌아도 결과가 같음)
 */
@Injectable()
export class ReportImageSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReportImageSweeper.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    @InjectModel(Report.name) private readonly reports: Model<Report>,
    private readonly storage: BlobStorageService,
    private readonly scopes: StorageScopeService,
  ) {}

  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.run(new Date()), REPORT_SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  /** 한 번 정리. 겹쳐 부르면 뒤 호출은 건너뛴다 */
  async run(now: Date) {
    if (this.running) return;
    this.running = true;
    try {
      const scope = await this.scopes.get();
      const counts = await this.storage.sweepReportImages(now, scope, async (id) =>
        Boolean(await this.reports.exists({ _id: new Types.ObjectId(id) })),
      );
      if (counts.deleted || counts.failed)
        this.logger.log(
          `신고 사진 복사본 정리: 남김 ${counts.kept} · 지움 ${counts.deleted} · 실패 ${counts.failed}`,
        );
    } catch {
      this.logger.warn('신고 사진 복사본을 정리하지 못했습니다. 다음 주기에 다시 합니다');
    } finally {
      this.running = false;
    }
  }
}
