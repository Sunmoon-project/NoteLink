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
/** 접수된 신고 사진의 보관 경로 */
export const REPORT_PREFIX = 'reports';
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
   * 신고 사진을 확인하고 보관 경로로 복사한다. 돌려주는 주소를 신고에 저장한다.
   * 신고자가 올린 임시 경로의 사진만 받고, 실제 크기 · 형식을 Blob에서 다시 본다.
   * 복사본은 부를 때마다 새 이름이라 다른 신고와 공유하지 않는다. 중간에 실패하면 이번에 만든 복사본을 지운다
   */
  async keepReportImages(userId: string, urls: string[]): Promise<string[]> {
    if (!urls.length) return [];
    if (new Set(urls).size !== urls.length)
      throw badReport('같은 사진을 중복해서 첨부할 수 없습니다.');
    const store = this.requireStore();
    const owner = userId.toLowerCase();
    const prefix = this.urlOf(`${UPLOAD_PREFIX}/${owner}/`);

    const sources = urls.map((url) => {
      const fileName = url.startsWith(prefix) ? url.slice(prefix.length) : '';
      if (!REPORT_FILE.test(fileName)) throw badReport('사용할 수 없는 신고 사진입니다.');
      return fileName;
    });

    const kept: string[] = [];
    try {
      for (const fileName of sources) kept.push(await this.copyReportImage(store, owner, fileName));
    } catch (error) {
      await this.discardReportImages(kept);
      throw error;
    }
    return kept;
  }

  /** 신고를 저장하지 못했을 때 keepReportImages가 만든 복사본을 지운다. 실패는 기록만 한다 */
  async discardReportImages(urls: string[]): Promise<void> {
    if (!urls.length || !this.store) return;
    const { client, config } = this.store;
    const container = client.getContainerClient(config.container);
    const prefix = this.urlOf(`${REPORT_PREFIX}/`);
    await Promise.all(
      urls
        .filter((url) => url.startsWith(prefix))
        .map((url) =>
          container
            .getBlockBlobClient(decodeURIComponent(url.slice(this.urlOf('').length)))
            .deleteIfExists()
            .catch(() => this.logger.warn('접수하지 못한 신고 사진 복사본을 지우지 못했습니다')),
        ),
    );
  }

  private async copyReportImage(store: BlobStore, owner: string, fileName: string) {
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
        `${REPORT_PREFIX}/${owner}/${randomUUID()}.${ext}`,
      );
      await target.syncCopyFromURL(`${source.url}?${read}`);
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
