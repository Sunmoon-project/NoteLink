import { BadRequestException, Injectable } from '@nestjs/common';
import { ERROR_CODES, UPLOAD_RULES } from '@notelink/shared';

import { BlobStorageService } from '../blob-storage.service.js';
import type { ImageCheckFileDto } from './check-images.dto.js';

/** 앱이 쓰는 판정(apps/mobile lib/api/types.ts ImageVerdict) */
export type ImageVerdict = 'ok' | 'not_allowed' | 'not_handwriting' | 'blurry';

/** 확인만 하고 버리는 읽기 주소의 유효 시간 */
const CHECK_SAS_MS = 60 * 1000;

/**
 * 필기 사진 검사(p.102). 사진마다 내 폴더(uploads/image/<내 id>/)에 실제로 있는지, 확장자 · 크기가
 * 노트에 올릴 수 있는 사진(UPLOAD_RULES.image)인지 서버에서 다시 본다. 맞지 않으면 not_allowed.
 * 흐림(blurry) · 필기 아님(not_handwriting)은 AI가 사진을 읽어야 해 아직 판정하지 않는다(통과하면 ok,
 * 글자가 없는 사진은 노트 정리 처리기가 거른다). 저장소 설정이 없거나 확인하지 못하면 503 을 그대로 올린다.
 */
@Injectable()
export class ImageCheckService {
  constructor(private readonly blobs: BlobStorageService) {}

  async check(
    userId: string,
    files: ImageCheckFileDto[],
  ): Promise<{ name: string; verdict: ImageVerdict }[]> {
    if (new Set(files.map((f) => f.name)).size !== files.length)
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '사진 이름이 겹쳐요',
      });
    const prefix = `uploads/image/${userId.toLowerCase()}/`;
    return Promise.all(
      files.map(async (f) => ({ name: f.name, verdict: await this.verdict(f.uri, prefix) })),
    );
  }

  private async verdict(uri: string, prefix: string): Promise<ImageVerdict> {
    const rule = UPLOAD_RULES.image;
    const ext = uri.split('.').pop()?.toLowerCase() ?? '';
    if (!(rule.exts as readonly string[]).includes(ext)) return 'not_allowed';
    let sizeBytes: number | undefined;
    try {
      ({ sizeBytes } = await this.blobs.createReadAccess(uri, CHECK_SAS_MS, { prefix }));
    } catch (e) {
      // 남의 파일 · 내 사진 폴더 밖 · 없는 파일 · 빈 파일은 올릴 수 없는 사진. 저장소 장애(503)는 그대로
      if (e instanceof BadRequestException) return 'not_allowed';
      throw e;
    }
    if (!sizeBytes || sizeBytes > rule.maxBytes) return 'not_allowed';
    return 'ok';
  }
}
