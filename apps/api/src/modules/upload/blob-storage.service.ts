import { randomUUID } from 'node:crypto';

import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
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
 * 앱이 올린 노트 파일의 경로: uploads/{종류}/{사용자}/{무작위}.{확장자}.
 * 노트 등록(MaterialsService) · 필기 사진 검사(ImagesService)가 이 경로의 주소를 확인하고 그대로 저장하므로 지우지 않는다
 */
export const UPLOAD_PREFIX = 'uploads';
/**
 * 앱이 올린 신고 사진의 임시 경로: incoming/{사용자}/{무작위}.{확장자}. 그대로 쓰지 않고, 신고를 접수할 때
 * 실제 크기 · 형식을 확인해 보관 경로로 복사한다. 남은 파일은 스토리지 수명 주기 규칙이 하루 뒤 지운다
 */
export const REPORT_UPLOAD_PREFIX = 'incoming';
/** 채팅에 보낸 사진 · 파일: chat/{종류}/{사용자}/{무작위}.{확장자}. 메시지가 이 주소를 저장하므로 지우지 않는다 */
export const CHAT_UPLOAD_PREFIX = 'chat';
/** 접수된 신고 사진의 보관 경로: reports/{신고자}/{신고 ID}/{무작위}.{확장자} */
export const REPORT_PREFIX = 'reports';
/**
 * 신고가 저장되기 전의 복사본에 다는 태그(값은 만든 시각 ms, 자릿수 고정). 저장되면 뗀다.
 * 저장이 실패했는지는 오류만으로 확정할 수 없어 그 자리에서 지우지 않고, 정리 작업이
 * REPORT_PENDING_GRACE_MS가 지난 뒤 신고 문서가 있는지 확인해 지우거나 태그를 뗀다
 */
export const REPORT_PENDING_TAG = 'reportPending';
/**
 * 복사본을 만든 서버의 DB 구분값 태그(StorageScopeService). 같은 컨테이너를 다른 DB와 함께 쓰므로,
 * 정리 작업은 자기 DB의 복사본만 찾고 지운다(다른 DB의 신고는 이 DB에 없어 지우면 안 됨)
 */
export const REPORT_SCOPE_TAG = 'reportScope';
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
  aac: 'audio/aac',
  mp4: 'audio/mp4',
  wav: 'audio/wav',
};
/** 앱이 올린 파일 이름: uuid(v4).확장자 */
const UPLOADED_FILE_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[a-z0-9]{2,5}$/;
/** 읽기 주소의 시작 시각을 앞당기는 폭(서버 · 저장소 시계 차이) */
const CLOCK_SKEW_MS = 60_000;
/** AI 사진 검사에 넘기는 읽기 주소가 유효한 시간 */
const IMAGE_CHECK_SAS_LIFETIME_MS = 15 * 60_000;
const REPORT_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:jpg|jpeg|png|heic)$/;
const SCOPE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const KEPT_NAME = new RegExp(`^${REPORT_PREFIX}/[0-9a-f]{24}/([0-9a-f]{24})/[^/]+$`);

export interface BlobStore {
  config: StorageConfig;
  credential: StorageSharedKeyCredential;
  client: BlobServiceClient;
  https: boolean;
}

const badReport = (message: string) => new BadRequestException({ code: 'BAD_REQUEST', message });
const badFile = (message: string) =>
  new BadRequestException({ code: ERROR_CODES.VALIDATION, message });
const unavailable = (message: string) =>
  new ServiceUnavailableException({ code: ERROR_CODES.UPLOAD_UNAVAILABLE, message });

/** 앱이 올리는 폴더(끝에 '/'): 신고 사진은 임시 경로, 채팅 첨부는 채팅 경로, 그 밖에는 종류별 노트 경로 */
export function uploadFolder(kind: string, userId: string, purpose?: 'report' | 'chat'): string {
  const owner = userId.toLowerCase();
  if (purpose === 'report') return `${REPORT_UPLOAD_PREFIX}/${owner}/`;
  if (purpose === 'chat') return `${CHAT_UPLOAD_PREFIX}/${kind}/${owner}/`;
  return `${UPLOAD_PREFIX}/${kind}/${owner}/`;
}

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
  async keepReportImages(
    userId: string,
    urls: string[],
    reportId: string,
    scope: string,
  ): Promise<string[]> {
    if (!urls.length) return [];
    if (new Set(urls).size !== urls.length)
      throw badReport('같은 사진을 중복해서 첨부할 수 없습니다.');
    const store = this.requireStore();
    const owner = userId.toLowerCase();
    if (!/^[0-9a-f]{24}$/.test(owner) || !/^[0-9a-f]{24}$/.test(reportId))
      throw new Error('신고자 · 신고 ID는 ObjectId 문자열이어야 합니다');
    if (!SCOPE.test(scope)) throw new Error('DB 구분값이 올바르지 않습니다');
    const prefix = this.urlOf(`${REPORT_UPLOAD_PREFIX}/${owner}/`);
    const tags = {
      [REPORT_PENDING_TAG]: pendingStamp(Date.now()),
      [REPORT_SCOPE_TAG]: scope,
    };

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
   * 이 DB(scope)의 오래된 대기 복사본 정리: 그 신고가 저장돼 있으면 태그를 떼고, 없으면 지운다.
   * 지우거나 뗄 때도 태그 조건을 다시 걸어, 그 사이 바뀐 Blob은 건너뛴다.
   * 하나가 실패해도 나머지는 계속한다. 정리한 수를 돌려준다
   */
  async sweepReportImages(
    now: Date,
    scope: string,
    reportExists: (reportId: string) => Promise<boolean>,
  ): Promise<{ kept: number; deleted: number; failed: number }> {
    const counts = { kept: 0, deleted: 0, failed: 0 };
    if (!this.store) return counts;
    if (!SCOPE.test(scope)) throw new Error('DB 구분값이 올바르지 않습니다');
    const { client, config } = this.store;
    const cutoff = pendingStamp(now.getTime() - REPORT_PENDING_GRACE_MS);
    const query = `"${REPORT_SCOPE_TAG}" = '${scope}' AND "${REPORT_PENDING_TAG}" < '${cutoff}'`;
    const conditions = { tagConditions: query };
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
          await blob.setTags({}, { conditions });
          counts.kept += 1;
        } else {
          // 색인이 늦어 이미 지워진 것이 다시 잡히면 세지 않음
          const { succeeded } = await blob.deleteIfExists({ conditions });
          if (succeeded) counts.deleted += 1;
        }
      } catch (error) {
        // 412: 찾은 뒤 태그가 바뀜(이미 처리됨) → 건너뜀
        if (statusOf(error) !== 412) counts.failed += 1;
      }
    }
    return counts;
  }

  /**
   * 올린 파일 하나를 읽기만 할 수 있는 SAS 주소로 만든다.
   * 설정한 컨테이너 안의 파일 주소가 아니면 거절한다. verify를 주면 주소가 prefix 아래의
   * `<uuid>.<확장자>` 꼴인지 보고, 실제로 있는 파일인지 확인해 크기(sizeBytes)도 돌려준다(노트 등록).
   * 없으면 저장된 주소를 서명만 한다(응답에 이미지를 담을 때). 오류 메시지 · 로그에는 주소와 SAS를 넣지 않는다
   */
  async createReadAccess(
    blobUrl: string,
    ttlMs: number,
    verify?: { prefix: string },
  ): Promise<{ readUrl: string; sizeBytes?: number; contentType?: string | null }> {
    const store = this.requireStore();
    const containerClient = store.client.getContainerClient(store.config.container);
    const base = `${containerClient.url}/`;
    const blobName = blobUrl.startsWith(base) ? blobUrl.slice(base.length) : '';
    const blob = blobName ? containerClient.getBlockBlobClient(blobName) : null;
    if (!blob || blob.url !== blobUrl) throw badFile('사용할 수 없는 파일 주소예요');
    let sizeBytes: number | undefined;
    let contentType: string | null | undefined;
    if (verify) {
      const rest = blobName.startsWith(verify.prefix) ? blobName.slice(verify.prefix.length) : '';
      if (!UPLOADED_FILE_NAME.test(rest)) throw badFile('사용할 수 없는 파일 주소예요');
      try {
        const properties = await blob.getProperties();
        sizeBytes = properties.contentLength;
        contentType = properties.contentType ?? null;
      } catch (error) {
        if (statusOf(error) === 404) throw badFile('올린 파일을 찾을 수 없어요');
        throw unavailable('올린 파일을 확인하지 못했어요.');
      }
      if (!sizeBytes) throw badFile('빈 파일은 올릴 수 없어요');
    }
    const now = Date.now();
    try {
      const sas = generateBlobSASQueryParameters(
        {
          containerName: store.config.container,
          blobName,
          permissions: BlobSASPermissions.parse('r'),
          protocol: store.https ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
          startsOn: new Date(now - CLOCK_SKEW_MS),
          expiresOn: new Date(now + ttlMs),
        },
        store.credential,
      ).toString();
      return {
        readUrl: `${blob.url}?${sas}`,
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
        ...(contentType === undefined ? {} : { contentType }),
      };
    } catch {
      throw unavailable('파일 읽기 주소를 만들지 못했어요.');
    }
  }

  /**
   * 앱이 올린 파일 여러 개가 쓸 수 있는지 본다(필기 사진 검사). SAS는 만들지 않는다.
   * 주소마다 크기 · 저장된 형식(contentType)을 돌려준다. 설정한 컨테이너의 prefix 아래 `<uuid>.<확장자>` 꼴이
   * 아니거나 파일이 없으면 null. 저장소 설정이 없거나 확인하지 못하면 503. 오류 메시지 · 로그에는 주소를 넣지 않는다
   */
  async inspectUploads(
    blobUrls: string[],
    prefix: string,
  ): Promise<({ sizeBytes: number; contentType: string | null } | null)[]> {
    const store = this.requireStore();
    const containerClient = store.client.getContainerClient(store.config.container);
    const base = `${containerClient.url}/${prefix}`;
    return Promise.all(
      blobUrls.map(async (blobUrl) => {
        const name = blobUrl.startsWith(base) ? blobUrl.slice(base.length) : '';
        if (!UPLOADED_FILE_NAME.test(name)) return null;
        const blob = containerClient.getBlockBlobClient(`${prefix}${name}`);
        if (blob.url !== blobUrl) return null;
        try {
          const properties = await blob.getProperties();
          return {
            sizeBytes: properties.contentLength ?? 0,
            contentType: properties.contentType ?? null,
          };
        } catch (error) {
          if (statusOf(error) === 404) return null;
          throw unavailable('올린 파일을 확인하지 못했어요.');
        }
      }),
    );
  }

  /**
   * 앱이 올린 파일 하나를 지운다(노트 등록이 거절한 파일 정리). 설정한 컨테이너의 prefix 아래
   * `<uuid>.<확장자>` 꼴이 아니면 저장소를 부르지 않는다. 이미 없으면 그대로 끝난다.
   */
  async deleteUpload(blobUrl: string, prefix: string): Promise<void> {
    const store = this.requireStore();
    const containerClient = store.client.getContainerClient(store.config.container);
    const base = `${containerClient.url}/${prefix}`;
    const name = blobUrl.startsWith(base) ? blobUrl.slice(base.length) : '';
    if (!UPLOADED_FILE_NAME.test(name)) return;
    const blob = containerClient.getBlockBlobClient(`${prefix}${name}`);
    if (blob.url !== blobUrl) return;
    await blob.deleteIfExists();
  }

  /**
   * 이 컨테이너 안의 파일 하나를 prefix 아래 새 `<uuid>.<확장자>` 로 서버 간 복사한다(친구 노트 「내 노트로 복사」, #554).
   * 앱을 거치지 않고 Azure 가 복사한다(녹음 500MB 까지라 동기 복사 한도 256MB 를 넘을 수 있어 비동기 복사를 끝까지 기다린다).
   * 컨테이너 밖 주소면 400, 원본이 없으면 400, 그 밖의 실패는 503. 새 주소(SAS 없음)를 돌려준다
   */
  async copyUpload(sourceUrl: string, prefix: string): Promise<string> {
    const store = this.requireStore();
    const container = store.client.getContainerClient(store.config.container);
    const base = `${container.url}/`;
    const name = sourceUrl.startsWith(base) ? sourceUrl.slice(base.length) : '';
    const source = name ? container.getBlockBlobClient(name) : null;
    if (!source || source.url !== sourceUrl) throw badFile('사용할 수 없는 파일 주소예요');
    const dot = name.lastIndexOf('.');
    const ext = dot > name.lastIndexOf('/') ? name.slice(dot + 1).toLowerCase() : '';
    const target = container.getBlockBlobClient(
      `${prefix}${randomUUID()}${/^[a-z0-9]{2,5}$/.test(ext) ? `.${ext}` : ''}`,
    );
    try {
      const read = generateBlobSASQueryParameters(
        {
          containerName: store.config.container,
          blobName: source.name,
          permissions: BlobSASPermissions.parse('r'),
          expiresOn: new Date(Date.now() + COPY_READ_MINUTES * 60_000),
        },
        store.credential,
      ).toString();
      const poller = await target.beginCopyFromURL(`${source.url}?${read}`, {
        intervalInMs: 1000,
      });
      await poller.pollUntilDone();
      return target.url;
    } catch (error) {
      if (statusOf(error) === 404) throw badFile('원본 파일을 찾을 수 없어요');
      throw unavailable('파일을 복사하지 못했어요.');
    }
  }

  /** copyUpload 로 만든 사본을 지운다(복사 도중 실패했을 때 정리). 실패해도 던지지 않는다 */
  async deleteCopy(blobUrl: string): Promise<void> {
    try {
      await this.blobOf(blobUrl).deleteIfExists();
    } catch {
      // 남은 사본은 정리 대상일 뿐이다
    }
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
    const source = container.getBlockBlobClient(`${REPORT_UPLOAD_PREFIX}/${owner}/${fileName}`);
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

  /** AI 사진 검사에 전달할 사용자 소유 이미지의 짧은 읽기 전용 SAS 주소를 만든다. */
  async createImageCheckReadUrl(userId: string, rawUrl: string): Promise<string> {
    const store = this.requireStore();
    const container = store.config.container;
    const containerClient = store.client.getContainerClient(container);
    const folder = uploadFolder('image', userId);
    const prefix = `${containerClient.url}/${folder}`;
    if (!rawUrl.startsWith(prefix)) this.invalidImage();

    const fileName = rawUrl.slice(prefix.length);
    if (!REPORT_FILE.test(fileName)) this.invalidImage();

    const blob = containerClient.getBlockBlobClient(`${folder}${fileName}`);
    if (blob.url !== rawUrl) this.invalidImage();
    let properties;
    try {
      properties = await blob.getProperties();
    } catch (error) {
      if (statusOf(error) === 404) this.invalidImage();
      throw unavailable('사진 업로드를 확인하지 못했어요.');
    }

    const contentType = TYPE_BY_EXT[fileName.slice(fileName.lastIndexOf('.') + 1)];
    if (
      !properties.contentLength ||
      properties.contentLength > UPLOAD_RULES.image.maxBytes ||
      properties.contentType !== contentType
    )
      this.invalidImage();

    const now = Date.now();
    try {
      const sas = generateBlobSASQueryParameters(
        {
          containerName: container,
          blobName: blob.name,
          permissions: BlobSASPermissions.parse('r'),
          protocol: store.https ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
          startsOn: new Date(now - CLOCK_SKEW_MS),
          expiresOn: new Date(now + IMAGE_CHECK_SAS_LIFETIME_MS),
        },
        store.credential,
      ).toString();
      return `${blob.url}?${sas}`;
    } catch {
      throw unavailable('사진 읽기 주소를 만들지 못했어요.');
    }
  }

  private invalidImage(): never {
    throw new BadRequestException({
      code: 'BAD_REQUEST',
      message: '검사할 사진을 확인할 수 없습니다.',
    });
  }
}

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'statusCode' in error
    ? (error as { statusCode?: number }).statusCode
    : undefined;
}
