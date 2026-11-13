import { randomUUID } from 'node:crypto';

import {
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ERROR_CODES, UPLOAD_RULES, UploadSasBody, type UploadTarget } from '@notelink/shared';

import type { StorageConfig } from '../../config/storage.config.js';
import { UploadQuotaService } from './upload-quota.service.js';

export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');
/** 올릴 주소가 유효한 시간 */
export const UPLOAD_SAS_MINUTES = 15;
/**
 * 올린 파일이 놓이는 임시 경로. 여기 있는 파일은 아직 확인되지 않은 것이라 그대로 쓰지 않는다.
 * 자료를 등록할 때 서버가 실제 크기를 확인하고 보관 경로로 옮기며, 남은 파일은 스토리지 수명 주기 규칙이 지운다
 */
export const UPLOAD_PREFIX = 'incoming';

/** 확장자의 표준 형식. 앱이 보낸 형식이 허용 목록에 없을 때 쓴다 */
const TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
};

const notAllowed = (message: string) =>
  new BadRequestException({ code: ERROR_CODES.FILE_NOT_ALLOWED, message });

@Injectable()
export class UploadService {
  private readonly credential: StorageSharedKeyCredential | null;

  constructor(
    @Inject(STORAGE_CONFIG) private readonly storage: StorageConfig | null,
    private readonly quota: UploadQuotaService,
  ) {
    this.credential = storage
      ? new StorageSharedKeyCredential(storage.accountName, storage.accountKey)
      : null;
  }

  /**
   * 앱이 Blob에 바로 올릴 주소. 임시 경로의 사용자 폴더 아래 새 이름으로 한 번만 올라간다.
   * sizeBytes는 앱이 알린 값이고 SAS로는 크기를 묶을 수 없다. 실제 크기는 자료를 등록할 때 Blob에서 다시 확인해야 한다
   */
  async createTarget(userId: string, raw: unknown, now: Date = new Date()): Promise<UploadTarget> {
    const body = UploadSasBody.safeParse(raw);
    if (!body.success)
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '파일 정보를 확인해 주세요',
      });
    const { kind, fileName, sizeBytes } = body.data;
    const rule = UPLOAD_RULES[kind];
    const dot = fileName.lastIndexOf('.');
    const ext = dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
    if (!(rule.exts as readonly string[]).includes(ext))
      throw notAllowed(`${rule.exts.map((e) => e.toUpperCase()).join(' · ')}만 올릴 수 있어요`);
    if (sizeBytes > rule.maxBytes)
      throw notAllowed(`${Math.round(rule.maxBytes / 1024 / 1024)}MB 이하만 올릴 수 있어요`);

    if (!this.storage || !this.credential)
      throw new ServiceUnavailableException({
        code: ERROR_CODES.UPLOAD_UNAVAILABLE,
        message: '지금은 파일을 올릴 수 없어요',
      });

    // 올릴 수 있는 요청만 횟수를 쓴다(거절한 요청은 세지 않는다)
    const reserved = await this.quota.reserve(userId, now);
    if (!reserved.ok)
      throw new HttpException(
        {
          code: ERROR_CODES.RATE_LIMITED,
          message: '파일을 너무 많이 올리고 있어요. 잠시 뒤에 다시 해 주세요',
          retryAfterSeconds: Math.ceil(reserved.retryAfterMs / 1000),
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );

    const sent = body.data.contentType.toLowerCase();
    const contentType = (rule.types as readonly string[]).includes(sent)
      ? sent
      : (TYPE_BY_EXT[ext] ?? 'application/octet-stream');

    // 원래 파일 이름은 경로에 넣지 않는다(이름 노출 · 인코딩 문제)
    const blobName = `${UPLOAD_PREFIX}/${userId}/${randomUUID()}.${ext}`;
    const expiresOn = new Date(now.getTime() + UPLOAD_SAS_MINUTES * 60_000);
    const https = this.storage.blobEndpoint.startsWith('https://');
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.storage.container,
        blobName,
        // 만들기만. 쓰기(w)를 주면 덮어쓰기 · lease(서버가 지우지 못하게 잠그기)까지 된다
        permissions: BlobSASPermissions.parse('c'),
        expiresOn,
        // 로컬 에뮬레이터(http)에서도 쓸 수 있게 주소가 https일 때만 https로 묶는다
        protocol: https ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
      },
      this.credential,
    ).toString();

    const blobUrl = `${this.storage.blobEndpoint}/${this.storage.container}/${blobName}`;
    return {
      uploadUrl: `${blobUrl}?${sas}`,
      blobUrl,
      expiresAt: expiresOn.toISOString(),
      headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': contentType },
    };
  }
}
