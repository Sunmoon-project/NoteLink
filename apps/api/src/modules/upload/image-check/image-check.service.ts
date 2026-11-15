import { BadRequestException, Injectable } from '@nestjs/common';
import { ERROR_CODES, UPLOAD_RULES } from '@notelink/shared';

import { BlobStorageService } from '../blob-storage.service.js';
import type { ImageCheckFileDto } from './check-images.dto.js';

/** 앱이 쓰는 판정(apps/mobile lib/api/types.ts ImageVerdict) */
export type ImageVerdict = 'ok' | 'not_allowed' | 'not_handwriting' | 'blurry';

const RULE = UPLOAD_RULES.image;
/** 저장된 형식에서 매개변수(; charset 등)를 떼고 소문자로 */
const mediaType = (v: string | null): string => (v ?? '').split(';')[0]!.trim().toLowerCase();

/**
 * 필기 사진 검사(p.102). 사진마다 내 폴더(uploads/image/<내 id>/)에 실제로 있는지, 확장자 · 저장된 형식 ·
 * 크기가 노트에 올릴 수 있는 사진(UPLOAD_RULES.image)인지 서버에서 다시 본다. 맞지 않으면 not_allowed.
 * 업로드 주소는 만들기 권한만 있어 앱이 보낸 Content-Type 이 그대로 저장되므로 형식도 본다(신고 사진과 같음).
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
    // 앱은 이름으로 결과를 맞추고, 노트 등록은 같은 파일을 두 번 받지 않는다
    if (
      new Set(files.map((f) => f.name)).size !== files.length ||
      new Set(files.map((f) => f.uri)).size !== files.length
    )
      throw new BadRequestException({
        code: ERROR_CODES.VALIDATION,
        message: '같은 사진을 두 번 넣을 수 없어요',
      });
    // 확장자가 사진이 아닌 주소는 저장소에 묻지 않는다
    const asked = files.filter((f) =>
      (RULE.exts as readonly string[]).includes(f.uri.split('.').pop()?.toLowerCase() ?? ''),
    );
    const found = await this.blobs.inspectUploads(
      asked.map((f) => f.uri),
      `uploads/image/${userId.toLowerCase()}/`,
    );
    const byUri = new Map(asked.map((f, i) => [f.uri, found[i] ?? null]));
    return files.map((f) => {
      const blob = byUri.get(f.uri);
      const ok =
        !!blob &&
        blob.sizeBytes > 0 &&
        blob.sizeBytes <= RULE.maxBytes &&
        (RULE.types as readonly string[]).includes(mediaType(blob.contentType));
      return { name: f.name, verdict: ok ? 'ok' : 'not_allowed' };
    });
  }
}
