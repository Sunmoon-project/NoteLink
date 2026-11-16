import { ConfigService } from '@nestjs/config';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { UPLOAD_RULES } from '@notelink/shared';

import { BlobStorageService } from '../../upload/blob-storage.service.js';
import { CheckImagesBody } from './check-images.dto.js';

const ImageVerdict = z.enum(['ok', 'not_allowed', 'not_handwriting', 'blurry']);
const InternalResult = z.object({
  data: z.array(z.object({ name: z.string(), verdict: ImageVerdict })),
});

export type CheckedImage = z.infer<typeof InternalResult>['data'][number];

@Injectable()
export class ImagesService {
  constructor(
    private readonly config: ConfigService,
    private readonly blobs: BlobStorageService,
  ) {}

  async check(userId: string, raw: unknown): Promise<CheckedImage[]> {
    const parsed = CheckImagesBody.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException({
        code: 'VALIDATION',
        message: '사진 목록을 확인해 주세요.',
      });

    if (parsed.data.files.some((file) => file.sizeBytes > UPLOAD_RULES.image.maxBytes))
      throw new BadRequestException({
        code: 'BAD_REQUEST',
        message: '사진 크기가 너무 큽니다.',
      });

    const files = await Promise.all(
      parsed.data.files.map(async ({ name, uri }) => ({
        name,
        uri: await this.blobs.createImageCheckReadUrl(userId, uri),
      })),
    );
    const baseUrl = this.config.get<string>('AI_INTERNAL_URL')?.trim().replace(/\/$/, '');
    const token = this.config.get<string>('AI_INTERNAL_TOKEN')?.trim();
    if (!baseUrl || !token)
      throw new ServiceUnavailableException({
        code: 'AI_UNAVAILABLE',
        message: '사진 검사 서비스를 준비하지 못했어요.',
      });

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/internal/v1/images/check`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ files }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'AI_UNAVAILABLE',
        message: '사진 검사 서비스를 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
      });
    }
    if (!response.ok)
      throw new ServiceUnavailableException({
        code: 'AI_UNAVAILABLE',
        message: '사진 검사 서비스를 사용할 수 없어요. 잠시 후 다시 시도해 주세요.',
      });

    const result = InternalResult.safeParse(await response.json().catch(() => null));
    if (
      !result.success ||
      !this.matchesRequest(
        parsed.data.files.map((file) => file.name),
        result.data.data,
      )
    )
      throw new ServiceUnavailableException({
        code: 'AI_UNAVAILABLE',
        message: '사진 검사 결과를 확인하지 못했어요. 다시 시도해 주세요.',
      });
    return result.data.data;
  }

  private matchesRequest(names: string[], results: CheckedImage[]): boolean {
    return (
      results.length === names.length &&
      names.every((name) => results.filter((result) => result.name === name).length === 1)
    );
  }
}
