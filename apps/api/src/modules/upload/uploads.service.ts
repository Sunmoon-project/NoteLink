import { randomUUID } from 'node:crypto';

import {
  BlobSASPermissions,
  generateBlobSASQueryParameters,
  SASProtocol,
} from '@azure/storage-blob';
import { BadRequestException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ERROR_CODES, UPLOAD_RULES, UploadSasBody, type UploadTarget } from '@notelink/shared';

import { BlobStorageService, TYPE_BY_EXT, UPLOAD_PREFIX } from './blob-storage.service.js';
import { UploadQuotaService } from './upload-quota.service.js';

/** 올릴 주소가 유효한 시간 */
export const UPLOAD_SAS_MINUTES = 15;

const notAllowed = (message: string) =>
  new BadRequestException({ code: ERROR_CODES.FILE_NOT_ALLOWED, message });

@Injectable()
export class UploadsService {
  constructor(
    private readonly storage: BlobStorageService,
    private readonly quota: UploadQuotaService,
  ) {}

  /**
   * 앱이 Blob에 바로 올릴 주소. 임시 경로의 사용자 폴더 아래 새 이름으로 한 번만 올라간다.
   * sizeBytes는 앱이 알린 값이고 SAS로는 크기를 묶을 수 없다. 쓰는 곳(자료 등록 · 신고)이 실제 크기를 확인하고 보관 경로로 옮긴다
   */
  async createTarget(userId: string, raw: unknown, now: Date = new Date()): Promise<UploadTarget> {
    const body = UploadSasBody.safeParse(raw);
    if (!body.success)
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '파일 정보를 확인해 주세요',
      });
    const { kind, fileName, sizeBytes, purpose } = body.data;
    if (purpose === 'report' && kind !== 'image')
      throw notAllowed('신고에는 사진만 붙일 수 있어요');
    const rule = UPLOAD_RULES[kind];
    const dot = fileName.lastIndexOf('.');
    const ext = dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
    if (!(rule.exts as readonly string[]).includes(ext))
      throw notAllowed(`${rule.exts.map((e) => e.toUpperCase()).join(' · ')}만 올릴 수 있어요`);
    if (sizeBytes > rule.maxBytes)
      throw notAllowed(`${Math.round(rule.maxBytes / 1024 / 1024)}MB 이하만 올릴 수 있어요`);

    const sent = body.data.contentType.toLowerCase();
    // 신고 사진은 접수할 때 확장자의 형식과 같은지 보므로, 다르면 지금 알린다
    if (purpose === 'report' && sent !== TYPE_BY_EXT[ext])
      throw notAllowed('사진 형식과 확장자가 맞지 않아요');

    const store = this.storage.requireStore();

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

    const contentType = (rule.types as readonly string[]).includes(sent)
      ? sent
      : (TYPE_BY_EXT[ext] ?? 'application/octet-stream');

    // 원래 파일 이름은 경로에 넣지 않는다(이름 노출 · 인코딩 문제)
    const blobName = `${UPLOAD_PREFIX}/${userId}/${randomUUID()}.${ext}`;
    const expiresOn = new Date(now.getTime() + UPLOAD_SAS_MINUTES * 60_000);
    const sas = generateBlobSASQueryParameters(
      {
        containerName: store.config.container,
        blobName,
        // 만들기만. 쓰기(w)를 주면 덮어쓰기 · lease(서버가 지우지 못하게 잠그기)까지 된다
        permissions: BlobSASPermissions.parse('c'),
        expiresOn,
        // 로컬 에뮬레이터(http)에서도 쓸 수 있게 주소가 https일 때만 https로 묶는다
        protocol: store.https ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
      },
      store.credential,
    ).toString();

    const blobUrl = this.storage.urlOf(blobName);
    return {
      uploadUrl: `${blobUrl}?${sas}`,
      blobUrl,
      expiresAt: expiresOn.toISOString(),
      headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': contentType },
    };
  }
}
