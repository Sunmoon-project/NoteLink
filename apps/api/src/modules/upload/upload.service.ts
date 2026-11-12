import { randomUUID } from 'node:crypto';

import {
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import {
  BadRequestException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ERROR_CODES, UPLOAD_RULES, UploadSasBody, type UploadTarget } from '@notelink/shared';

import type { StorageConfig } from '../../config/storage.config.js';

export const STORAGE_CONFIG = Symbol('STORAGE_CONFIG');
/** 올릴 주소가 유효한 시간 */
export const UPLOAD_SAS_MINUTES = 15;

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

  constructor(@Inject(STORAGE_CONFIG) private readonly storage: StorageConfig | null) {
    this.credential = storage
      ? new StorageSharedKeyCredential(storage.accountName, storage.accountKey)
      : null;
  }

  /**
   * 앱이 Blob에 바로 올릴 주소. 쓰기만 되고, 사용자 폴더 아래 새 이름으로만 올라간다.
   * sizeBytes는 앱이 알린 값이고 SAS로는 크기를 묶을 수 없다. 실제 크기는 자료를 등록할 때 Blob에서 다시 확인해야 한다
   */
  createTarget(userId: string, raw: unknown, now: Date = new Date()): UploadTarget {
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

    const sent = body.data.contentType.toLowerCase();
    const contentType = (rule.types as readonly string[]).includes(sent)
      ? sent
      : (TYPE_BY_EXT[ext] ?? 'application/octet-stream');

    // 원래 파일 이름은 경로에 넣지 않는다(이름 노출 · 인코딩 문제)
    const blobName = `${userId}/${randomUUID()}.${ext}`;
    const expiresOn = new Date(now.getTime() + UPLOAD_SAS_MINUTES * 60_000);
    const https = this.storage.blobEndpoint.startsWith('https://');
    const sas = generateBlobSASQueryParameters(
      {
        containerName: this.storage.container,
        blobName,
        permissions: BlobSASPermissions.parse('cw'),
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
