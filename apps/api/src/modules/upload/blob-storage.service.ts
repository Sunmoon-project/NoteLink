import { randomUUID } from 'node:crypto';

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ERROR_CODES, UPLOAD_RULES } from '@notelink/shared';

import type { StorageConfig } from '../../config/storage.config.js';

export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');
/**
 * 앱이 올린 파일이 놓이는 임시 경로. 아직 확인되지 않은 파일이라 그대로 쓰지 않는다.
 * 쓰는 곳이 실제 크기 · 형식을 확인하고 보관 경로로 복사하며, 남은 파일은 스토리지 수명 주기 규칙이 하루 뒤 지운다
 */
export const UPLOAD_PREFIX = 'incoming';
/** 접수된 신고 사진의 보관 경로: reports/{신고자}/{신고 ID}/{무작위}.{확장자} */
export const REPORT_PREFIX = 'reports';
/**
 * 신고가 저장되기 전의 복사본에 다는 태그(값은 만든 시각 ms, 자릿수 고정). 저장되면 뗀다.
 * 저장이 실패했는지는 오류만으로 확정할 수 없어 그 자리에서 지우지 않고, 정리 작업이
 * REPORT_PENDING_GRACE_MS가 지난 뒤 신고 문서가 있는지 확인해 지우거나 태그를 뗀다
 */
export const REPORT_PENDING_TAG = 'reportPending';
/**
 * 대기 복사본을 정리하기 전에 기다리는 시간. 진행 중이던 신고 저장이 모두 끝나고도 넉넉히 남는
 * 시간(임시 경로 수명 주기와 같은 하루)
 */
export const REPORT_PENDING_GRACE_MS = 24 * 60 * 60_000;
/** 정리 한 번에 받는 쪽당 수 · 한 번에 보는 최대 수(남으면 다음 주기에) */
export const REPORT_SWEEP_PAGE = 100;
export const REPORT_SWEEP_MAX = 1000;
const pendingStamp = (ms: number) => String(ms).padStart(15, '0');
/** 복사할 때 원본을 읽는 주소가 유효한 시간 */
const COPY_READ_MINUTES = 5;

/** 확장자의 표준 형식 */
export const TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
};
const REPORT_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|jpeg|png|heic)$/;
const KEPT_NAME = new RegExp(`^${REPORT_PREFIX}/[0-9a-f]{24}/([0-9a-f]{24})/[^/]+$`);

export interface BlobStore {
  config: StorageConfig;
  credential: StorageSharedKeyCredential;
  client: BlobServiceClient;
  https: boolean;
}

const badReport = (message: string) => new BadRequestException({ code: 'BAD_REQUEST', message });

@Injectable()
export class BlobStorageService {
  private readonly logger = new Logger(BlobStorageService.name);
  private readonly store: BlobStore | null;

  constructor(@Inject(STORAGE_CONFIG) config: StorageConfig | null) {
    if (!config) {
      this.store = null;
      return;
    }
    const credential = new StorageSharedKeyCredential(config.accountName, config.accountKey);
    this.store = {
      config,
      credential,
      client: new BlobServiceClient(config.blobEndpoint, credential),
      https: config.blobEndpoint.startsWith('https://'),
    };
  }

  /** 저장소 설정. 없으면 503 */
  requireStore(): BlobStore {
    if (!this.store)
      throw new ServiceUnavailableException({
        code: ERROR_CODES.UPLOAD_UNAVAILABLE,
        message: '지금은 파일을 올릴 수 없어요',
      });
    return this.store;
  }

  urlOf(blobName: string): string {
    const { config } = this.requireStore();
    return `${config.blobEndpoint}/${config.container}/${blobName}`;
  }

  /**
   * 신고 사진을 확인하고 그 신고의 보관 경로로 대기 태그를 달아 복사한다. 돌려주는 주소를 신고에 저장한다.
   * 신고자가 올린 임시 경로의 사진만 받고, 실제 크기 · 형식을 Blob에서 다시 본다.
   * 중간에 실패하면 이번에 만든 복사본을 지운다(아직 신고를 저장하기 전이라 안전)
   */
  async keepReportImages(userId: string, urls: string[], reportId: string): Promise<string[]> {
    if (!urls.length) return [];
    if (new Set(urls).size !== urls.length)
      throw badReport('같은 사진을 중복해서 첨부할 수 없습니다.');
    const store = this.requireStore();
    const owner = userId.toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(owner) || !/^[0-9a-f]{24}$/.test(reportId))
      throw new Error('신고자 · 신고 ID는 ObjectId 문자열이어야 합니다');
    const prefix = this.urlOf(`${UPLOAD_PREFIX}/${owner}/`);
    const tags = { [REPORT_PENDING_TAG]: pendingStamp(Date.now()) };

    const sources = urls.map((url) => {
      const fileName = url.startsWith(prefix) ? url.slice(prefix.length) : '';
      if (!REPORT_FILE.test(fileName)) throw badReport('사용할 수 없는 신고 사진입니다.');
      return fileName;
    });

    const kept: string[] = [];
    try {
      for (const fileName of sources)
        kept.push(await this.copyReportImage(store, `${owner}/${reportId}`, fileName, owner, tags));
    } catch (error) {
      await Promise.all(
        kept.map((url) =>
          this.blobOf(url)
            .deleteIfExists()
            .catch(() => undefined),
        ),
      );
      throw error;
    }
    return kept;
  }

  /** 신고를 저장한 뒤 복사본의 대기 태그를 뗀다. 실패해도 정리 작업이 신고를 확인하고 뗀다 */
  async confirmReportImages(urls: string[]): Promise<void> {
    await Promise.all(
      urls.map((url) =>
        this.blobOf(url)
          .setTags({})
          .catch(() => this.logger.warn('신고 사진 복사본의 대기 표시를 떼지 못했습니다')),
      ),
    );
  }

  /**
   * 오래된 대기 복사본 정리: 그 신고가 저장돼 있으면 태그를 떼고, 없으면 지운다.
   * 하나가 실패해도 나머지는 계속한다. 정리한 수를 돌려준다
   */
  async sweepReportImages(
    now: Date,
    reportExists: (reportId: string) => Promise<boolean>,
  ): Promise<{ kept: number; deleted: number; failed: number }> {
    const counts = { kept: 0, deleted: 0, failed: 0 };
    if (!this.store) return counts;
    const { client, config } = this.store;
    const cutoff = pendingStamp(now.getTime() - REPORT_PENDING_GRACE_MS);
    const query = `"${REPORT_PENDING_TAG}" < '${cutoff}'`;
    const container = client.getContainerClient(config.container);
    const found: string[] = [];
    for await (const page of container
      .findBlobsByTags(query)
      .byPage({ maxPageSize: REPORT_SWEEP_PAGE })) {
      found.push(...page.blobs.map((b) => b.name));
      if (found.length >= REPORT_SWEEP_MAX) break;
    }
    for (const name of found.slice(0, REPORT_SWEEP_MAX)) {
      const reportId = KEPT_NAME.exec(name)?.[1];
      if (!reportId) continue; // 우리가 만든 이름이 아니면 건드리지 않음
      const blob = container.getBlockBlobClient(name);
      try {
        if (await reportExists(reportId)) {
          await blob.setTags({});
          counts.kept += 1;
        } else {
          await blob.deleteIfExists();
          counts.deleted += 1;
        }
      } catch {
        counts.failed += 1;
      }
    }
    return counts;
  }

  /** 이 저장소 컨테이너 안의 Blob 주소 → 클라이언트 */
  private blobOf(url: string) {
    const { client, config } = this.requireStore();
    const name = decodeURIComponent(url.slice(this.urlOf('').length));
    return client.getContainerClient(config.container).getBlockBlobClient(name);
  }

  private async copyReportImage(
    store: BlobStore,
    folder: string,
    fileName: string,
    owner: string,
    tags: Record<string, string>,
  ) {
    const container = store.client.getContainerClient(store.config.container);
    const source = container.getBlockBlobClient(`${UPLOAD_PREFIX}/${owner}/${fileName}`);
    const ext = fileName.slice(fileName.lastIndexOf('.') + 1);
    try {
      const properties = await source.getProperties();
      if (
        !properties.contentLength ||
        properties.contentLength > UPLOAD_RULES.image.maxBytes ||
        properties.contentType !== TYPE_BY_EXT[ext]
      )
        throw badReport('신고 사진의 크기 또는 형식이 올바르지 않습니다.');

      const read = generateBlobSASQueryParameters(
        {
          containerName: store.config.container,
          blobName: source.name,
          permissions: BlobSASPermissions.parse('r'),
          expiresOn: new Date(Date.now() + COPY_READ_MINUTES * 60_000),
        },
        store.credential,
      ).toString();
      const target = container.getBlockBlobClient(
        `${REPORT_PREFIX}/${folder}/${randomUUID()}.${ext}`,
      );
      await target.syncCopyFromURL(`${source.url}?${read}`, { tags });
      return target.url;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      if (statusOf(error) === 404) throw badReport('업로드한 신고 사진을 찾을 수 없습니다.');
      throw new ServiceUnavailableException({
        code: ERROR_CODES.UPLOAD_UNAVAILABLE,
        message: '신고 사진을 확인하지 못했어요.',
      });
    }
  }
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? (error as { statusCode?: number }).statusCode
    : undefined;
}
