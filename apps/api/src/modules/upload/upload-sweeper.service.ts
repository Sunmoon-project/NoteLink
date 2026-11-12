import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { BLOB_STORE, type BlobStore } from './blob-store.js';
import { UploadTicket } from './schemas/upload-ticket.schema.js';

/** 정리를 돌리는 간격 */
export const SWEEP_INTERVAL_MS = 5 * 60_000;
/** 주소가 만료된 뒤 크기를 확인하기까지 기다리는 시간. 만료 직전에 시작한 큰 파일 올리기가 끝날 시간 */
export const SETTLE_MS = 60 * 60_000;
/** 올리고도 자료로 등록하지 않은 파일을 두는 시간 */
export const KEEP_UNUSED_MS = 24 * 60 * 60_000;
/** 한 번에 처리하는 기록 수 */
export const SWEEP_BATCH = 200;

interface TicketRow {
  _id: Types.ObjectId;
  blobName: string;
  maxBytes: number;
}

export interface SweepResult {
  /** 상한을 넘어 지운 파일 */
  oversize: number;
  /** 올라오지 않아 기록만 지운 것 */
  missing: number;
  /** 등록되지 않아 지운 파일 */
  unused: number;
  failed: number;
}

/**
 * 올라간 파일의 실제 크기를 확인하고, 상한을 넘거나 등록되지 않은 파일을 지운다.
 * SAS로는 크기를 묶을 수 없어 올린 뒤에 서버가 확인한다. 같은 기록을 두 번 처리해도 결과가 같다.
 */
@Injectable()
export class UploadSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UploadSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @InjectModel(UploadTicket.name) private readonly tickets: Model<UploadTicket>,
    @Inject(BLOB_STORE) private readonly blobs: BlobStore | null,
  ) {}

  onModuleInit(): void {
    if (!this.blobs) return;
    this.timer = setInterval(() => void this.tick(), SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.sweep();
      if (r.oversize || r.unused || r.failed)
        this.logger.log(
          `올린 파일 정리: 크기 초과 ${r.oversize} · 미등록 ${r.unused} · 실패 ${r.failed}`,
        );
    } catch (e) {
      this.logger.error(`올린 파일 정리 실패: ${(e as Error).name}`);
    } finally {
      this.running = false;
    }
  }

  async sweep(now: Date = new Date()): Promise<SweepResult> {
    const result: SweepResult = { oversize: 0, missing: 0, unused: 0, failed: 0 };
    if (!this.blobs) return result;
    const blobs = this.blobs;

    // 등록되지 않은 채 오래된 파일
    const unused = await this.tickets
      .find(
        { status: 'issued', expiresAt: { $lte: new Date(now.getTime() - KEEP_UNUSED_MS) } },
        { blobName: 1, maxBytes: 1 },
      )
      .sort({ expiresAt: 1 })
      .limit(SWEEP_BATCH)
      .lean<TicketRow[]>();
    for (const t of unused)
      await this.each(result, async () => {
        await blobs.remove(t.blobName);
        await this.tickets.deleteOne({ _id: t._id });
        result.unused += 1;
      });

    // 올리기가 끝났을 파일의 실제 크기
    const settled = await this.tickets
      .find(
        {
          status: 'issued',
          checkedAt: null,
          expiresAt: { $lte: new Date(now.getTime() - SETTLE_MS) },
        },
        { blobName: 1, maxBytes: 1 },
      )
      .sort({ expiresAt: 1 })
      .limit(SWEEP_BATCH)
      .lean<TicketRow[]>();
    for (const t of settled)
      await this.each(result, async () => {
        const size = await blobs.size(t.blobName);
        if (size === null) {
          await this.tickets.deleteOne({ _id: t._id });
          result.missing += 1;
        } else if (size > t.maxBytes) {
          await blobs.remove(t.blobName);
          await this.tickets.deleteOne({ _id: t._id });
          result.oversize += 1;
        } else {
          await this.tickets.updateOne({ _id: t._id }, { $set: { checkedAt: now } });
        }
      });
    return result;
  }

  /** 기록 하나가 실패해도 나머지는 계속한다. 오류 원문은 주소를 담을 수 있어 이름만 남긴다 */
  private async each(result: SweepResult, work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (e) {
      result.failed += 1;
      this.logger.warn(`올린 파일 하나를 정리하지 못함: ${(e as Error).name}`);
    }
  }
}
